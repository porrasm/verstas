/**
 * The worker driver. Runs INSIDE the session container:
 *
 *   node /opt/verstas/worker.js --job /workspace/.verstas/job.json
 *
 * Reads the job (role, ticket id, prompt file, system prompt file, caps,
 * driver), spawns the chosen agent (Claude Code by default; Codex or Cursor
 * when the job says so) with the board MCP server attached, translates its
 * stream into Verstas events on stdout (one JSON per line), enforces the
 * turn and time caps itself, and ends with a `worker_done` line.
 *
 * This is the reference implementation of the driver contract (docs/
 * DRIVERS.md): any command that reads the same job file and writes the
 * same event lines can replace it. The agent-specific parts live in
 * driver-*.ts; this file is the loop they share.
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { findBinary, type DriverImpl, type Job } from "./driver.js";
import { claudeArgs, claudeDriver } from "./driver-claude.js";
import { codexDriver } from "./driver-codex.js";
import { cursorDriver } from "./driver-cursor.js";
import type { Translated } from "./translate.js";
import type { VerstasEvent } from "../core/types.js";

export type { Job } from "./driver.js";
export { claudeArgs };

export const DRIVER_IMPLS: Record<NonNullable<Job["driver"]>, DriverImpl> = { claude: claudeDriver, codex: codexDriver, cursor: cursorDriver };

const emit = (e: VerstasEvent | Record<string, unknown>) => process.stdout.write(JSON.stringify(e) + "\n");

const doneLine = (job: Job, t0: number, fields: Partial<Extract<VerstasEvent, { kind: "worker_done" }>>) =>
  emit({
    kind: "worker_done",
    t: new Date().toISOString(),
    ticket: job.ticket,
    role: job.role,
    ok: false,
    stopReason: "error",
    rateLimited: false,
    costUsd: 0,
    turns: 0,
    seconds: Math.round((Date.now() - t0) / 1000),
    text: "",
    stderr: "",
    ...fields,
  });

export const runJob = async (job: Job): Promise<number> => {
  const t0 = Date.now();
  const driver = DRIVER_IMPLS[job.driver ?? "claude"];
  if (!driver) {
    doneLine(job, t0, { stopReason: "driver_unknown", text: `Unknown driver "${String(job.driver)}"` });
    return 1;
  }
  const bin = job.binary ?? job.claudeBinary ?? (await findBinary(driver.binaries));
  if (!bin) {
    const text = `The ${driver.name} CLI (${driver.binaries.join(" or ")}) is not installed in this image. Rebuild the image with it, or choose another agent for this session.`;
    emit({ kind: "error", t: new Date().toISOString(), ticket: job.ticket, text });
    doneLine(job, t0, { stopReason: "driver_missing", text });
    return 1;
  }

  const prompt = await fs.readFile(job.promptFile, "utf8");
  const system = await fs.readFile(job.systemPromptFile, "utf8");
  const spawned = await driver.prepare(job, prompt, system, bin);
  const translator = driver.translator(job);
  let turns = 0;
  let stopReason = "";
  let result: Translated["result"];

  // The running totals the agent reads through the board server's `budget`
  // tool. Context is the last turn's input tokens: what the model was sent.
  const budget = { turns: 0, seconds: 0, contextTokens: 0, outputTokens: 0, caps: job.caps, resumed: Boolean(job.agentSession?.resume) };
  const writeBudget = () => {
    if (!job.budgetFile) return;
    budget.seconds = Math.round((Date.now() - t0) / 1000);
    void fs.writeFile(job.budgetFile, JSON.stringify(budget)).catch(() => undefined);
  };
  writeBudget();
  const env = job.budgetFile ? { ...spawned.env, VERSTAS_BUDGET_FILE: job.budgetFile } : spawned.env;

  const child = spawn(spawned.bin, spawned.args, { cwd: spawned.cwd, stdio: ["pipe", "pipe", "pipe"], env });
  child.stdin.end(spawned.stdin ?? "");

  const stop = () => {
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
  };
  // The harness stops a worker with SIGTERM. Pass it on, or the agent keeps
  // running (reparented to the container's init) after its driver is gone.
  const onTerm = () => {
    if (!stopReason) stopReason = "aborted";
    stop();
  };
  process.once("SIGTERM", onTerm);
  process.once("SIGINT", onTerm);

  const timer = setTimeout(() => {
    stopReason = "time_cap";
    emit({ kind: "status", t: new Date().toISOString(), ticket: job.ticket, text: `time cap of ${job.caps.minutes} min reached; stopping` });
    stop();
  }, job.caps.minutes * 60_000);

  let stderr = "";
  let spawnError = "";
  child.on("error", (e) => (spawnError = e.message));
  child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d.slice(0, 4000)));

  // A grandchild (a server the agent started in the background) can inherit
  // the agent's stdout and hold the pipe open after the agent itself has
  // exited; stop reading shortly after the exit instead of waiting for the pipe.
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const exited = new Promise<number>((resolve) => {
    child.on("exit", (c) => {
      setTimeout(() => {
        rl.close();
        child.stdout.destroy();
      }, 2_000).unref();
      resolve(c ?? 1);
    });
    child.on("error", () => resolve(127));
  });
  for await (const line of rl) {
    if (job.debug) emit({ kind: "raw", t: new Date().toISOString(), line });
    const out = translator.line(line);
    for (const e of out.events) {
      emit(e);
      if (e.kind === "cost") {
        budget.contextTokens = e.cost.inputTokens;
        budget.outputTokens += e.cost.outputTokens;
      }
    }
    if (out.result) result = out.result;
    if (out.assistantTurn) {
      turns++;
      budget.turns = turns;
      writeBudget();
      if (turns > job.caps.turns && !stopReason) {
        stopReason = "turn_cap";
        emit({ kind: "status", t: new Date().toISOString(), ticket: job.ticket, text: `turn cap of ${job.caps.turns} reached; stopping` });
        stop();
      }
    }
  }
  const code = await exited;
  clearTimeout(timer);
  if (!result) result = translator.end();

  const after = await driver.finish?.(job).catch(() => undefined);
  // A rotated login goes back to the host on its own line; the harness stores it and never logs it.
  if (after?.credential) emit({ kind: "credential", driver: driver.name, value: after.credential });

  if (spawnError) stderr = `${spawnError}\n${stderr}`;
  const ok = !stopReason && code === 0 && (result?.ok ?? false);
  doneLine(job, t0, {
    ok,
    stopReason: stopReason || result?.stopReason || `exit_${code}`,
    rateLimited: result?.rateLimited ?? (!ok && driver.stderrRateLimit.test(stderr)),
    costUsd: result?.costUsd ?? 0,
    turns,
    text: (result?.text ?? "").slice(0, 4000),
    stderr: stderr.slice(0, 2000),
  });
  return ok ? 0 : 1;
};

const main = async () => {
  const i = process.argv.indexOf("--job");
  const file = i >= 0 ? process.argv[i + 1] : undefined;
  if (!file) {
    process.stderr.write("usage: worker --job <job.json>\n");
    process.exit(2);
  }
  const job = JSON.parse(await fs.readFile(path.resolve(file), "utf8")) as Job;
  process.exit(await runJob(job));
};

if (process.argv[1] && /worker\.(?:[cm]?js|ts)$/.test(process.argv[1])) void main();

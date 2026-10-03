/**
 * The Claude worker driver. Runs INSIDE the session container:
 *
 *   node /opt/verstas/worker.js --job /workspace/.verstas/job.json
 *
 * Reads the job (role, ticket id, prompt file, system prompt file, caps),
 * runs `claude -p` with the board MCP server attached, translates the
 * stream into Verstas events on stdout (one JSON per line), enforces the
 * turn and time caps itself, and ends with a `worker_done` line.
 *
 * This is the reference implementation of the driver contract (docs/
 * DRIVERS.md): any command that reads the same job file and writes the
 * same event lines can replace it.
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { translateLine } from "./translate.js";
import type { VerstasEvent } from "../core/types.js";

export type Job = {
  role: "implementer" | "reviewer" | "planner";
  ticket?: string;
  /** Path of the user prompt (the ticket, the context). */
  promptFile: string;
  /** Path of the procedure text appended to the system prompt. */
  systemPromptFile: string;
  caps: { minutes: number; turns: number; budgetUsd: number };
  /** The mcp config file the harness wrote; it names this image's board server. */
  mcpConfigFile: string;
  model?: string;
  claudeBinary?: string;
  /** Defaults to /workspace; tests on the host point it elsewhere. */
  cwd?: string;
};

const emit = (e: VerstasEvent | Record<string, unknown>) => process.stdout.write(JSON.stringify(e) + "\n");

export const claudeArgs = (job: Job): string[] => [
  "-p",
  "--output-format",
  "stream-json",
  "--verbose",
  "--permission-mode",
  "bypassPermissions",
  "--mcp-config",
  job.mcpConfigFile,
  "--strict-mcp-config",
  "--max-budget-usd",
  String(job.caps.budgetUsd),
  "--no-session-persistence",
  "--append-system-prompt",
  "@SYSTEM@", // replaced with the file's text at spawn time
  ...(job.model ? ["--model", job.model] : []),
];

export const runJob = async (job: Job): Promise<number> => {
  const prompt = await fs.readFile(job.promptFile, "utf8");
  const system = await fs.readFile(job.systemPromptFile, "utf8");
  const args = claudeArgs(job).map((a) => (a === "@SYSTEM@" ? system : a));
  const t0 = Date.now();
  let turns = 0;
  let stopReason = "";
  let result: ReturnType<typeof translateLine>["result"];

  const child = spawn(job.claudeBinary ?? "claude", args, {
    cwd: job.cwd ?? "/workspace",
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
  });
  child.stdin.end(prompt);

  const timer = setTimeout(() => {
    stopReason = "time_cap";
    emit({ kind: "status", t: new Date().toISOString(), ticket: job.ticket, text: `time cap of ${job.caps.minutes} min reached; stopping` });
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
  }, job.caps.minutes * 60_000);

  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d.slice(0, 4000)));

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  for await (const line of rl) {
    const out = translateLine(line, { ticket: job.ticket, role: job.role });
    for (const e of out.events) emit(e);
    if (out.result) result = out.result;
    if (out.assistantTurn) {
      turns++;
      if (turns > job.caps.turns && !stopReason) {
        stopReason = "turn_cap";
        emit({ kind: "status", t: new Date().toISOString(), ticket: job.ticket, text: `turn cap of ${job.caps.turns} reached; stopping` });
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
      }
    }
  }
  const code = await new Promise<number>((resolve) => child.on("close", (c) => resolve(c ?? 1)));
  clearTimeout(timer);

  const ok = !stopReason && code === 0 && (result?.ok ?? false);
  emit({
    kind: "worker_done",
    t: new Date().toISOString(),
    ticket: job.ticket,
    role: job.role,
    ok,
    stopReason: stopReason || result?.stopReason || `exit_${code}`,
    rateLimited: result?.rateLimited ?? /rate.?limit|429/i.test(stderr),
    costUsd: result?.costUsd ?? 0,
    turns,
    seconds: Math.round((Date.now() - t0) / 1000),
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

import { createWriteStream } from "node:fs";
import path from "node:path";
import type { Session } from "../core/types.js";
import type { SessionHub } from "../sessions/hub.js";
import type { RunTokens } from "../agent-api/agent-api.js";
import { promises as fs } from "node:fs";
import { buildSpec, ensureSandboxUp, execInSandbox, healSandbox, proxyLogsSince, runInSandbox, runRootScript, runSetupScript, writeEnvFile, type SandboxConfig } from "../sandbox/lifecycle.js";
import { now, type SetupResult } from "../core/types.js";
import { readWorkerStream, RunManager, type Shell, type WorkerDone, type WorkerRunner } from "./run.js";
import type { Job } from "../worker/worker.js";

/**
 * The real implementations of the loop's two interfaces, over the session
 * container. `shell` runs gates and git as the agent user; `worker` starts
 * the in-image driver and streams its JSON lines back.
 */

export const WORKER_COMMAND = ["node", "/opt/verstas/worker.js", "--job", "/workspace/.verstas/job.json"] as const;

export const dockerShell = (cfg: SandboxConfig, sessionId: string): Shell => ({
  exec: (cmd, opts = {}) => runInSandbox(cfg, sessionId, cmd, { workdir: opts.workdir, timeoutMs: opts.timeoutMs, allowFailure: true, input: opts.input }),
});

export const dockerWorker = (cfg: SandboxConfig, sessionId: string): WorkerRunner => ({
  async run(job: Job, onEvent, signal, opts = {}): Promise<WorkerDone> {
    const child = execInSandbox(cfg, sessionId, WORKER_COMMAND, { env: opts.runToken ? { VERSTAS_RUN_TOKEN: opts.runToken } : undefined });
    child.stdin?.end();
    let stderr = "";
    const raw = opts.rawLog ? createWriteStream(opts.rawLog, { flags: "a" }) : null;
    child.stderr?.setEncoding("utf8").on("data", (d: string) => {
      stderr = (stderr + d).slice(-4000);
      if (raw) raw.write(`# stderr: ${d}`);
      if (process.env.VERSTAS_DEBUG) process.stderr.write(`[worker ${job.ticket ?? job.role} stderr] ${d}`);
    });
    if (raw) child.stdout?.on("data", (d: Buffer) => raw.write(d));
    const onAbort = () => {
      // Stop the driver; the harness's `docker exec` child dies, and the
      // driver's own SIGTERM handling stops claude. The container stays up.
      child.kill("SIGTERM");
      void runInSandbox(cfg, sessionId, ["pkill", "-TERM", "-f", "/opt/verstas/worker.js"], { allowFailure: true, timeoutMs: 10_000 });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const t0 = Date.now();
    const done = await readWorkerStream(child.stdout!, onEvent);
    const code = await new Promise<number>((resolve) => child.on("close", (c) => resolve(c ?? 1)));
    signal.removeEventListener("abort", onAbort);
    raw?.end();
    return (
      done ?? {
        kind: "worker_done",
        t: new Date().toISOString(),
        ticket: job.ticket,
        role: job.role,
        ok: false,
        stopReason: signal.aborted ? "aborted" : `exec_exit_${code}`,
        rateLimited: /rate.?limit|429/i.test(stderr),
        costUsd: 0,
        turns: 0,
        seconds: Math.round((Date.now() - t0) / 1000),
        text: "",
        stderr,
      }
    );
  },
});

export const proxyDenials =
  (cfg: SandboxConfig, sessionId: string) =>
  async (since: string): Promise<{ host: string; port: number }[]> => {
    const lines = await proxyLogsSince(cfg, sessionId, since);
    const out: { host: string; port: number }[] = [];
    for (const line of lines) {
      try {
        const j = JSON.parse(line) as { kind?: string; host?: string; port?: number; url?: string };
        if (j.kind !== "denied") continue;
        if (j.host) out.push({ host: j.host, port: j.port ?? 0 });
        else if (j.url) {
          const u = new URL(j.url);
          out.push({ host: u.hostname, port: u.port ? Number(u.port) : 80 });
        }
      } catch {
        // not a JSON line; ignore
      }
    }
    return out;
  };

export type RunManagerConfig = {
  hub: SessionHub;
  tokens: RunTokens;
  sandbox: SandboxConfig;
  agentApiUrl: string;
  claudeToken: () => Promise<string | undefined>;
};

/**
 * Brings a session's sandbox up for a run: writes the env file with the two
 * secrets (docs/SANDBOX.md Boundary 6) at a stable per-session path, so the
 * container is recreated only when image or limits change, and replays the
 * root commands the user approved earlier when a recreate does happen.
 */
export const ensureSessionSandbox = async (c: RunManagerConfig, session: Session, envFile: string, runToken: string | undefined): Promise<void> => {
  const env: Record<string, string> = { VERSTAS_SESSION: session.id };
  if (runToken) {
    const claude = await c.claudeToken();
    if (!claude) throw new Error("No Claude token configured. Run `claude setup-token` and paste it in Settings.");
    env.CLAUDE_CODE_OAUTH_TOKEN = claude;
    env.VERSTAS_RUN_TOKEN = runToken;
  }
  await writeEnvFile(envFile, env);
  const h = await c.hub.get(session.id);
  const { recreated } = await ensureSandboxUp(c.sandbox, buildSpec(c.sandbox, session, h.paths, envFile));
  // Setup scripts run on a fresh container, and also when a previous setup never completed.
  const setupPending = session.setupScripts.length > 0 && (recreated || session.setup.length === 0 || session.setup.some((r) => !r.ok));
  if (setupPending) await runSetup(c, session.id);
  if (recreated) {
    for (const rc of session.rootScripts) {
      const r = await runRootScript(c.sandbox, session.id, rc.script, rc.cwd);
      if (!r.ok) console.warn(`[sandbox ${session.id}] replaying approved root script failed (${r.code}): ${rc.script.slice(0, 120)}`);
    }
  }
};

/**
 * Runs the session's setup scripts in order as root, logging each to
 * <session>/setup/<name>.log and recording the results on the session.
 * Stops at the first failure and throws, so a run never starts on a
 * half-set-up box; the UI shows the log.
 */
export const runSetup = async (c: RunManagerConfig, sessionId: string): Promise<SetupResult[]> => {
  const h = await c.hub.get(sessionId);
  const results: SetupResult[] = [];
  await h.mutate((d) => ({ next: { session: { ...d.session, setup: [] } } }));
  for (const sc of h.session.setupScripts) {
    const t0 = Date.now();
    const r = await runSetupScript(c.sandbox, sessionId, sc.script);
    const logFile = `${h.paths.setup}/${sc.name}.log`;
    await fs.writeFile(logFile, `# ${sc.name} · ${now()} · exit ${r.code} · ${Math.round((Date.now() - t0) / 1000)}s
${r.output}`);
    const result: SetupResult = { name: sc.name, ok: r.ok, code: r.code, at: now(), tail: r.output.trim().split("\n").slice(-25).join("\n").slice(-4000) };
    results.push(result);
    await h.mutate((d) => ({ next: { session: { ...d.session, setup: [...results] } } }));
    if (!r.ok) throw new Error(`Setup script "${sc.name}" failed with exit ${r.code}; see setup/${sc.name}.log in the session directory. Fix the script in the library or re-run setup from the session page.`);
  }
  return results;
};

export const createDockerRunManager = (c: RunManagerConfig): RunManager =>
  new RunManager({
    hub: c.hub,
    tokens: c.tokens,
    agentApiUrl: c.agentApiUrl,
    shell: (sessionId) => dockerShell(c.sandbox, sessionId),
    worker: (sessionId) => dockerWorker(c.sandbox, sessionId),
    proxyDenials: (sessionId, since) => proxyDenials(c.sandbox, sessionId)(since),
    ensureSandbox: (session, envFile, token) => ensureSessionSandbox(c, session, envFile, token),
    healSandbox: (sessionId) => healSandbox(c.sandbox, sessionId),
  });

export const proxyDistPath = (distRoot: string): string => path.join(distRoot, "src", "proxy");
export const workerDistPath = (distRoot: string): string => path.join(distRoot, "src", "worker");

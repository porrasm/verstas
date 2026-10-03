import { createWriteStream } from "node:fs";
import path from "node:path";
import type { Session } from "../core/types.js";
import type { SessionHub } from "../sessions/hub.js";
import type { RunTokens } from "../agent-api/agent-api.js";
import { buildSpec, ensureSandboxUp, execInSandbox, healSandbox, installInSandbox, proxyLogsSince, runInSandbox, writeEnvFile, type SandboxConfig } from "../sandbox/lifecycle.js";
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
    const child = execInSandbox(cfg, sessionId, WORKER_COMMAND);
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
 * secrets (docs/SANDBOX.md Boundary 6), recreates the container so image
 * and limits are current, and re-applies installs approved earlier.
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
  await ensureSandboxUp(c.sandbox, buildSpec(c.sandbox, session, h.paths, envFile), { recreate: true });
  for (const inst of session.installs) {
    await installInSandbox(c.sandbox, session.id, inst.manager, inst.packages);
  }
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

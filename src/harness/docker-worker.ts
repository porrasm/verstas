import { createWriteStream } from "node:fs";
import path from "node:path";
import type { DriverName, Session } from "../core/types.js";
import type { SessionHub } from "../sessions/hub.js";
import type { RunTokens } from "../agent-api/agent-api.js";
import { promises as fs } from "node:fs";
import { buildSpec, ensureSandboxUp, execInSandbox, healSandbox, proxyLogsSince, runInSandbox, runRootScript, runSetupScript, snapshotSandbox, usableSnapshot, writeEnvFile, type SandboxConfig } from "../sandbox/lifecycle.js";
import { now, type SetupResult } from "../core/types.js";
import { secretValues, type Secrets } from "../config.js";
import { writeAllowlist } from "../sessions/sessions.js";
import { readWorkerStream, RunManager, type Shell, type WorkerDone, type WorkerRunner } from "./run.js";
import { CODEX_SERIALIZE_AFTER_DAYS, codexAuthAgeDays, credentialFor, driverInfo, missingCredentialError, missingCredentials } from "./drivers.js";
import type { Job } from "../worker/worker.js";

/**
 * The real implementations of the loop's two interfaces, over the session
 * container. `shell` runs gates and git as the agent user; `worker` starts
 * the in-image driver and streams its JSON lines back.
 */

export const DEFAULT_JOB_FILE = "/workspace/.verstas/job.json";
export const workerCommand = (jobFile: string = DEFAULT_JOB_FILE): string[] => ["node", "/opt/verstas/worker.js", "--job", jobFile];
/** What pkill matches to stop every worker; the driver forwards the signal to the agent it runs. */
export const WORKER_PATTERN = "/opt/verstas/worker.js";
/** What pkill matches to stop one worker: its job file is unique to it. */
export const workerPattern = (jobFile: string): string => `${WORKER_PATTERN} --job ${jobFile}`;

export const dockerShell = (cfg: SandboxConfig, sessionId: string): Shell => ({
  exec: (cmd, opts = {}) => runInSandbox(cfg, sessionId, cmd, { workdir: opts.workdir, timeoutMs: opts.timeoutMs, allowFailure: true, input: opts.input }),
});

/** Where the host keeps credentials and takes back the ones an agent rotated. */
export type CredentialStore = {
  secrets: () => Promise<Secrets>;
  /** Store a credential a driver handed back (Codex's refreshed auth file). */
  save: (driver: DriverName, value: string) => Promise<void>;
};

/**
 * Once Codex's login is old enough to be refreshed, Codex workers run one
 * at a time across sessions: the refresh token is single use, and two
 * concurrent refreshes would log the account out (src/harness/drivers.ts).
 */
let codexTurn: Promise<void> = Promise.resolve();
const serializeCodex = async <T>(fn: () => Promise<T>): Promise<T> => {
  const prev = codexTurn;
  let release!: () => void;
  codexTurn = new Promise<void>((r) => (release = r));
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
};

/**
 * The agent's credential and the run token reach the worker process only:
 * passed by name on its `docker exec`, not in the container's environment,
 * so setup scripts, recipes, gates and harness git never see them. Which
 * credential depends on the job's driver.
 */
export const dockerWorker = (cfg: SandboxConfig, sessionId: string, store: CredentialStore = { secrets: async () => ({}), save: async () => undefined }): WorkerRunner => ({
  async run(job: Job, onEvent, signal, opts = {}): Promise<WorkerDone> {
    const driver = driverInfo(job.driver);
    const secrets = await store.secrets();
    const credential = credentialFor(secrets, driver.name);
    if (!credential) throw missingCredentialError(driver.name);
    const secretEnv: Record<string, string> = { [driver.env]: credential };
    if (opts.runToken) secretEnv.VERSTAS_RUN_TOKEN = opts.runToken;
    const age = driver.name === "codex" ? codexAuthAgeDays(secrets) : undefined;
    const exec = () => runWorkerExec(cfg, sessionId, job, secretEnv, onEvent, signal, opts, store);
    return age !== undefined && age >= CODEX_SERIALIZE_AFTER_DAYS ? serializeCodex(exec) : exec();
  },
});

const runWorkerExec = async (
  cfg: SandboxConfig,
  sessionId: string,
  job: Job,
  secretEnv: Record<string, string>,
  onEvent: Parameters<WorkerRunner["run"]>[1],
  signal: AbortSignal,
  opts: NonNullable<Parameters<WorkerRunner["run"]>[3]>,
  store: CredentialStore,
): Promise<WorkerDone> => {
  const jobFile = opts.jobFile ?? DEFAULT_JOB_FILE;
  const child = execInSandbox(cfg, sessionId, workerCommand(jobFile), { secretEnv });
  child.stdin?.end();
  let stderr = "";
  const raw = opts.rawLog ? createWriteStream(opts.rawLog, { flags: "a" }) : null;
  child.stderr?.setEncoding("utf8").on("data", (d: string) => {
    stderr = (stderr + d).slice(-4000);
    if (raw) raw.write(`# stderr: ${d}`);
    if (process.env.VERSTAS_DEBUG) process.stderr.write(`[worker ${job.ticket ?? job.role} stderr] ${d}`);
  });
  const onAbort = () => {
    // Stop this driver only; the harness's `docker exec` child dies, and the
    // driver's own SIGTERM handling stops the agent. Other workers of the
    // session (a lead while its reviewer is stopped) and the container stay up.
    child.kill("SIGTERM");
    void runInSandbox(cfg, sessionId, ["pkill", "-TERM", "-f", workerPattern(jobFile)], { allowFailure: true, timeoutMs: 10_000 });
  };
  signal.addEventListener("abort", onAbort, { once: true });
  const t0 = Date.now();
  const done = await readWorkerStream(child.stdout!, onEvent, {
    onRaw: raw ? (line) => raw.write(line + "\n") : undefined,
    onCredential: async (c) => {
      try {
        await store.save(c.driver, c.value);
      } catch (e) {
        console.warn(`[worker ${job.ticket ?? job.role}] could not store the refreshed ${c.driver} login: ${(e as Error).message}`);
      }
    },
  });
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
};

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
  credentials: CredentialStore;
};

/**
 * Brings a session's sandbox up for a run: writes the env file with the two
 * secrets (docs/SANDBOX.md Boundary 6) at a stable per-session path, so the
 * container is recreated only when image or limits change, and replays the
 * root commands the user approved earlier when a recreate does happen.
 */
export const ensureSessionSandbox = async (c: RunManagerConfig, session: Session, envFile: string, needsCredentials: boolean): Promise<void> => {
  // No secrets in the container's environment (see dockerWorker); fail early if a run will need a credential it does not have.
  if (needsCredentials) {
    const missing = missingCredentials(await c.credentials.secrets(), session);
    if (missing.length) throw missingCredentialError(missing[0]!);
  }
  await writeEnvFile(envFile, { VERSTAS_SESSION: session.id });
  const h = await c.hub.get(session.id);
  // Sessions created before the proxy directory existed get it here.
  await writeAllowlist(h.paths, session.allowlist);
  // sudo logs here (see the image's sudoers); it must exist before the first sudo, including a recipe replay.
  await fs.mkdir(path.join(h.paths.workspace, ".verstas", "logs"), { recursive: true });
  // A confirmed environment was committed to an image: a recreated box starts from it, already set up.
  const snapshot = await usableSnapshot(c.sandbox, session);
  const { recreated } = await ensureSandboxUp(c.sandbox, buildSpec(c.sandbox, session, h.paths, envFile, snapshot));
  const fromSnapshot = recreated && Boolean(snapshot);
  // Setup scripts run on a fresh container, and also when a previous setup never completed.
  const setupPending = !fromSnapshot && session.setupScripts.length > 0 && (recreated || session.setup.length === 0 || session.setup.some((r) => !r.ok));
  if (setupPending) await runSetup(c, session.id);
  // Services the agent registered with svc come back after a container restart; a no-op when they run.
  const up = await runInSandbox(c.sandbox, session.id, ["svc", "up"], { allowFailure: true, timeoutMs: 180_000 });
  if (up.code !== 0 && up.stdout + up.stderr) console.warn(`[sandbox ${session.id}] svc up: ${(up.stdout + up.stderr).trim().slice(-500)}`);
  if (recreated && !fromSnapshot) await replayRecipe(c, session.id);
  if (recreated && !fromSnapshot) {
    for (const rc of session.rootScripts) {
      const r = await runRootScript(c.sandbox, session.id, rc.script, rc.cwd);
      if (!r.ok) console.warn(`[sandbox ${session.id}] replaying approved root script failed (${r.code}): ${rc.script.slice(0, 120)}`);
    }
  }
};

/**
 * notes/setup.sh, the recipe the setup worker wrote, run as the agent (it
 * uses sudo where it needs root) on a freshly created container. Project
 * dependencies in the workspace and services in the home volume survive a
 * recreate on their own; the recipe brings back what lived in the
 * container's own filesystem. Logged to <session>/setup/recipe.log.
 */
export const replayRecipe = async (c: RunManagerConfig, sessionId: string): Promise<{ ok: boolean; code: number } | null> => {
  const h = await c.hub.get(sessionId);
  const recipe = path.join(h.paths.notes, "setup.sh");
  if (!(await fs.stat(recipe).catch(() => null))) return null;
  const t0 = Date.now();
  const r = await runInSandbox(c.sandbox, sessionId, ["bash", "-e", "/workspace/notes/setup.sh"], { allowFailure: true, timeoutMs: 30 * 60_000 });
  await fs.mkdir(h.paths.setup, { recursive: true });
  await fs.writeFile(path.join(h.paths.setup, "recipe.log"), `# notes/setup.sh · ${now()} · exit ${r.code} · ${Math.round((Date.now() - t0) / 1000)}s\n${r.stdout}${r.stderr}`);
  if (r.code !== 0) console.warn(`[sandbox ${sessionId}] replaying notes/setup.sh failed with exit ${r.code}; see setup/recipe.log`);
  return { ok: r.code === 0, code: r.code };
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
    const r = await runSetupScript(c.sandbox, sessionId, sc.script, sc.runAs);
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
    worker: (sessionId) => dockerWorker(c.sandbox, sessionId, c.credentials),
    secrets: async () => secretValues(await c.credentials.secrets()),
    proxyDenials: (sessionId, since) => proxyDenials(c.sandbox, sessionId)(since),
    ensureSandbox: (session, envFile, needsCredentials) => ensureSessionSandbox(c, session, envFile, needsCredentials),
    snapshotSandbox: (session) => snapshotSandbox(c.sandbox, session),
    healSandbox: async (sessionId) => {
      const did = await healSandbox(c.sandbox, sessionId);
      if (did.some((l) => l.startsWith("session container"))) {
        const up = await runInSandbox(c.sandbox, sessionId, ["svc", "up"], { allowFailure: true, timeoutMs: 180_000 });
        did.push(`svc up: ${(up.stdout + up.stderr).trim().split("\n").slice(-3).join("; ") || "no services"}`);
      }
      return did;
    },
  });

export const proxyDistPath = (distRoot: string): string => path.join(distRoot, "src", "proxy");
export const workerDistPath = (distRoot: string): string => path.join(distRoot, "src", "worker");

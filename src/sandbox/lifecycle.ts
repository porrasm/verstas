import { promises as fs } from "node:fs";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import type { Session } from "../core/types.js";
import type { SessionPaths } from "../sessions/sessions.js";
import {
  PROXY_SPEC_LABEL,
  SANDBOX_VERSION,
  SPEC_LABEL,
  connectProxyToBridgeArgs,
  createHomeVolumeArgs,
  rmVolumeArgs,
  containerName,
  createNetworkArgs,
  execArgs,
  listLabelledArgs,
  listLabelledNetworksArgs,
  logsArgs,
  networkName,
  proxyName,
  rmArgs,
  rmNetworkArgs,
  runProxyArgs,
  setupScriptArgs,
  runSessionArgs,
  stopArgs,
  type SandboxSpec,
} from "./docker-args.js";
import type { DockerRunner } from "./docker.js";

/**
 * Brings a session's sandbox up and down: network, proxy, container. Every
 * docker call is an argv from docker-args.ts, so what this file adds is
 * only ordering and idempotence.
 */

export type SandboxConfig = {
  docker: DockerRunner;
  proxyDistHostPath: string;
  workerDistHostPath: string;
  agentApiPort: number;
  linuxHost: boolean;
};

export type SandboxStatus = { network: boolean; proxy: "running" | "stopped" | "absent"; container: "running" | "stopped" | "absent" };

const state = async (docker: DockerRunner, name: string): Promise<"running" | "stopped" | "absent"> => {
  const r = await docker.run(["inspect", "--format", "{{.State.Running}}", name], { allowFailure: true });
  if (r.code !== 0) return "absent";
  return r.stdout.trim() === "true" ? "running" : "stopped";
};

export const sandboxStatus = async (cfg: SandboxConfig, sessionId: string): Promise<SandboxStatus> => {
  const net = await cfg.docker.run(["network", "inspect", networkName(sessionId)], { allowFailure: true });
  return {
    network: net.code === 0,
    proxy: await state(cfg.docker, proxyName(sessionId)),
    container: await state(cfg.docker, containerName(sessionId)),
  };
};

/** Writes the 0600 env file the session container reads its secrets from. */
export const writeEnvFile = async (file: string, env: Record<string, string>): Promise<void> => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const body = Object.entries(env)
    .map(([k, v]) => {
      if (!/^[A-Z][A-Z0-9_]*$/.test(k)) throw new Error(`Bad env name ${k}`);
      if (/[\r\n]/.test(v)) throw new Error(`Env ${k} contains a newline`);
      return `${k}=${v}`;
    })
    .join("\n");
  await fs.writeFile(file, body + "\n", { mode: 0o600 });
};

export const buildSpec = (cfg: SandboxConfig, session: Session, paths: SessionPaths, envFileHostPath: string): SandboxSpec => {
  const spec: SandboxSpec = {
  sessionId: session.id,
  image: session.image,
  workspaceHostPath: paths.workspace,
  allowlistDirHostPath: paths.proxyDir,
  proxyDistHostPath: cfg.proxyDistHostPath,
  workerDistHostPath: cfg.workerDistHostPath,
  envFileHostPath,
  limits: session.limits,
  agentApiPort: cfg.agentApiPort,
  linuxHost: cfg.linuxHost,
  };
  spec.fingerprint = specFingerprint(spec);
  spec.proxyFingerprint = proxyFingerprint(spec);
  return spec;
};

/** What the container was created with; a change means it must be recreated. */
export const specFingerprint = (spec: SandboxSpec): string =>
  JSON.stringify([SANDBOX_VERSION, spec.image, spec.limits.memory, spec.limits.cpus, spec.limits.pids, spec.workspaceHostPath, spec.workerDistHostPath, spec.envFileHostPath]);

/** What the proxy was created with. */
export const proxyFingerprint = (spec: SandboxSpec): string =>
  JSON.stringify([SANDBOX_VERSION, spec.allowlistDirHostPath, spec.proxyDistHostPath, spec.agentApiPort, spec.linuxHost]);

const currentFingerprint = async (docker: DockerRunner, name: string, label = SPEC_LABEL): Promise<string | null> => {
  const r = await docker.run(["inspect", "--format", `{{index .Config.Labels "${label}"}}`, name], { allowFailure: true });
  return r.code === 0 ? r.stdout.trim() : null;
};

/**
 * Idempotent: creates what is missing, starts what is stopped, and replaces
 * the session container only when its spec (image, limits, mounts) differs
 * from what it was created with, or when `recreate` forces it. Root
 * commands the user approved earlier are replayed by the caller after a
 * recreate (see harness/docker-worker.ts).
 */
export const ensureSandboxUp = async (cfg: SandboxConfig, spec: SandboxSpec, opts: { recreate?: boolean } = {}): Promise<{ recreated: boolean }> => {
  const { docker } = cfg;
  const st = await sandboxStatus(cfg, spec.sessionId);
  if (!st.network) await docker.run(createNetworkArgs(spec.sessionId));
  await docker.run(createHomeVolumeArgs(spec.sessionId));

  const proxyHave = st.proxy === "absent" ? null : await currentFingerprint(docker, proxyName(spec.sessionId), PROXY_SPEC_LABEL);
  if (st.proxy === "absent" || opts.recreate || proxyHave !== proxyFingerprint(spec)) {
    if (st.proxy !== "absent") await docker.run(rmArgs(proxyName(spec.sessionId)), { allowFailure: true });
    await docker.run(runProxyArgs(spec));
    await docker.run(connectProxyToBridgeArgs(spec.sessionId));
  } else if (st.proxy === "stopped") {
    await docker.run(["start", proxyName(spec.sessionId)]);
  }

  const want = specFingerprint(spec);
  const have = st.container === "absent" ? null : await currentFingerprint(docker, containerName(spec.sessionId));
  const mustRecreate = st.container === "absent" || opts.recreate || have !== want;
  if (mustRecreate) {
    if (st.container !== "absent") await docker.run(rmArgs(containerName(spec.sessionId)), { allowFailure: true });
    await docker.run(runSessionArgs(spec));
    return { recreated: true };
  }
  if (st.container === "stopped") await docker.run(["start", containerName(spec.sessionId)]);
  return { recreated: false };
};

/** Starts whatever is stopped, recreates nothing; returns what it did, for the log. */
export const healSandbox = async (cfg: SandboxConfig, sessionId: string): Promise<string[]> => {
  const st = await sandboxStatus(cfg, sessionId);
  const did: string[] = [];
  if (st.proxy === "stopped") {
    await cfg.docker.run(["start", proxyName(sessionId)]);
    did.push("proxy was stopped; started it again");
  }
  if (st.container === "stopped") {
    await cfg.docker.run(["start", containerName(sessionId)]);
    did.push("session container was stopped; started it again");
  }
  if (st.proxy === "absent" || st.container === "absent" || !st.network) throw new Error(`sandbox is missing parts (network ${st.network}, proxy ${st.proxy}, container ${st.container}); stop and start the run to recreate it`);
  return did;
};

export const stopSandbox = async (cfg: SandboxConfig, sessionId: string): Promise<void> => {
  await cfg.docker.run(stopArgs(containerName(sessionId)), { allowFailure: true, timeoutMs: 30_000 });
  await cfg.docker.run(stopArgs(proxyName(sessionId)), { allowFailure: true, timeoutMs: 30_000 });
};

/**
 * Removes container, proxy and network. Safe to call when nothing exists.
 * The home volume goes only with `everything` (deleting the session): a
 * "remove sandbox" from the UI recreates the box and should keep the caches.
 */
export const removeSandbox = async (cfg: SandboxConfig, sessionId: string, opts: { everything?: boolean } = {}): Promise<void> => {
  await cfg.docker.run(rmArgs(containerName(sessionId)), { allowFailure: true });
  await cfg.docker.run(rmArgs(proxyName(sessionId)), { allowFailure: true });
  await cfg.docker.run(rmNetworkArgs(sessionId), { allowFailure: true });
  if (opts.everything) await cfg.docker.run(rmVolumeArgs(sessionId), { allowFailure: true });
};

/** Starts a process in the session container as the agent user; the caller owns the child. */
export const execInSandbox = (cfg: SandboxConfig, sessionId: string, cmd: readonly string[], opts: { stdin?: boolean; env?: Record<string, string> } = {}): ChildProcess =>
  cfg.docker.spawn(execArgs(sessionId, cmd, { stdin: opts.stdin, env: opts.env }));

/** Runs a command to completion as the agent user and returns its output. */
export const runInSandbox = (cfg: SandboxConfig, sessionId: string, cmd: readonly string[], opts: { timeoutMs?: number; allowFailure?: boolean; input?: string; workdir?: string } = {}) =>
  cfg.docker.run(execArgs(sessionId, cmd, { workdir: opts.workdir, stdin: opts.input !== undefined }), { timeoutMs: opts.timeoutMs ?? 600_000, allowFailure: opts.allowFailure, input: opts.input });

/** An approved root script (docs/SANDBOX.md Boundary 7): bash -e on stdin, as root, 15-minute cap. */
export const runRootScript = async (cfg: SandboxConfig, sessionId: string, script: string, cwd?: string): Promise<{ ok: boolean; code: number; output: string }> => {
  const r = await cfg.docker.run(setupScriptArgs(sessionId, cwd), { input: script.endsWith("\n") ? script : script + "\n", allowFailure: true, timeoutMs: 15 * 60_000 });
  return { ok: r.code === 0, code: r.code, output: (r.stdout + r.stderr).slice(-6000) };
};

/** Runs one setup script as root (docs/SANDBOX.md Boundary 7); the script is yours, not the agent's. */
export const runSetupScript = async (cfg: SandboxConfig, sessionId: string, script: string): Promise<{ ok: boolean; code: number; output: string }> => {
  const r = await cfg.docker.run(setupScriptArgs(sessionId), { input: script, allowFailure: true, timeoutMs: 30 * 60_000 });
  return { ok: r.code === 0, code: r.code, output: r.stdout + r.stderr };
};

/** Proxy log lines since a timestamp; the loop turns "denied" lines into events. */
export const proxyLogsSince = async (cfg: SandboxConfig, sessionId: string, since: string): Promise<string[]> => {
  const r = await cfg.docker.run(logsArgs(proxyName(sessionId), since), { allowFailure: true, timeoutMs: 15_000 });
  return (r.stdout + r.stderr).split("\n").filter((l) => l.trim());
};

/** For `doctor`: every labelled container and network, to compare with the sessions root. */
export const listLabelled = async (cfg: SandboxConfig): Promise<{ containers: { name: string; sessionId: string; state: string }[]; networks: string[] }> => {
  const c = await cfg.docker.run(listLabelledArgs(), { allowFailure: true });
  const n = await cfg.docker.run(listLabelledNetworksArgs(), { allowFailure: true });
  return {
    containers: c.stdout
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [name = "", sessionId = "", state = ""] = l.split("\t");
        return { name, sessionId, state };
      }),
    networks: n.stdout.split("\n").filter(Boolean),
  };
};

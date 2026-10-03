import { promises as fs } from "node:fs";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import type { Session } from "../core/types.js";
import type { SessionPaths } from "../sessions/sessions.js";
import {
  aptUpdateCmd,
  connectProxyToBridgeArgs,
  containerName,
  createNetworkArgs,
  execArgs,
  installCmd,
  listLabelledArgs,
  listLabelledNetworksArgs,
  logsArgs,
  networkName,
  proxyName,
  rmArgs,
  rmNetworkArgs,
  runProxyArgs,
  runSessionArgs,
  stopArgs,
  type InstallManager,
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

export const buildSpec = (cfg: SandboxConfig, session: Session, paths: SessionPaths, envFileHostPath: string): SandboxSpec => ({
  sessionId: session.id,
  image: session.image,
  workspaceHostPath: paths.workspace,
  allowlistHostPath: paths.allowlist,
  proxyDistHostPath: cfg.proxyDistHostPath,
  workerDistHostPath: cfg.workerDistHostPath,
  envFileHostPath,
  limits: session.limits,
  agentApiPort: cfg.agentApiPort,
  linuxHost: cfg.linuxHost,
});

/**
 * Idempotent: creates what is missing, starts what is stopped, replaces the
 * session container when its spec (image, limits) changed since it was
 * created, which `recreate` forces.
 */
export const ensureSandboxUp = async (cfg: SandboxConfig, spec: SandboxSpec, opts: { recreate?: boolean } = {}): Promise<void> => {
  const { docker } = cfg;
  const st = await sandboxStatus(cfg, spec.sessionId);
  if (!st.network) await docker.run(createNetworkArgs(spec.sessionId));

  if (st.proxy === "absent" || opts.recreate) {
    if (st.proxy !== "absent") await docker.run(rmArgs(proxyName(spec.sessionId)), { allowFailure: true });
    await docker.run(runProxyArgs(spec));
    await docker.run(connectProxyToBridgeArgs(spec.sessionId));
  } else if (st.proxy === "stopped") {
    await docker.run(["start", proxyName(spec.sessionId)]);
  }

  if (st.container === "absent" || opts.recreate) {
    if (st.container !== "absent") await docker.run(rmArgs(containerName(spec.sessionId)), { allowFailure: true });
    await docker.run(runSessionArgs(spec));
  } else if (st.container === "stopped") {
    await docker.run(["start", containerName(spec.sessionId)]);
  }
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

/** Removes container, proxy and network. Safe to call when nothing exists. */
export const removeSandbox = async (cfg: SandboxConfig, sessionId: string): Promise<void> => {
  await cfg.docker.run(rmArgs(containerName(sessionId)), { allowFailure: true });
  await cfg.docker.run(rmArgs(proxyName(sessionId)), { allowFailure: true });
  await cfg.docker.run(rmNetworkArgs(sessionId), { allowFailure: true });
};

/** Starts a process in the session container as the agent user; the caller owns the child. */
export const execInSandbox = (cfg: SandboxConfig, sessionId: string, cmd: readonly string[], opts: { stdin?: boolean; env?: Record<string, string> } = {}): ChildProcess =>
  cfg.docker.spawn(execArgs(sessionId, cmd, { stdin: opts.stdin, env: opts.env }));

/** Runs a command to completion as the agent user and returns its output. */
export const runInSandbox = (cfg: SandboxConfig, sessionId: string, cmd: readonly string[], opts: { timeoutMs?: number; allowFailure?: boolean; input?: string; workdir?: string } = {}) =>
  cfg.docker.run(execArgs(sessionId, cmd, { workdir: opts.workdir, stdin: opts.input !== undefined }), { timeoutMs: opts.timeoutMs ?? 600_000, allowFailure: opts.allowFailure, input: opts.input });

/** The one root operation: an approved install (docs/SANDBOX.md Boundary 7). */
export const installInSandbox = async (cfg: SandboxConfig, sessionId: string, manager: InstallManager, packages: readonly string[]): Promise<{ ok: boolean; output: string }> => {
  const run = (cmd: string[]) => cfg.docker.run(execArgs(sessionId, cmd, { user: "root", workdir: "/" }), { allowFailure: true, timeoutMs: 900_000 });
  if (manager === "apt") {
    const upd = await run(aptUpdateCmd());
    if (upd.code !== 0) return { ok: false, output: (upd.stdout + upd.stderr).slice(-4000) };
  }
  const r = await run(installCmd(manager, packages));
  return { ok: r.code === 0, output: (r.stdout + r.stderr).slice(-4000) };
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

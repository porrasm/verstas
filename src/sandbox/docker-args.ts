import type { Limits } from "../core/types.js";

/**
 * Builds the exact `docker` argument vectors for a session. Pure: no IO, no
 * Docker. Unit tests pin the output so any change to a sandbox boundary is a
 * visible test diff. docs/SANDBOX.md Boundary 2 and 3 are the prose version
 * of this file; keep them in step.
 */

export const LABEL_KEY = "verstas.session";
/** Holds the spec fingerprint the container was created with (see lifecycle.specFingerprint). */
export const SPEC_LABEL = "verstas.spec";
/** Same idea for the proxy container. */
export const PROXY_SPEC_LABEL = "verstas.proxyspec";
export const PROXY_PORT = 3128;
export const PROXY_IMAGE = "node:22-alpine";
export const AGENT_API_HOST = "host.docker.internal";
/**
 * Bumped whenever the session container's flags change, so a container
 * created under older rules is recreated on the next start instead of
 * silently keeping them (it joins the spec fingerprint).
 */
export const SANDBOX_VERSION = 2;

/**
 * Capabilities the session container keeps: Docker's default set minus
 * NET_RAW (raw sockets, packet spoofing), MKNOD (device nodes) and
 * AUDIT_WRITE. The agent runs as uid 1000, so these do nothing for it; they
 * exist so that root inside the box (setup scripts, approved root scripts)
 * can install packages: apt drops to its _apt user (SETUID/SETGID), dpkg
 * chowns files (CHOWN/FOWNER), installers write into root-owned trees
 * (DAC_OVERRIDE). None of them crosses a namespace. docs/SANDBOX.md
 * Boundary 2 explains the trade.
 */
export const SESSION_CAPS = [
  "CHOWN",
  "DAC_OVERRIDE",
  "FOWNER",
  "FSETID",
  "KILL",
  "SETGID",
  "SETUID",
  "SETPCAP",
  "SETFCAP",
  "NET_BIND_SERVICE",
  "SYS_CHROOT",
] as const;

export const networkName = (sessionId: string): string => `verstas-${sessionId}`;
export const containerName = (sessionId: string): string => `verstas-${sessionId}`;
export const proxyName = (sessionId: string): string => `verstas-${sessionId}-proxy`;

export type SandboxSpec = {
  sessionId: string;
  image: string;
  /** Host path of <session>/workspace, bind-mounted at /workspace. */
  workspaceHostPath: string;
  /** Host path of <session>/proxy/, mounted read-only into the proxy; holds allowlist.json. */
  allowlistDirHostPath: string;
  /** Host path of the compiled proxy directory (dist/src/proxy), mounted read-only. */
  proxyDistHostPath: string;
  /** Host path of the compiled worker directory (dist/src/worker), mounted read-only over the image's copy. */
  workerDistHostPath: string;
  /** Host path of a 0600 env file holding the secrets for this run. */
  envFileHostPath: string;
  limits: Limits;
  agentApiPort: number;
  /** Linux needs host-gateway spelled out; Docker Desktop provides host.docker.internal itself. */
  linuxHost: boolean;
  /** Written as a label so a later start can tell whether the container must be recreated. */
  fingerprint?: string;
  /** The same for the proxy. */
  proxyFingerprint?: string;
};

const label = (sessionId: string): string[] => ["--label", `${LABEL_KEY}=${sessionId}`];

/** `--internal`: no gateway, no route out, no host.docker.internal. */
export const createNetworkArgs = (sessionId: string): string[] => [
  "network",
  "create",
  "--internal",
  ...label(sessionId),
  networkName(sessionId),
];

/** The proxy starts on the internal network, then is connected to the bridge for egress. */
export const runProxyArgs = (spec: SandboxSpec): string[] => [
  "run",
  "-d",
  "--name",
  proxyName(spec.sessionId),
  ...label(spec.sessionId),
  ...(spec.proxyFingerprint ? ["--label", `${PROXY_SPEC_LABEL}=${spec.proxyFingerprint}`] : []),
  "--network",
  networkName(spec.sessionId),
  "--network-alias",
  "proxy",
  "--user",
  "1000:1000",
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges",
  "--read-only",
  "--pids-limit",
  "256",
  "--memory",
  "256m",
  "--cpus",
  "0.5",
  // Our own stateless code: if it ever dies, come back, because the session
  // has no egress without it. The session container keeps --restart no.
  "--restart",
  "on-failure:5",
  "--init",
  "-v",
  `${spec.proxyDistHostPath}:/proxy:ro`,
  "-v",
  // A directory, not the file: the host rewrites allowlist.json by rename,
  // and a single-file bind mount would keep showing the old inode.
  `${spec.allowlistDirHostPath}:/allowlist:ro`,
  "-e",
  "ALLOWLIST_FILE=/allowlist/allowlist.json",
  "-e",
  `VERSTAS_AGENT_API=${AGENT_API_HOST}:${spec.agentApiPort}`,
  "-e",
  `PORT=${PROXY_PORT}`,
  ...(spec.linuxHost ? ["--add-host", `${AGENT_API_HOST}:host-gateway`] : []),
  PROXY_IMAGE,
  "node",
  "/proxy/proxy.js",
];

export const connectProxyToBridgeArgs = (sessionId: string): string[] => [
  "network",
  "connect",
  "bridge",
  proxyName(sessionId),
];

/**
 * The session container. It idles (`sleep infinity`); workers are started
 * into it with `docker exec`, so one container serves the whole session and
 * a crashed worker never takes the workspace's processes with it.
 */
export const runSessionArgs = (spec: SandboxSpec): string[] => [
  "run",
  "-d",
  "--name",
  containerName(spec.sessionId),
  ...label(spec.sessionId),
  ...(spec.fingerprint ? ["--label", `${SPEC_LABEL}=${spec.fingerprint}`] : []),
  "--network",
  networkName(spec.sessionId),
  "--user",
  "1000:1000",
  "--cap-drop",
  "ALL",
  ...SESSION_CAPS.flatMap((c) => ["--cap-add", c]),
  "--security-opt",
  "no-new-privileges",
  "--pids-limit",
  String(spec.limits.pids),
  "--memory",
  spec.limits.memory,
  "--cpus",
  String(spec.limits.cpus),
  // exec: installers and builds run binaries from the temp directory.
  "--tmpfs",
  "/tmp:exec,size=2g",
  "--init",
  "--restart",
  "no",
  "-v",
  `${spec.workspaceHostPath}:/workspace`,
  "-v",
  `${spec.workerDistHostPath}:/opt/verstas:ro`,
  "-w",
  "/workspace",
  "--env-file",
  spec.envFileHostPath,
  "-e",
  `HTTPS_PROXY=http://proxy:${PROXY_PORT}`,
  "-e",
  `HTTP_PROXY=http://proxy:${PROXY_PORT}`,
  "-e",
  `https_proxy=http://proxy:${PROXY_PORT}`,
  "-e",
  `http_proxy=http://proxy:${PROXY_PORT}`,
  "-e",
  "NO_PROXY=localhost,127.0.0.1",
  "-e",
  `VERSTAS_AGENT_API=http://${AGENT_API_HOST}:${spec.agentApiPort}/agent`,
  "-e",
  "HOME=/workspace/.home",
  "-e",
  "TMPDIR=/tmp",
  spec.image,
  "sleep",
  "infinity",
];

export type ExecOptions = {
  /** Only the harness's install step uses root; everything else runs as the agent. */
  user?: "root";
  stdin?: boolean;
  workdir?: string;
  env?: Record<string, string>;
};

export const execArgs = (sessionId: string, cmd: readonly string[], opts: ExecOptions = {}): string[] => [
  "exec",
  ...(opts.stdin ? ["-i"] : []),
  ...(opts.user ? ["-u", opts.user] : []),
  "-w",
  opts.workdir ?? "/workspace",
  ...Object.entries(opts.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
  containerName(sessionId),
  ...cmd,
];

export const stopArgs = (name: string): string[] => ["stop", "-t", "10", name];
export const rmArgs = (name: string): string[] => ["rm", "-f", "-v", name];
export const rmNetworkArgs = (sessionId: string): string[] => ["network", "rm", networkName(sessionId)];
export const logsArgs = (name: string, since?: string): string[] => [
  "logs",
  ...(since ? ["--since", since] : []),
  name,
];
export const listLabelledArgs = (): string[] => [
  "ps",
  "-a",
  "--filter",
  `label=${LABEL_KEY}`,
  "--format",
  "{{.Names}}\t{{.Label \"verstas.session\"}}\t{{.State}}",
];
export const listLabelledNetworksArgs = (): string[] => [
  "network",
  "ls",
  "--filter",
  `label=${LABEL_KEY}`,
  "--format",
  "{{.Name}}",
];
export const duArgs = (sessionId: string): string[] => execArgs(sessionId, ["du", "-sm", "/workspace"]);

// --- Root scripts approved by the user (docs/SANDBOX.md Boundary 7) --------

/**
 * A setup script or an approved root script, fed on stdin: `bash -e -s` as
 * root. The text is the user's (setup) or the agent's after the user read
 * it (request action); it never runs otherwise.
 */
export const setupScriptArgs = (sessionId: string, cwd = "/workspace"): string[] =>
  execArgs(sessionId, ["bash", "-e", "-s"], { user: "root", workdir: cwd, stdin: true, env: { DEBIAN_FRONTEND: "noninteractive" } });

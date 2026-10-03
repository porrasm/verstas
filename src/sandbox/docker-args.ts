import type { Limits } from "../core/types.js";

/**
 * Builds the exact `docker` argument vectors for a session. Pure: no IO, no
 * Docker. Unit tests pin the output so any change to a sandbox boundary is a
 * visible test diff. docs/SANDBOX.md Boundary 2 and 3 are the prose version
 * of this file; keep them in step.
 */

export const LABEL_KEY = "verstas.session";
export const PROXY_PORT = 3128;
export const PROXY_IMAGE = "node:22-alpine";
export const AGENT_API_HOST = "host.docker.internal";

export const networkName = (sessionId: string): string => `verstas-${sessionId}`;
export const containerName = (sessionId: string): string => `verstas-${sessionId}`;
export const proxyName = (sessionId: string): string => `verstas-${sessionId}-proxy`;

export type SandboxSpec = {
  sessionId: string;
  image: string;
  /** Host path of <session>/workspace, bind-mounted at /workspace. */
  workspaceHostPath: string;
  /** Host path of <session>/allowlist.json, mounted read-only into the proxy. */
  allowlistHostPath: string;
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
  `${spec.allowlistHostPath}:/allowlist.json:ro`,
  "-e",
  "ALLOWLIST_FILE=/allowlist.json",
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
  "--network",
  networkName(spec.sessionId),
  "--user",
  "1000:1000",
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges",
  "--pids-limit",
  String(spec.limits.pids),
  "--memory",
  spec.limits.memory,
  "--cpus",
  String(spec.limits.cpus),
  "--tmpfs",
  "/tmp:size=1g",
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

// --- Installs requested by the agent (docs/SANDBOX.md Boundary 7) -----------

export type InstallManager = "apt" | "npm" | "pip";

/**
 * The install command the harness runs as root. Built from validated
 * fields only: the manager is one of three and every package name already
 * matched PACKAGE_NAME_PATTERN at the schema. No shell is involved; this is
 * an argv.
 */
export const installCmd = (manager: InstallManager, packages: readonly string[]): string[] => {
  switch (manager) {
    case "apt":
      return ["apt-get", "install", "-y", "--no-install-recommends", ...packages];
    case "npm":
      return ["npm", "install", "-g", ...packages];
    case "pip":
      return ["pip", "install", "--break-system-packages", ...packages];
  }
};

/** apt needs an index; run before the first apt install of a container. */
export const aptUpdateCmd = (): string[] => ["apt-get", "update"];

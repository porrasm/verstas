import { test, expect } from "@playwright/test";
import {
  connectProxyToBridgeArgs,
  createNetworkArgs,
  execArgs,
  ownWorkspaceArgs,
  runProxyArgs,
  setupScriptArgs,
  runSessionArgs,
  type SandboxSpec,
} from "../../src/sandbox/docker-args.js";
import { limitsSchema } from "../../src/core/types.js";

const spec: SandboxSpec = {
  sessionId: "nuppi-mvp",
  image: "verstas-devbox:local",
  workspaceHostPath: "/Users/me/verstas/sessions/nuppi-mvp/workspace",
  allowlistDirHostPath: "/Users/me/verstas/sessions/nuppi-mvp/proxy",
  proxyDistHostPath: "/Users/me/verstas/dist/src/proxy",
  workerDistHostPath: "/Users/me/verstas/dist/src/worker",
  envFileHostPath: "/Users/me/verstas/sessions/nuppi-mvp/runs/1/env",
  limits: limitsSchema.parse({}),
  agentApiPort: 4701,
  linuxHost: false,
};

const envs_ = (args: string[]) => args.flatMap((a, i) => (a === "-e" ? [args[i + 1]] : []));

/**
 * These tests pin the sandbox boundaries from docs/SANDBOX.md. If one fails
 * because you changed an option on purpose, update the document in the same
 * commit.
 */

test("the session network is internal and labelled", () => {
  expect(createNetworkArgs("nuppi-mvp")).toEqual([
    "network", "create", "--internal", "--label", "verstas.session=nuppi-mvp", "verstas-nuppi-mvp",
  ]);
});

test("the session container has exactly the documented boundaries", () => {
  const args = runSessionArgs(spec);
  const pairs = (flag: string) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));
  expect(pairs("--network")).toEqual(["verstas-nuppi-mvp"]);
  expect(pairs("--user")).toEqual(["1000:1000"]);
  expect(pairs("--cap-drop")).toEqual(["ALL"]);
  // Docker's defaults minus NET_RAW and MKNOD: enough for root in the box to install packages.
  expect(pairs("--cap-add")).toEqual(["CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID", "KILL", "SETGID", "SETUID", "SETPCAP", "SETFCAP", "NET_BIND_SERVICE", "SYS_CHROOT", "AUDIT_WRITE"]);
  for (const never of ["NET_RAW", "MKNOD", "SYS_ADMIN", "NET_ADMIN", "SYS_PTRACE", "SYS_MODULE", "ALL"]) expect(pairs("--cap-add")).not.toContain(never);
  // sudo is the point; seccomp stays at Docker's default (no unconfined, no apparmor override).
  expect(pairs("--security-opt")).toEqual([]);
  expect(pairs("--pids-limit")).toEqual(["2048"]);
  expect(pairs("--memory")).toEqual(["4g"]);
  expect(pairs("--cpus")).toEqual(["2"]);
  expect(pairs("--tmpfs")).toEqual(["/tmp:exec,size=2g"]);
  expect(pairs("--restart")).toEqual(["no"]);
  expect(args).toContain("--init");
  // Two bind mounts (the workspace read-write, our worker code read-only) and the session's home volume.
  expect(pairs("-v")).toEqual([`${spec.workspaceHostPath}:/workspace`, `${spec.workerDistHostPath}:/opt/verstas:ro`, "verstas-nuppi-mvp-home:/home/agent"]);
  expect(envs_(args)).toContain("HOME=/home/agent");
  // Secrets come from a file, never from -e.
  expect(pairs("--env-file")).toEqual([spec.envFileHostPath]);
  const envs = pairs("-e");
  expect(envs).toContain("HTTPS_PROXY=http://proxy:3128");
  expect(envs).toContain("NO_PROXY=localhost,127.0.0.1");
  expect(envs).toContain("TMPDIR=/tmp");
  expect(envs.some((e) => /TOKEN|KEY|SECRET/i.test(e ?? ""))).toBe(false);
  // Nothing that opens the box.
  for (const forbidden of ["--privileged", "--device", "--pid", "--ipc", "--userns", "-p", "--publish"]) {
    expect(args).not.toContain(forbidden);
  }
  expect(args.some((a) => a.includes("docker.sock"))).toBe(false);
  // Image, then an idle command: workers come in through exec.
  expect(args.slice(-3)).toEqual(["verstas-devbox:local", "sleep", "infinity"]);
});

test("the proxy is read-only, unprivileged, and only mounts its code and the allowlist", () => {
  const args = runProxyArgs(spec);
  const pairs = (flag: string) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));
  expect(args).toContain("--read-only");
  expect(pairs("--cap-drop")).toEqual(["ALL"]);
  expect(pairs("--user")).toEqual(["1000:1000"]);
  expect(pairs("--network")).toEqual(["verstas-nuppi-mvp"]);
  expect(pairs("--network-alias")).toEqual(["proxy"]);
  expect(pairs("--restart")).toEqual(["on-failure:5"]);
  expect(pairs("-v")).toEqual([
    `${spec.proxyDistHostPath}:/proxy:ro`,
    `${spec.allowlistDirHostPath}:/allowlist:ro`,
  ]);
  expect(pairs("-e")).toEqual([
    "ALLOWLIST_FILE=/allowlist/allowlist.json",
    "VERSTAS_AGENT_API=host.docker.internal:4701",
    "PORT=3128",
  ]);
  expect(args).not.toContain("--add-host");
  expect(runProxyArgs({ ...spec, linuxHost: true })).toContain("host.docker.internal:host-gateway");
  expect(args.slice(-3)).toEqual(["node:22-alpine", "node", "/proxy/proxy.js"]);
  expect(connectProxyToBridgeArgs("nuppi-mvp")).toEqual(["network", "connect", "bridge", "verstas-nuppi-mvp-proxy"]);
});

test("exec runs as the agent in /workspace unless the harness asks for root", () => {
  expect(execArgs("nuppi-mvp", ["git", "status"])).toEqual(["exec", "-w", "/workspace", "verstas-nuppi-mvp", "git", "status"]);
  expect(execArgs("nuppi-mvp", ["cat"], { stdin: true, user: "root", workdir: "/", env: { A: "1" } })).toEqual([
    "exec", "-i", "-u", "root", "-w", "/", "-e", "A=1", "verstas-nuppi-mvp", "cat",
  ]);
});

test("the spec fingerprint label is written when given", () => {
  const args = runSessionArgs({ ...spec, fingerprint: "abc" });
  expect(args).toContain("verstas.spec=abc");
});

test("setup scripts and approved root scripts are fed on stdin to bash -e as root, non-interactive", () => {
  expect(setupScriptArgs("nuppi-mvp")).toEqual(["exec", "-i", "-u", "root", "-w", "/workspace", "-e", "DEBIAN_FRONTEND=noninteractive", "verstas-nuppi-mvp", "bash", "-e", "-s"]);
  expect(setupScriptArgs("nuppi-mvp", "/tmp").slice(4, 6)).toEqual(["-w", "/tmp"]);
});

test("a snapshot is a labelled commit of the session container, and the container can be created from it", async () => {
  const { commitArgs, listSnapshotImagesArgs, snapshotImageName } = await import("../../src/sandbox/docker-args.js");
  expect(commitArgs("nuppi-mvp")).toEqual(["commit", "--change", "LABEL verstas.session=nuppi-mvp", "verstas-nuppi-mvp", "verstas-session-nuppi-mvp:latest"]);
  expect(listSnapshotImagesArgs("nuppi-mvp")).toEqual(["image", "ls", "-q", "--no-trunc", "--filter", "label=verstas.session=nuppi-mvp"]);
  const args = runSessionArgs({ ...spec, runImage: snapshotImageName("nuppi-mvp") });
  expect(args.slice(-3)).toEqual(["verstas-session-nuppi-mvp:latest", "sleep", "infinity"]);
});

test("secrets reach an exec by name only, never by value in argv", () => {
  const args = execArgs("nuppi-mvp", ["node", "/opt/verstas/worker.js"], { passEnv: ["CLAUDE_CODE_OAUTH_TOKEN", "VERSTAS_RUN_TOKEN"] });
  expect(args).toEqual(["exec", "-w", "/workspace", "-e", "CLAUDE_CODE_OAUTH_TOKEN", "-e", "VERSTAS_RUN_TOKEN", "verstas-nuppi-mvp", "node", "/opt/verstas/worker.js"]);
});

test("each worker runs from its own job file, and stopping one matches only that file", async () => {
  const { workerCommand, workerPattern, WORKER_PATTERN } = await import("../../src/harness/docker-worker.js");
  const a = "/workspace/.verstas/jobs/3-7-reviewer/job.json";
  expect(workerCommand(a)).toEqual(["node", "/opt/verstas/worker.js", "--job", a]);
  expect(workerCommand(a).join(" ")).toContain(workerPattern(a));
  expect(workerCommand("/workspace/.verstas/jobs/3-6-implementer/job.json").join(" ")).not.toContain(workerPattern(a));
  // Recovery after a crash still stops them all.
  expect(workerCommand(a).join(" ")).toContain(WORKER_PATTERN);
});

test("handing the workspace to the agent runs as root and touches only files the agent does not own", () => {
  const args = ownWorkspaceArgs("nuppi-mvp");
  expect(args.slice(0, 3)).toEqual(["exec", "-u", "root"]);
  expect(args).toContain("verstas-nuppi-mvp");
  expect(args.slice(args.indexOf("find"))).toEqual(["find", "/workspace", "-xdev", "!", "-user", "1000", "-exec", "chown", "-h", "1000:1000", "{}", "+"]);
});

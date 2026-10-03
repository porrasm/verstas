import { test, expect } from "@playwright/test";
import {
  connectProxyToBridgeArgs,
  createNetworkArgs,
  execArgs,
  rootCommandArgs,
  runProxyArgs,
  runSessionArgs,
  type SandboxSpec,
} from "../../src/sandbox/docker-args.js";
import { limitsSchema } from "../../src/core/types.js";

const spec: SandboxSpec = {
  sessionId: "nuppi-mvp",
  image: "verstas-devbox:local",
  workspaceHostPath: "/Users/me/verstas/sessions/nuppi-mvp/workspace",
  allowlistHostPath: "/Users/me/verstas/sessions/nuppi-mvp/allowlist.json",
  proxyDistHostPath: "/Users/me/verstas/dist/src/proxy",
  workerDistHostPath: "/Users/me/verstas/dist/src/worker",
  envFileHostPath: "/Users/me/verstas/sessions/nuppi-mvp/runs/1/env",
  limits: limitsSchema.parse({}),
  agentApiPort: 4701,
  linuxHost: false,
};

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
  expect(pairs("--security-opt")).toEqual(["no-new-privileges"]);
  expect(pairs("--pids-limit")).toEqual(["2048"]);
  expect(pairs("--memory")).toEqual(["4g"]);
  expect(pairs("--cpus")).toEqual(["2"]);
  expect(pairs("--tmpfs")).toEqual(["/tmp:size=1g"]);
  expect(pairs("--restart")).toEqual(["no"]);
  expect(args).toContain("--init");
  // Two bind mounts: the workspace read-write, and our worker code read-only.
  expect(pairs("-v")).toEqual([`${spec.workspaceHostPath}:/workspace`, `${spec.workerDistHostPath}:/opt/verstas:ro`]);
  // Secrets come from a file, never from -e.
  expect(pairs("--env-file")).toEqual([spec.envFileHostPath]);
  const envs = pairs("-e");
  expect(envs).toContain("HTTPS_PROXY=http://proxy:3128");
  expect(envs).toContain("NO_PROXY=localhost,127.0.0.1");
  expect(envs.some((e) => /TOKEN|KEY|SECRET/i.test(e ?? ""))).toBe(false);
  // Nothing that opens the box.
  for (const forbidden of ["--privileged", "--device", "--cap-add", "--pid", "--ipc", "--userns", "-p", "--publish"]) {
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
    `${spec.allowlistHostPath}:/allowlist.json:ro`,
  ]);
  expect(pairs("-e")).toEqual([
    "ALLOWLIST_FILE=/allowlist.json",
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

test("a root command runs as root through sh -c in the given directory", () => {
  expect(rootCommandArgs("nuppi-mvp", "apt-get update && apt-get install -y tree")).toEqual([
    "exec", "-u", "root", "-w", "/workspace", "verstas-nuppi-mvp", "sh", "-c", "apt-get update && apt-get install -y tree",
  ]);
  expect(rootCommandArgs("nuppi-mvp", "ls", "/tmp").slice(3, 5)).toEqual(["-w", "/tmp"]);
});

test("the spec fingerprint label is written when given", () => {
  const args = runSessionArgs({ ...spec, fingerprint: "abc" });
  expect(args).toContain("verstas.spec=abc");
});

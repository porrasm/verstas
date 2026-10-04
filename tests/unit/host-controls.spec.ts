import { test, expect } from "@playwright/test";
import { listSandboxes, stopAllSandboxes, type SandboxConfig } from "../../src/sandbox/lifecycle.js";
import type { DockerRunner } from "../../src/sandbox/docker.js";

/** A docker that knows three sessions: one running, one stopped, one with only a proxy left. */
const fakeDocker = (calls: string[][]): DockerRunner => ({
  async run(args) {
    calls.push([...args]);
    if (args[0] === "ps") {
      const out = ["2026-10-04-a\tverstas-2026-10-04-a\trunning", "2026-10-04-a\tverstas-2026-10-04-a-proxy\trunning", "2026-10-04-b\tverstas-2026-10-04-b\texited", "2026-10-04-c\tverstas-2026-10-04-c-proxy\trunning", "2026-10-04-d\tverstas-2026-10-04-d\trunning", ""].join("\n");
      return { code: 0, stdout: out, stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  },
});

const cfg = (calls: string[][]): SandboxConfig => ({ docker: fakeDocker(calls), proxyDistHostPath: "/p", workerDistHostPath: "/w", agentApiPort: 4701, linuxHost: false });

test("listSandboxes: one docker call, session containers only, proxies and leftovers ignored", async () => {
  const calls: string[][] = [];
  const boxes = await listSandboxes(cfg(calls));
  expect([...boxes]).toEqual([
    ["2026-10-04-a", "running"],
    ["2026-10-04-b", "stopped"],
    ["2026-10-04-d", "running"],
  ]);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.slice(0, 2)).toEqual(["ps", "-a"]);
});

test("stopAllSandboxes: stops the running boxes and their proxies, skips sessions with an active run", async () => {
  const calls: string[][] = [];
  const stopped = await stopAllSandboxes(cfg(calls), new Set(["2026-10-04-d"]));
  expect(stopped).toEqual(["2026-10-04-a"]);
  const stops = calls.filter((c) => c[0] === "stop").map((c) => c[c.length - 1]);
  expect(stops.sort()).toEqual(["verstas-2026-10-04-a", "verstas-2026-10-04-a-proxy"]);
});

test("listSandboxes: docker down means no boxes, not an error", async () => {
  const c: SandboxConfig = { ...cfg([]), docker: { run: async () => ({ code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" }) } };
  expect((await listSandboxes(c)).size).toBe(0);
});

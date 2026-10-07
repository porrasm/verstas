import { test, expect } from "@playwright/test";
import { promises as fs } from "node:fs";
import type net from "node:net";
import os from "node:os";
import path from "node:path";
import { emptyBoard } from "../../src/board/board.js";
import { saveBoard, writeJsonAtomic } from "../../src/board/store.js";
import { inboxSchema, sessionSchema, type Session } from "../../src/core/types.js";
import { copySnapshot, removeSnapshots, type SandboxConfig } from "../../src/sandbox/lifecycle.js";
import type { DockerRunner } from "../../src/sandbox/docker.js";
import { copyEnvironmentFiles, environmentSettings, notesToCopy } from "../../src/sessions/from-environment.js";
import { SessionHub } from "../../src/sessions/hub.js";
import { sessionPaths } from "../../src/sessions/sessions.js";
import { createUiApi, type UiApiDeps } from "../../src/web/api.js";

/** A new session from an existing session's environment: what carries over, and what the Docker side keeps apart. */

const t = "2026-10-07T08:00:00.000Z";
const source = (over: Partial<Session> = {}): Session =>
  sessionSchema.parse({
    id: "2026-10-01-old",
    name: "Old",
    createdAt: t,
    initializedAt: t,
    image: "verstas-devbox:local",
    requirements: "  .NET 9 and Chromium  ",
    setupMode: "agentic",
    mode: "lead",
    agents: { worker: { driver: "claude", model: "opus" } },
    packs: ["dotnet"],
    allowlist: ["api.nuget.org"],
    caps: { workerMinutes: 50, choreSweepAt: 7 },
    limits: { cpus: 6 },
    rootScripts: [{ script: "apt-get install -y fonts", at: t }],
    readiness: { verdict: "ready", at: t, summary: "ok", checks: [], confirmedAt: t },
    snapshot: { image: "verstas-session-2026-10-01-old:latest", at: t, baseImageId: "sha256:base" },
    remote: true,
    prompts: [{ at: t, runId: 1, kind: "prompt", text: "hi", reply: "hello", stopReason: "success" }],
    ...over,
  });

test("the settings carry over; the board, prompts, remote flag, id and name do not", () => {
  const s = environmentSettings(source(), {}, t);
  expect(s).toMatchObject({ image: "verstas-devbox:local", mode: "lead", setupMode: "agentic", packs: ["dotnet"], allowlist: ["api.nuget.org"], agents: { worker: { driver: "claude", model: "opus" } } });
  expect(s.caps).toMatchObject({ workerMinutes: 50, choreSweepAt: 7 });
  expect(s.limits).toMatchObject({ cpus: 6 });
  expect(s.rootScripts.map((r) => r.script)).toEqual(["apt-get install -y fonts"]);
  for (const k of ["id", "name", "prompts", "remote", "repos", "snapshot", "initializedAt"]) expect(s).not.toHaveProperty(k);
});

test("readiness carries over only when it was confirmed ready and the requirements are the same", () => {
  expect(environmentSettings(source(), {}, t)).toMatchObject({ readiness: { verdict: "ready" }, environmentFrom: { session: "2026-10-01-old", readinessCarried: true } });
  // The same text with other surrounding whitespace is the same requirements.
  expect(environmentSettings(source(), { requirements: ".NET 9 and Chromium" }, t).environmentFrom!.readinessCarried).toBe(true);
  const changed = environmentSettings(source(), { requirements: ".NET 9, Chromium and Postgres" }, t);
  expect(changed.readiness).toBeUndefined();
  expect(changed.environmentFrom!.readinessCarried).toBe(false);
  expect(changed.requirements).toBe(".NET 9, Chromium and Postgres");
  expect(environmentSettings(source({ readiness: { verdict: "needs", at: t, summary: "", checks: [] } }), {}, t).readiness).toBeUndefined();
});

test("notes: the box's always, brief and learnings unless unticked, the rest only with all notes, never the handoff", () => {
  const names = ["env.md", "setup.sh", "tools", "INDEX.md", "brief.md", "learnings.md", "state.md", "t12", "c23"];
  expect(notesToCopy(names, { projectNotes: true, allNotes: false })).toEqual(["env.md", "setup.sh", "tools", "INDEX.md", "brief.md", "learnings.md"]);
  expect(notesToCopy(names, { projectNotes: false, allNotes: false })).toEqual(["env.md", "setup.sh", "tools", "INDEX.md"]);
  expect(notesToCopy(names, { projectNotes: false, allNotes: true })).toEqual(["env.md", "setup.sh", "tools", "INDEX.md", "brief.md", "learnings.md", "t12", "c23"]);
});

test("copyEnvironmentFiles copies the chosen notes, directories included, and attachments only when asked", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "verstas-fromenv-"));
  try {
    const a = sessionPaths(root, "2026-10-01-a");
    const b = sessionPaths(root, "2026-10-07-b");
    await fs.mkdir(path.join(a.notes, "tools"), { recursive: true });
    await fs.mkdir(path.join(a.attachments, "ref"), { recursive: true });
    await fs.writeFile(path.join(a.notes, "env.md"), "env");
    await fs.writeFile(path.join(a.notes, "tools", "svc.sh"), "svc");
    await fs.writeFile(path.join(a.notes, "state.md"), "handoff");
    await fs.writeFile(path.join(a.notes, "learnings.md"), "learned");
    await fs.writeFile(path.join(a.attachments, "ref", "x.txt"), "x");
    const out = await copyEnvironmentFiles(a, b, { projectNotes: true, allNotes: false, attachments: false });
    expect(out.notes.sort()).toEqual(["env.md", "learnings.md", "tools"]);
    expect(await fs.readFile(path.join(b.notes, "tools", "svc.sh"), "utf8")).toBe("svc");
    await expect(fs.stat(path.join(b.notes, "state.md"))).rejects.toThrow();
    await expect(fs.stat(path.join(b.attachments, "ref"))).rejects.toThrow();
    await copyEnvironmentFiles(a, b, { projectNotes: false, allNotes: false, attachments: true });
    expect(await fs.readFile(path.join(b.attachments, "ref", "x.txt"), "utf8")).toBe("x");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/** A docker that keeps images with their labels: inspect, build FROM, ls by label, rm. */
const imageStore = () => {
  const images: { id: string; ref?: string; labels: Record<string, string> }[] = [{ id: "sha256:base", ref: "verstas-devbox:local", labels: {} }, { id: "sha256:old", ref: "verstas-session-2026-10-01-old:latest", labels: { "verstas.session": "2026-10-01-old" } }];
  const docker: DockerRunner = {
    spawn: () => {
      throw new Error("no spawn");
    },
    async run(args, opts = {}) {
      const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
      const find = (r: string) => images.find((i) => i.ref === r || i.id === r);
      if (args[0] === "image" && args[1] === "inspect") {
        const i = find(args.at(-1)!);
        return i ? ok(i.id) : { code: 1, stdout: "", stderr: "no such image" };
      }
      if (args[0] === "build") {
        const from = /^FROM (\S+)/.exec(opts.input ?? "")![1]!;
        const parent = find(from)!;
        const [k, v] = args[args.indexOf("--label") + 1]!.split("=");
        images.push({ id: `sha256:new${images.length}`, ref: args[args.indexOf("-t") + 1], labels: { ...parent.labels, [k!]: v! } });
        return ok();
      }
      if (args[0] === "image" && args[1] === "ls") {
        const [k, v] = args.at(-1)!.replace(/^label=/, "").split("=");
        return ok(images.filter((i) => i.labels[k!] === v).map((i) => i.id).join("\n"));
      }
      if (args[0] === "image" && args[1] === "rm") {
        const id = args.at(-1)!;
        images.splice(images.findIndex((i) => i.id === id), 1);
        return ok();
      }
      return ok();
    },
  };
  return { images, cfg: { docker, proxyDistHostPath: "/p", workerDistHostPath: "/w", agentApiPort: 4701, linuxHost: false } as SandboxConfig };
};

test("the copied snapshot carries the new session's label, so deleting the source leaves it intact", async () => {
  const { images, cfg } = imageStore();
  const snap = await copySnapshot(cfg, source(), "2026-10-07-new");
  expect(snap).toEqual({ image: "verstas-session-2026-10-07-new:latest", at: t, baseImageId: "sha256:base" });
  expect(images.find((i) => i.ref === snap!.image)!.labels["verstas.session"]).toBe("2026-10-07-new");
  await removeSnapshots(cfg, "2026-10-01-old");
  expect(images.map((i) => i.ref)).toEqual(["verstas-devbox:local", "verstas-session-2026-10-07-new:latest"]);
  // No usable snapshot (the base image changed since): nothing is built.
  const none = await copySnapshot(imageStore().cfg, source({ snapshot: { image: "verstas-session-2026-10-01-old:latest", at: t, baseImageId: "sha256:other" } }), "2026-10-07-x");
  expect(none).toBeUndefined();
});

test("a session is not started from an environment while the source has a run going, or before it is initialized", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "verstas-fromenv-api-"));
  const make = async (s: Session) => {
    const p = sessionPaths(root, s.id);
    await fs.mkdir(p.workspace, { recursive: true });
    await writeJsonAtomic(p.session, s);
    await saveBoard(p.dir, emptyBoard("g"));
    await writeJsonAtomic(p.inbox, inboxSchema.parse({}));
  };
  await make(source());
  await make(source({ id: "2026-10-02-plan", initializedAt: null }));
  const hub = new SessionHub(root);
  const deps = { hub, runs: { status: (id: string) => (id === "2026-10-01-old" ? { id: 3, state: "running" } : undefined) }, getConfig: () => ({ sessionsRoot: root, workTargets: [] }) } as unknown as UiApiDeps;
  const server = createUiApi(deps).listen(0, "127.0.0.1");
  const port = await new Promise<number>((r) => server.on("listening", () => r((server.address() as net.AddressInfo).port)));
  const post = (from: string) => fetch(`http://127.0.0.1:${port}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "New", fromEnvironment: { session: from } }) });
  try {
    const running = await post("2026-10-01-old");
    expect(running.status).toBe(409);
    expect(((await running.json()) as { error: string }).error).toContain("Pause or stop the run first");
    const plan = await post("2026-10-02-plan");
    expect(plan.status).toBe(409);
    expect(((await plan.json()) as { error: string }).error).toContain("not initialized");
    // Nothing was created for either.
    expect((await fs.readdir(root)).sort()).toEqual(["2026-10-01-old", "2026-10-02-plan"]);
  } finally {
    server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

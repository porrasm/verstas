import { test, expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import AdmZip from "adm-zip";
import { createSession, loadSession, provisionSession, saveSession, sessionPaths } from "../../src/sessions/sessions.js";
import { ARCHIVE_FORMAT, importArchive, readArchive, writeArchive } from "../../src/sessions/archive.js";
import { loadBoard, saveBoard, writeJsonAtomic } from "../../src/board/store.js";
import { emptyBoard } from "../../src/board/board.js";
import { replacementOf, type SandboxConfig } from "../../src/sandbox/lifecycle.js";
import type { DockerRunner } from "../../src/sandbox/docker.js";
import { sessionSchema } from "../../src/core/types.js";

const execFileP = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await execFileP("git", args, { cwd })).stdout.trim();

const makeSourceRepo = async (dir: string) => {
  await fs.mkdir(dir, { recursive: true });
  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "config", "user.name", "Owner");
  await git(dir, "config", "user.email", "owner@example.com");
  await fs.writeFile(path.join(dir, "README.md"), "hello\n");
  await fs.writeFile(path.join(dir, ".gitignore"), "node_modules/\n");
  await git(dir, "add", ".");
  await git(dir, "commit", "-q", "-m", "init");
};

/**
 * An initialized session the way a run leaves it: a ticket's commit on the
 * run branch, ignored build output, notes (with a link out of the
 * workspace), an attachment, and run history with an env file.
 */
const workedSession = async (tmp: string) => {
  const src = path.join(tmp, "src-repo");
  await makeSourceRepo(src);
  const root = path.join(tmp, "laptop");
  const zip = new AdmZip();
  zip.addFile("spec.md", Buffer.from("# spec\n"));
  const zipFile = path.join(tmp, "spec.zip");
  zip.writeZip(zipFile);
  const { session, paths } = await createSession(root, { name: "Nuppi", repos: [{ target: { name: "nuppi", path: src } }], zips: [{ name: "spec.zip", file: zipFile }], image: "verstas-devbox:local" });
  const { repos } = await provisionSession(root, session);
  const initialized = { ...session, repos, initializedAt: "2026-10-05T10:00:00.000Z", state: "paused" as const, snapshot: { image: "verstas-session-x:latest", at: "2026-10-05T10:00:00.000Z", baseImageId: "sha256:abc" }, remote: true };
  await saveSession(root, initialized);
  await saveBoard(paths.dir, { ...emptyBoard("the goal"), goal: "the goal" });

  const clone = path.join(paths.workspace, "nuppi");
  await fs.writeFile(path.join(clone, "work.txt"), "done by T-1\n");
  await git(clone, "add", ".");
  await git(clone, "commit", "-q", "-m", "T-1: work");
  await fs.mkdir(path.join(clone, "node_modules", "x"), { recursive: true });
  await fs.writeFile(path.join(clone, "node_modules", "x", "index.js"), "big\n");

  await fs.writeFile(path.join(paths.notes, "brief.md"), "the brief\n");
  await fs.writeFile(path.join(paths.notes, "setup.sh"), "#!/bin/bash\nsudo true\n", { mode: 0o755 });
  await fs.symlink("/etc/hosts", path.join(paths.notes, "leak"));
  await fs.mkdir(path.join(paths.workspace, ".verstas"), { recursive: true });
  await fs.writeFile(path.join(paths.workspace, ".verstas", "scratch"), "x");

  await fs.mkdir(path.join(paths.runs, "1", "tickets"), { recursive: true });
  await writeJsonAtomic(path.join(paths.runs, "1", "run.json"), { id: 1, sessionId: session.id, startedAt: "2026-10-05T10:00:00.000Z", state: "running", ticketsDone: 1, cost: { inputTokens: 0, outputTokens: 0 } });
  await fs.writeFile(path.join(paths.runs, "1", "events.jsonl"), "{}\n");
  await fs.writeFile(path.join(paths.runs, "1", "tickets", "T-1.md"), "report\n");
  await fs.writeFile(path.join(paths.runs, "1", "env"), "TOKEN=secret\n");

  // What the export route does in the container: a bundle of every ref.
  const bundle = path.join(paths.exportDir, "nuppi.bundle");
  await git(clone, "bundle", "create", bundle, "--all");
  return { root, src, session: initialized, paths, bundle, head: await git(clone, "rev-parse", "HEAD") };
};

test("a worked session goes through an archive to another machine: clones at the run branch, notes, history; no environment", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "verstas-archive-"));
  try {
    const w = await workedSession(tmp);
    const out = path.join(w.paths.exportDir, `${w.session.id}.ver`);
    const written = await writeArchive({ root: w.root, session: w.session, bundles: [{ repo: "nuppi", file: w.bundle }], outFile: out, verstasVersion: "0.1.0" });
    expect(written.skipped).toEqual(["notes/leak: symlink"]);

    const names = new AdmZip(out).getEntries().map((e) => e.entryName).sort();
    expect(names).toContain("repos/nuppi.bundle");
    expect(names).toContain("workspace/notes/brief.md");
    expect(names).toContain("workspace/attachments/spec/spec.md");
    expect(names).toContain("runs/1/tickets/T-1.md");
    expect(names.some((n) => n.startsWith("workspace/nuppi/"))).toBe(false);
    expect(names.some((n) => n.startsWith("workspace/.verstas"))).toBe(false);
    expect(names).not.toContain("runs/1/env");
    expect(names).not.toContain("workspace/notes/leak");

    // The other machine has its own image and a work target of the same name somewhere else.
    const vps = path.join(tmp, "vps");
    const there = path.join(tmp, "vps-repos", "nuppi");
    const r = await importArchive({ root: vps, file: out, id: w.session.id, workTargets: [{ name: "nuppi", path: there }], image: "verstas-devbox:vps" });
    expect(r.unmapped).toEqual([]);
    const s = await loadSession(vps, w.session.id);
    expect(s.initializedAt).toBeNull();
    expect(s.state).toBe("setup");
    expect(s.snapshot).toBeUndefined();
    expect(s.image).toBe("verstas-devbox:vps");
    expect(s.remote).toBe(true);
    expect(s.repos[0]).toMatchObject({ name: "nuppi", sourcePath: there, runBranch: `verstas/${w.session.id}`, baseCommit: w.session.repos[0]!.baseCommit });
    expect(s.attachments.map((a) => a.dir)).toEqual(["spec"]);

    const p = sessionPaths(vps, w.session.id);
    const clone = path.join(p.workspace, "nuppi");
    expect(await git(clone, "rev-parse", "HEAD")).toBe(w.head);
    expect(await git(clone, "branch", "--show-current")).toBe(`verstas/${w.session.id}`);
    expect(await git(clone, "status", "--porcelain")).toBe("");
    expect(await git(clone, "remote")).toBe("");
    expect(await fs.readdir(path.join(clone, ".git", "hooks")).catch(() => [])).toEqual([]);
    await expect(fs.access(path.join(clone, "node_modules"))).rejects.toThrow();
    expect(await fs.readFile(path.join(p.notes, "brief.md"), "utf8")).toBe("the brief\n");
    expect((await fs.stat(path.join(p.notes, "setup.sh"))).mode & 0o111).toBeTruthy();
    expect(await fs.readFile(path.join(p.attachments, "spec", "spec.md"), "utf8")).toBe("# spec\n");
    expect((await loadBoard(p.dir)).goal).toBe("the goal");
    const run = JSON.parse(await fs.readFile(path.join(p.runs, "1", "run.json"), "utf8"));
    expect(run.state).toBe("stopped");
    await expect(fs.access(path.join(p.runs, "1", "env"))).rejects.toThrow();
    expect(JSON.parse(await fs.readFile(p.allowlist, "utf8"))).toEqual(s.allowlist);
    // Nothing is left beside the session.
    expect((await fs.readdir(vps)).filter((n) => n.startsWith("."))).toEqual([]);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("import: an existing id is refused, a copy takes a new id, replace swaps the session and removes its environment", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "verstas-archive-"));
  try {
    const w = await workedSession(tmp);
    const out = path.join(tmp, "s.ver");
    await writeArchive({ root: w.root, session: w.session, bundles: [{ repo: "nuppi", file: w.bundle }], outFile: out });

    await expect(importArchive({ root: w.root, file: out, id: w.session.id, workTargets: [], image: "img" })).rejects.toThrow(/exists here already/);
    expect((await fs.readdir(w.root)).filter((n) => n.startsWith("."))).toEqual([]);

    const copy = await importArchive({ root: w.root, file: out, id: `${w.session.id}-2`, name: "Nuppi (copy)", workTargets: [], image: "img" });
    expect(copy.session.id).toBe(`${w.session.id}-2`);
    expect((await loadSession(w.root, copy.session.id)).name).toBe("Nuppi (copy)");
    expect(copy.unmapped).toEqual(["nuppi"]);
    // No work target here: the recorded path stays, for the record.
    expect(copy.session.repos[0]!.sourcePath).toBe(w.src);
    const run = JSON.parse(await fs.readFile(path.join(sessionPaths(w.root, copy.session.id).runs, "1", "run.json"), "utf8"));
    expect(run.sessionId).toBe(copy.session.id);

    // Replace: the old directory goes, including what only it had.
    await fs.writeFile(path.join(w.paths.notes, "only-here.md"), "old\n");
    let removed = 0;
    await importArchive({ root: w.root, file: out, id: w.session.id, workTargets: [], image: "img", replace: { removeEnvironment: async () => void removed++ } });
    expect(removed).toBe(1);
    await expect(fs.access(path.join(w.paths.notes, "only-here.md"))).rejects.toThrow();
    expect((await loadSession(w.root, w.session.id)).image).toBe("img");
    expect((await fs.readdir(w.root)).filter((n) => n.startsWith("."))).toEqual([]);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("import replace keeping the environment: the snapshot record stays on the imported session; without it, none", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "verstas-archive-"));
  try {
    const w = await workedSession(tmp);
    const out = path.join(tmp, "s.ver");
    await writeArchive({ root: w.root, session: w.session, bundles: [{ repo: "nuppi", file: w.bundle }], outFile: out });
    const snapshot = { image: `verstas-session-${w.session.id}:latest`, at: "2026-10-06T00:00:00.000Z", baseImageId: "sha256:base" };
    await importArchive({ root: w.root, file: out, id: w.session.id, workTargets: [], image: "img", replace: { removeEnvironment: async () => undefined, snapshot } });
    const kept = await loadSession(w.root, w.session.id);
    expect(kept.snapshot).toEqual(snapshot);
    // Still a plan: Initialize runs the setup worker against the imported board and requirements.
    expect(kept.initializedAt).toBeNull();
    expect(kept.readiness).toBeUndefined();
    await importArchive({ root: w.root, file: out, id: w.session.id, workTargets: [], image: "img", replace: { removeEnvironment: async () => undefined } });
    expect((await loadSession(w.root, w.session.id)).snapshot).toBeUndefined();
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("replacementOf: keeping the environment removes only the container, proxy and network; otherwise the volume and snapshots go too", async () => {
  const session = sessionSchema.parse({ id: "2026-10-06-keep", name: "k", createdAt: "2026-10-06T00:00:00.000Z", snapshot: { image: "verstas-session-2026-10-06-keep:latest", at: "2026-10-06T00:00:00.000Z", baseImageId: "sha256:b" } });
  const calls: string[][] = [];
  const docker: DockerRunner = {
    spawn: () => {
      throw new Error("no spawn");
    },
    async run(args) {
      calls.push([...args]);
      return { code: 0, stdout: args[0] === "image" && args[1] === "ls" ? "sha256:snap\n" : "", stderr: "" };
    },
  };
  const cfg = { docker, proxyDistHostPath: "/p", workerDistHostPath: "/w", agentApiPort: 4701, linuxHost: false } as SandboxConfig;
  const keep = replacementOf(cfg, session, true);
  expect(keep.snapshot).toEqual(session.snapshot);
  await keep.removeEnvironment();
  const kept = calls.map((c) => c.join(" "));
  expect(kept.some((c) => c.includes("verstas-2026-10-06-keep-proxy"))).toBe(true);
  expect(kept.some((c) => c.startsWith("network rm"))).toBe(true);
  expect(kept.some((c) => c.startsWith("volume rm") || c.startsWith("image"))).toBe(false);
  calls.length = 0;
  const all = replacementOf(cfg, session, false);
  expect(all.snapshot).toBeUndefined();
  await all.removeEnvironment();
  const gone = calls.map((c) => c.join(" "));
  expect(gone).toContain("volume rm -f verstas-2026-10-06-keep-home");
  expect(gone).toContain("image rm -f sha256:snap");
});

test("a plan travels without bundles; its picks point at this machine's work targets", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "verstas-archive-"));
  try {
    const src = path.join(tmp, "src-repo");
    await makeSourceRepo(src);
    const root = path.join(tmp, "a");
    const { session } = await createSession(root, { name: "Plan", repos: [{ target: { name: "nuppi", path: src } }], zips: [], image: "img" });
    const out = path.join(tmp, "p.ver");
    await writeArchive({ root, session, bundles: [], outFile: out });
    expect(readArchive(out).manifest).toMatchObject({ initialized: false, repos: [{ name: "nuppi", runBranch: `verstas/${session.id}` }] });
    const r = await importArchive({ root: path.join(tmp, "b"), file: out, id: session.id, workTargets: [{ name: "nuppi", path: "/elsewhere/nuppi" }], image: "img" });
    expect(r.session.repos[0]!.sourcePath).toBe("/elsewhere/nuppi");
    await expect(fs.access(path.join(sessionPaths(path.join(tmp, "b"), session.id).workspace, "nuppi"))).rejects.toThrow();
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("readArchive refuses what is not a session archive or is too new; import skips entries outside a session", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "verstas-archive-"));
  try {
    const plain = path.join(tmp, "plain.zip");
    const z = new AdmZip();
    z.addFile("readme.txt", Buffer.from("x"));
    z.writeZip(plain);
    expect(() => readArchive(plain)).toThrow(/manifest.json is missing/);

    const src = path.join(tmp, "src-repo");
    await makeSourceRepo(src);
    const root = path.join(tmp, "a");
    const { session } = await createSession(root, { name: "Plan", repos: [], zips: [], image: "img" });
    const out = path.join(tmp, "p.ver");
    await writeArchive({ root, session, bundles: [], outFile: out });

    const newer = new AdmZip(out);
    newer.updateFile("manifest.json", Buffer.from(JSON.stringify({ ...readArchive(out).manifest, version: 99 })));
    newer.writeZip(path.join(tmp, "newer.ver"));
    expect(() => readArchive(path.join(tmp, "newer.ver"))).toThrow(/version 99/);

    // adm-zip cleans `..` out of names it writes (a crafted zip is covered by entryProblem's own test); either way nothing lands outside.
    const evil = new AdmZip(out);
    evil.addFile("workspace/../../escape.txt", Buffer.from("x"));
    evil.addFile("elsewhere/file.txt", Buffer.from("x"));
    evil.addFile("workspace/notes/ok.md", Buffer.from("ok"));
    evil.writeZip(path.join(tmp, "evil.ver"));
    expect(readArchive(path.join(tmp, "evil.ver")).manifest.format).toBe(ARCHIVE_FORMAT);
    const r = await importArchive({ root: path.join(tmp, "b"), file: path.join(tmp, "evil.ver"), id: session.id, workTargets: [], image: "img" });
    expect(r.skipped.sort()).toEqual(["elsewhere/file.txt: not part of a session", "escape.txt: not part of a session"]);
    await expect(fs.access(path.join(tmp, "escape.txt"))).rejects.toThrow();
    expect(await fs.readFile(path.join(sessionPaths(path.join(tmp, "b"), session.id).notes, "ok.md"), "utf8")).toBe("ok");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

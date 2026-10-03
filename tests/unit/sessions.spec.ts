import { test, expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import zlib from "node:zlib";
import AdmZip from "adm-zip";
import {
  createSession,
  deleteSessionDir,
  listSessions,
  loadSession,
  makeSessionId,
  sessionPaths,
} from "../../src/sessions/sessions.js";
import { entryProblem, extractZip } from "../../src/sessions/workspace.js";
import { migrateInbox } from "../../src/sessions/sessions.js";
import { applyBundle, ApplyError } from "../../src/sessions/apply.js";
import { inboxSchema } from "../../src/core/types.js";
import { DEFAULT_ALLOWLIST } from "../../src/core/types.js";

const execFileP = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await execFileP("git", args, { cwd })).stdout.trim();

/** A source repo the way a real work target looks: ignored secrets, a live hook, two branches. */
const makeSourceRepo = async (dir: string) => {
  await fs.mkdir(dir, { recursive: true });
  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "config", "user.name", "Owner");
  await git(dir, "config", "user.email", "owner@example.com");
  await fs.writeFile(path.join(dir, "README.md"), "hello\n");
  await fs.writeFile(path.join(dir, ".gitignore"), ".env\n");
  await fs.writeFile(path.join(dir, ".env"), "SECRET=1\n");
  await git(dir, "add", ".");
  await git(dir, "commit", "-q", "-m", "init");
  await fs.writeFile(path.join(dir, ".git", "hooks", "pre-commit"), "#!/bin/sh\necho hook\n", { mode: 0o755 });
  await git(dir, "checkout", "-q", "-b", "feature");
  await fs.writeFile(path.join(dir, "feature.txt"), "f\n");
  await git(dir, "add", ".");
  await git(dir, "commit", "-q", "-m", "feature");
  await git(dir, "checkout", "-q", "main");
};

test("createSession clones fresh, without secrets, hooks, origin or other branches", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "verstas-sessions-"));
  const src = path.join(tmp, "src-repo");
  await makeSourceRepo(src);
  const root = path.join(tmp, "sessions");
  try {
    const { session, paths, clones } = await createSession(root, {
      name: "Nuppi MVP",
      goal: "Build it",
      repos: [{ target: { name: "nuppi", path: src } }],
      zips: [],
      image: "verstas-devbox:local",
    });
    expect(session.id).toMatch(/^\d{4}-\d{2}-\d{2}-nuppi-mvp$/);
    const clone = path.join(paths.workspace, "nuppi");
    expect(await fs.readFile(path.join(clone, "README.md"), "utf8")).toBe("hello\n");
    await expect(fs.access(path.join(clone, ".env"))).rejects.toThrow();
    await expect(fs.access(path.join(clone, ".git", "hooks", "pre-commit"))).rejects.toThrow();
    // No template hooks either (not even the .sample files).
    const hooks = await fs.readdir(path.join(clone, ".git", "hooks")).catch(() => []);
    expect(hooks).toEqual([]);
    expect(await git(clone, "remote")).toBe("");
    expect(await git(clone, "branch", "--show-current")).toBe(`verstas/${session.id}`);
    expect(await git(clone, "branch", "--list", "feature")).toBe("");
    expect(await git(clone, "config", "user.name")).toBe("Verstas");
    expect(clones[0]?.commit).toBe(await git(src, "rev-parse", "main"));
    // Self-contained: no alternates pointing back at the source.
    await expect(fs.access(path.join(clone, ".git", "objects", "info", "alternates"))).rejects.toThrow();
    // Session files.
    expect(JSON.parse(await fs.readFile(paths.allowlist, "utf8"))).toEqual([...DEFAULT_ALLOWLIST]);
    const loaded = await loadSession(root, session.id);
    expect(loaded.repos[0]).toMatchObject({ name: "nuppi", branch: "main", runBranch: `verstas/${session.id}` });
    expect((await listSessions(root)).map((s) => s.id)).toEqual([session.id]);
    // A second session with the same name gets a suffix.
    expect(await makeSessionId(root, "Nuppi MVP")).toBe(`${session.id}-2`);
    // Delete, and refuse to delete outside the root.
    await deleteSessionDir(root, session.id);
    await expect(fs.access(paths.dir)).rejects.toThrow();
    await expect(deleteSessionDir(root, "..")).rejects.toThrow();
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("createSession rejects a non-repo target and cleans up after itself", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "verstas-sessions-"));
  const root = path.join(tmp, "sessions");
  try {
    await expect(
      createSession(root, { name: "x", goal: "", repos: [{ target: { name: "nope", path: tmp } }], zips: [], image: "i" }),
    ).rejects.toThrow(/not a git work tree/);
    expect(await listSessions(root)).toEqual([]);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

/**
 * adm-zip sanitises names on addFile, so a hostile archive has to be built
 * by hand: stored entries, no compression, with the exact names and
 * external attributes an attacker would write.
 */
const buildZip = (entries: { name: string; data: Buffer; attr?: number }[]): Buffer => {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const crc = zlib.crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(e.data.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by unix
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(e.data.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(e.attr ?? 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, e.data);
    centrals.push(central, name);
    offset += local.length + name.length + e.data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
};

test("extractZip skips traversal, absolute names and symlinks, keeps the rest", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "verstas-zip-"));
  try {
    const file = path.join(tmp, "a.zip");
    await fs.writeFile(
      file,
      buildZip([
        { name: "ok.txt", data: Buffer.from("ok") },
        { name: "dir/nested.txt", data: Buffer.from("nested") },
        { name: "../evil.txt", data: Buffer.from("evil") },
        { name: "/abs.txt", data: Buffer.from("abs") },
        { name: "link", data: Buffer.from("/etc/passwd"), attr: (0o120777 << 16) >>> 0 },
      ]),
    );
    // Sanity: the archive really carries the hostile names.
    expect(new AdmZip(file).getEntries().map((e) => e.entryName)).toEqual(["ok.txt", "dir/nested.txt", "../evil.txt", "/abs.txt", "link"]);
    const dest = path.join(tmp, "out");
    const r = await extractZip(file, dest);
    expect(r.files).toBe(2);
    expect(r.bytes).toBe(8);
    expect(r.skipped.map((s) => s.split(":")[0])).toEqual(["../evil.txt", "/abs.txt", "link"]);
    expect(await fs.readFile(path.join(dest, "ok.txt"), "utf8")).toBe("ok");
    expect(await fs.readFile(path.join(dest, "dir", "nested.txt"), "utf8")).toBe("nested");
    await expect(fs.access(path.join(tmp, "evil.txt"))).rejects.toThrow();
    await expect(fs.access(path.join(dest, "link"))).rejects.toThrow();
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("entryProblem names each rejection", () => {
  expect(entryProblem("a/b.txt", 0, 10)).toBeNull();
  expect(entryProblem("/etc/x", 0, 1)).toBe("absolute path");
  expect(entryProblem("C:/x", 0, 1)).toBe("absolute path");
  expect(entryProblem("a/../../x", 0, 1)).toBe("parent directory segment");
  expect(entryProblem("ok/..x", 0, 1)).toBeNull();
  expect(entryProblem("l", (0o120644 << 16) >>> 0, 1)).toBe("symlink");
  expect(entryProblem("big", 0, 300 * 1024 * 1024)).toBe("file too large");
});

test("sessionPaths validates the id", () => {
  expect(() => sessionPaths("/root", "../x")).toThrow(/Bad session id/);
  expect(sessionPaths("/root", "2026-10-03-a").workspace).toBe("/root/2026-10-03-a/workspace");
});

test("old request shapes are migrated on load into summary plus actions", () => {
  const old = {
    requests: [
      { id: "R-1", detail: { kind: "install", manager: "apt", packages: ["tree", "jq"] }, why: "x", state: "open", createdAt: "2026-10-03T00:00:00.000Z" },
      { id: "R-2", detail: { kind: "decision", question: "which cc?" }, why: "y", state: "approved", answer: "11", createdAt: "2026-10-03T00:00:00.000Z", decidedAt: "2026-10-03T00:01:00.000Z" },
      { id: "R-3", detail: { kind: "network", host: "example.com" }, why: "z", state: "denied", createdAt: "2026-10-03T00:00:00.000Z" },
      { id: "R-4", detail: { kind: "halt", reason: "stop", severity: "critical" }, why: "h", state: "open", createdAt: "2026-10-03T00:00:00.000Z" },
    ],
  };
  const inbox = inboxSchema.parse(migrateInbox(old));
  expect(inbox.requests.map((r) => [r.id, r.state, r.actions.map((a) => `${a.detail.kind}:${a.state}`).join(","), Boolean(r.halt)])).toEqual([
    ["R-1", "open", "root_script:open", false],
    ["R-2", "resolved", "question:approved", false],
    ["R-3", "resolved", "network:declined", false],
    ["R-4", "open", "", true],
  ]);
  expect(inbox.requests[0]!.actions[0]!.detail).toMatchObject({ script: "apt-get update && apt-get install -y --no-install-recommends tree jq" });
  expect(inbox.requests[1]!.answer).toBe("11");
  // Already-new shapes pass through untouched.
  expect(inboxSchema.parse(migrateInbox(inbox)).requests).toEqual(inbox.requests);
});

test("setup scripts are copied into the session and their hosts join the allowlist", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "verstas-sessions-"));
  const src = path.join(tmp, "src-repo");
  await makeSourceRepo(src);
  const root = path.join(tmp, "sessions");
  try {
    const { session, paths } = await createSession(root, {
      name: "with scripts",
      goal: "",
      repos: [{ target: { name: "app", path: src } }],
      zips: [],
      image: "i",
      setupScripts: [
        { name: "postgres", description: "", hosts: ["deb.debian.org"], note: "pg at /usr/lib/postgresql", script: "apt-get install -y postgresql\n", runAs: "root", env: "" },
        { name: "apps", description: "", hosts: [], note: "", script: "sudo true\n", runAs: "agent", env: "# Environment\n- pg on 5432\n" },
      ],
    });
    expect(await fs.readFile(path.join(paths.notes, "env.md"), "utf8")).toContain("<!-- from recipe apps;");
    expect(session.allowlist).toContain("deb.debian.org");
    expect(session.allowlist).toContain("api.anthropic.com");
    expect(session.setupScripts[0]!.name).toBe("postgres");
    expect(await fs.readFile(path.join(paths.setup, "postgres.sh"), "utf8")).toBe("apt-get install -y postgresql\n");
    expect(session.setup).toEqual([]);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("applyBundle creates and updates the feature branch in the real repo without moving the current branch", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "verstas-apply-"));
  const src = path.join(tmp, "src-repo");
  await makeSourceRepo(src);
  const root = path.join(tmp, "sessions");
  try {
    const { session, paths } = await createSession(root, { name: "apply", goal: "", repos: [{ target: { name: "app", path: src } }], zips: [], image: "i" });
    const clone = path.join(paths.workspace, "app");
    const branch = session.repos[0]!.runBranch;
    // The harness's work, simulated: two ticket commits in the clone, then a bundle (in production both happen inside the container).
    await fs.writeFile(path.join(clone, "a.txt"), "a\n");
    await git(clone, "add", "-A");
    await git(clone, "commit", "-q", "-m", "T-1: first");
    const bundle = path.join(paths.exportDir, "app.bundle");
    await git(clone, "bundle", "create", bundle, "--all");

    const before = await git(src, "rev-parse", "HEAD");
    const r1 = await applyBundle({ targetPath: src, bundleFile: bundle, branch, baseCommit: session.repos[0]!.baseCommit, sourceBranch: "main" });
    expect(r1.commits.map((c) => c.subject)).toEqual(["T-1: first"]);
    expect(await git(src, "rev-parse", "HEAD")).toBe(before); // main untouched
    expect(await git(src, "branch", "--show-current")).toBe("main");
    expect(await git(src, "rev-parse", branch)).toBe(await git(clone, "rev-parse", branch));
    expect(r1.howTo[0]).toContain(src);

    // A second ticket, applied again: the branch moves forward.
    await fs.writeFile(path.join(clone, "b.txt"), "b\n");
    await git(clone, "add", "-A");
    await git(clone, "commit", "-q", "-m", "T-2: second");
    await git(clone, "bundle", "create", bundle, "--all");
    const r2 = await applyBundle({ targetPath: src, bundleFile: bundle, branch, baseCommit: session.repos[0]!.baseCommit });
    expect(r2.commits.map((c) => c.subject)).toEqual(["T-2: second", "T-1: first"]);

    // Checked out: refuse rather than move the user's working tree.
    await git(src, "switch", "-q", branch);
    await expect(applyBundle({ targetPath: src, bundleFile: bundle, branch })).rejects.toThrow(ApplyError);
    await git(src, "switch", "-q", "main");
    // Not a repo any more: a clear error.
    await expect(applyBundle({ targetPath: tmp, bundleFile: bundle, branch })).rejects.toThrow(/not a git work tree/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("sessions from before the setup phase migrate: the init-check tick becomes requirements, a passed check counts as confirmed", async () => {
  const { migrateSession, LEGACY_PREFLIGHT_REQUIREMENTS } = await import("../../src/sessions/sessions.js");
  const { sessionSchema, needsSetup } = await import("../../src/core/types.js");
  const base = { id: "2026-10-03-old", name: "old", goal: "g", createdAt: "2026-10-03T10:00:00Z" };
  const passed = sessionSchema.parse(migrateSession({ ...base, caps: { preflight: true }, preflight: { ok: true, at: "2026-10-03T11:00:00Z", summary: "fine" } }));
  expect(passed.requirements).toBe(LEGACY_PREFLIGHT_REQUIREMENTS);
  expect(passed.readiness).toMatchObject({ verdict: "ready", confirmedAt: "2026-10-03T11:00:00Z" });
  expect(needsSetup(passed)).toBe(false);
  const failed = sessionSchema.parse(migrateSession({ ...base, caps: { preflight: true }, preflight: { ok: false, at: "2026-10-03T11:00:00Z", summary: "no pg" } }));
  expect(needsSetup(failed)).toBe(true);
  const plain = sessionSchema.parse(migrateSession({ ...base, caps: { preflight: false } }));
  expect(plain.requirements).toBe("");
  expect(needsSetup(plain)).toBe(false);
  expect("preflight" in plain.caps).toBe(false);
});

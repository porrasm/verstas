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

test("old request kinds are migrated on load", () => {
  const old = {
    requests: [
      { id: "R-1", detail: { kind: "install", manager: "apt", packages: ["tree", "jq"] }, why: "x", state: "open", createdAt: "2026-10-03T00:00:00.000Z" },
      { id: "R-2", detail: { kind: "decision", question: "which cc?" }, why: "x", state: "approved", answer: "11", createdAt: "2026-10-03T00:00:00.000Z" },
      { id: "R-3", detail: { kind: "network", host: "example.com" }, why: "x", state: "open", createdAt: "2026-10-03T00:00:00.000Z" },
    ],
  };
  const inbox = inboxSchema.parse(migrateInbox(old));
  expect(inbox.requests.map((r) => r.detail.kind)).toEqual(["root_command", "ask", "network"]);
  expect(inbox.requests[0]!.detail).toMatchObject({ command: "apt-get update && apt-get install -y --no-install-recommends tree jq" });
  expect(inbox.requests[1]!.detail).toMatchObject({ what: "which cc?" });
});

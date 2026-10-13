import { test, expect } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { addArtifact, ARTIFACT_MAX_COUNT, artifactFile, artifactName, clearArtifacts, deleteArtifact, loadArtifacts, sniffArtifact } from "../../src/sessions/artifacts.js";
import { copyFromSandbox, type SandboxConfig } from "../../src/sandbox/lifecycle.js";
import type { DockerRunner } from "../../src/sandbox/docker.js";

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "verstas-art-"));

test("an artifact's name is the last path part in plain characters", () => {
  expect(artifactName("/workspace/app/out/report.md")).toBe("report.md");
  expect(artifactName("..")).toBe("artifact");
  expect(artifactName("../../etc/passwd")).toBe("passwd");
  expect(artifactName('.hidden"<script>.txt')).toBe("hidden-script-.txt");
  expect(artifactName("a\\b\\c.png")).toBe("c.png");
  expect(artifactName("x".repeat(300))).toHaveLength(120);
});

test("the kind comes from the bytes: raster images, UTF-8 text, else a download; SVG and HTML are text", () => {
  expect(sniffArtifact(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toEqual({ kind: "image", mime: "image/png" });
  expect(sniffArtifact(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0]))).toEqual({ kind: "image", mime: "image/jpeg" });
  expect(sniffArtifact(Buffer.from("GIF89a\0\0"))).toEqual({ kind: "image", mime: "image/gif" });
  expect(sniffArtifact(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))).toEqual({ kind: "image", mime: "image/webp" });
  expect(sniffArtifact(Buffer.from("héllo ✓\n"))).toEqual({ kind: "text", mime: "text/plain; charset=utf-8" });
  expect(sniffArtifact(Buffer.from('<svg onload="alert(1)"/>')).kind).toBe("text");
  expect(sniffArtifact(Buffer.from("<html><script>x</script>")).kind).toBe("text");
  expect(sniffArtifact(Buffer.from([0x61, 0, 0x62])).kind).toBe("file");
  expect(sniffArtifact(Buffer.from([0xc3, 0x28])).kind).toBe("file");
  expect(sniffArtifact(Buffer.from("text"), 10 * 1024 * 1024).kind).toBe("file");
});

test("publishing a name again replaces it; the count is capped; deleting one or all removes the files", async () => {
  const dir = path.join(await tmp(), "artifacts");
  const put = (name: string, body: string) => addArtifact(dir, { name, runId: 1, now: "2026-10-13T00:00:00Z" }, async (f) => (await fs.writeFile(f, body), Buffer.byteLength(body)));
  try {
    const a = await put("/tmp/report.md", "one");
    const b = await put("/workspace/report.md", "two");
    expect(b.id).not.toBe(a.id);
    const list = await loadArtifacts(dir);
    expect(list.map((x) => x.name)).toEqual(["report.md"]);
    expect(await fs.readFile((await artifactFile(dir, b.id))!.file, "utf8")).toBe("two");
    expect(await artifactFile(dir, a.id)).toBeNull();
    await expect(fs.access(path.join(dir, a.id))).rejects.toThrow();
    // Two publishes at once keep both.
    await Promise.all([put("x.txt", "x"), put("y.txt", "y")]);
    expect((await loadArtifacts(dir)).map((x) => x.name).sort()).toEqual(["report.md", "x.txt", "y.txt"]);
    for (let i = 3; i < ARTIFACT_MAX_COUNT; i++) await put(`f${i}.txt`, "f");
    await expect(put("one-too-many.txt", "z")).rejects.toThrow(/50 artifacts/);
    const x = await put("x.txt", "replaced still fits");
    expect(await deleteArtifact(dir, x.id)).toBe(true);
    expect(await deleteArtifact(dir, x.id)).toBe(false);
    await expect(fs.access(path.join(dir, x.id))).rejects.toThrow();
    await put("fits again.txt", "after a delete");
    await clearArtifacts(dir);
    expect(await loadArtifacts(dir)).toEqual([]);
    // A failed copy leaves nothing behind in the index.
    await expect(addArtifact(dir, { name: "bad", runId: 1, now: "t" }, async () => { throw new Error("not a readable file"); })).rejects.toThrow(/readable/);
    expect(await loadArtifacts(dir)).toEqual([]);
  } finally {
    await fs.rm(path.dirname(dir), { recursive: true, force: true });
  }
});

/** A docker that runs the exec's command locally, in `cwd`: the copy-out script is what is tested. */
const localDocker = (cwd: string): DockerRunner =>
  ({
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
    spawn: (args: readonly string[]): ChildProcess => {
      const at = args.indexOf("sh");
      return spawn("sh", args.slice(at + 1), { cwd, stdio: ["pipe", "pipe", "pipe"] });
    },
  }) as unknown as DockerRunner;

test("copyFromSandbox copies a regular file, refuses a directory, a missing file and one over the limit, and leaves nothing on failure", async () => {
  const box = await tmp();
  const out = await tmp();
  const cfg = { docker: localDocker(box) } as unknown as SandboxConfig;
  try {
    await fs.writeFile(path.join(box, "a.bin"), Buffer.alloc(3000, 7));
    await fs.mkdir(path.join(box, "d"));
    // A symlink resolves where the command runs (inside the container in real use).
    await fs.symlink("a.bin", path.join(box, "link"));
    expect(await copyFromSandbox(cfg, "s", "a.bin", path.join(out, "1"), 5000)).toBe(3000);
    expect((await fs.readFile(path.join(out, "1"))).equals(Buffer.alloc(3000, 7))).toBe(true);
    expect(await copyFromSandbox(cfg, "s", "link", path.join(out, "2"), 5000)).toBe(3000);
    await expect(copyFromSandbox(cfg, "s", "d", path.join(out, "3"), 5000)).rejects.toThrow(/not a readable file/);
    await expect(copyFromSandbox(cfg, "s", "nope", path.join(out, "4"), 5000)).rejects.toThrow(/not a readable file/);
    await expect(copyFromSandbox(cfg, "s", "a.bin", path.join(out, "5"), 100)).rejects.toThrow(/limit/);
    // Never over an existing host file.
    await expect(copyFromSandbox(cfg, "s", "a.bin", path.join(out, "1"), 5000)).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 50));
    expect((await fs.readdir(out)).sort()).toEqual(["1", "2"]);
  } finally {
    await fs.rm(box, { recursive: true, force: true });
    await fs.rm(out, { recursive: true, force: true });
  }
});

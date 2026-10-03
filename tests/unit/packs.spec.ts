import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { allowlistFor, DEFAULT_PACKS, detectPacks, detectPacksInRepo, packHosts } from "../../src/network/packs.js";
import { actionDetailSchema, DEFAULT_ALLOWLIST } from "../../src/core/types.js";

test("the default packs cover the old default allowlist", () => {
  for (const h of ["api.anthropic.com", "registry.npmjs.org", "pypi.org", "files.pythonhosted.org", "github.com", "objects.githubusercontent.com", "deb.debian.org", "security.debian.org"]) {
    expect(DEFAULT_ALLOWLIST).toContain(h);
  }
  expect(packHosts(DEFAULT_PACKS)[0]).toBe("api.anthropic.com");
});

test("the Claude API is always in, packs and extras are merged without duplicates", () => {
  expect(allowlistFor([])).toEqual(["api.anthropic.com"]);
  const list = allowlistFor(["playwright", "go", "chromium"], ["fonts.googleapis.com", " ", "cdn.playwright.dev"]);
  expect(list).toContain("cdn.playwright.dev");
  expect(list).toContain("fonts.googleapis.com");
  expect(list.filter((h) => h === "storage.googleapis.com")).toHaveLength(1);
  expect(list.filter((h) => h === "cdn.playwright.dev")).toHaveLength(1);
});

test("packs are detected from manifests as data", () => {
  expect(detectPacks([{ path: "package.json", text: JSON.stringify({ devDependencies: { "@playwright/test": "^1.50.0", cypress: "13" } }) }])).toEqual(["node", "playwright", "cypress"]);
  expect(detectPacks([{ path: "apps/web/package.json", text: JSON.stringify({ dependencies: { puppeteer: "22", lib: "user/repo#main" } }) }])).toEqual(["node", "github", "chromium"]);
  expect(detectPacks([{ path: "package.json", text: "{ not json" }])).toEqual(["node"]);
  expect(detectPacks([{ path: "requirements-dev.txt", text: "pytest\nplaywright==1.48\n" }])).toEqual(["python", "playwright"]);
  expect(detectPacks([{ path: "svc/go.mod", text: "module x" }, { path: "Cargo.toml", text: "" }, { path: "build.gradle.kts", text: "" }, { path: "Gemfile", text: "" }])).toEqual(["rust", "go", "jvm", "ruby"]);
  expect(detectPacks([{ path: "README.md", text: "playwright" }])).toEqual([]);
});

test("detection reads tracked manifests of a git work tree and skips node_modules", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "verstas-packs-"));
  try {
    const git = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe" });
    git("init", "-q");
    await fs.mkdir(path.join(dir, "e2e"), { recursive: true });
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ workspaces: ["e2e"] }));
    await fs.writeFile(path.join(dir, "e2e", "package.json"), JSON.stringify({ devDependencies: { "@playwright/test": "1" } }));
    await fs.writeFile(path.join(dir, "untracked-Cargo.toml"), "");
    git("add", "package.json", "e2e/package.json");
    expect(await detectPacksInRepo(dir)).toEqual(["node", "playwright"]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a pack request names a known pack", () => {
  expect(actionDetailSchema.parse({ kind: "pack", pack: "playwright" })).toEqual({ kind: "pack", pack: "playwright" });
  expect(() => actionDetailSchema.parse({ kind: "pack", pack: "everything" })).toThrow();
});

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

/**
 * Network packs: named bundles of hosts a toolchain needs, so a session
 * starts with the hosts its repositories will reach instead of discovering
 * them one parked ticket at a time. A session's allowlist is the union of
 * its packs and any extra hosts; the proxy only ever sees that flat list.
 *
 * Every host here is a download host for a public toolchain. Each one is
 * still a place data can go (docs/SANDBOX.md, Residual risks), which is why
 * packs are ticked per session and shown with their hosts.
 */

export type NetworkPack = { name: string; title: string; hosts: readonly string[] };

export const NETWORK_PACKS = [
  { name: "anthropic", title: "Claude API (always on)", hosts: ["api.anthropic.com"] },
  { name: "node", title: "npm, Yarn, Node.js headers", hosts: ["registry.npmjs.org", "registry.yarnpkg.com", "repo.yarnpkg.com", "nodejs.org"] },
  { name: "python", title: "PyPI", hosts: ["pypi.org", "files.pythonhosted.org"] },
  { name: "debian", title: "Debian packages (apt)", hosts: ["deb.debian.org", "security.debian.org"] },
  { name: "github", title: "GitHub clones and release downloads", hosts: ["github.com", "codeload.github.com", "raw.githubusercontent.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"] },
  { name: "playwright", title: "Playwright browser downloads", hosts: ["cdn.playwright.dev", "playwright.download.prss.microsoft.com", "playwright.azureedge.net"] },
  { name: "cypress", title: "Cypress binary downloads", hosts: ["download.cypress.io", "cdn.cypress.io"] },
  { name: "chromium", title: "Chrome for Testing (Puppeteer)", hosts: ["storage.googleapis.com", "googlechromelabs.github.io"] },
  { name: "rust", title: "Rust toolchain and crates", hosts: ["static.rust-lang.org", "sh.rustup.rs", "crates.io", "index.crates.io", "static.crates.io"] },
  { name: "go", title: "Go toolchain and modules", hosts: ["go.dev", "dl.google.com", "proxy.golang.org", "sum.golang.org", "storage.googleapis.com"] },
  { name: "jvm", title: "Maven Central and Gradle", hosts: ["repo.maven.apache.org", "repo1.maven.org", "services.gradle.org", "plugins.gradle.org", "downloads.gradle.org"] },
  { name: "ruby", title: "RubyGems", hosts: ["rubygems.org", "index.rubygems.org"] },
] as const satisfies readonly NetworkPack[];

export type PackName = (typeof NETWORK_PACKS)[number]["name"];
export const PACK_NAMES = NETWORK_PACKS.map((p) => p.name) as [PackName, ...PackName[]];

/** What a session gets when nothing is chosen; the same hosts as the old default allowlist and a few more. */
export const DEFAULT_PACKS: readonly PackName[] = ["anthropic", "node", "python", "debian", "github"];

export const isPackName = (s: string): s is PackName => (PACK_NAMES as string[]).includes(s);

export const packHosts = (names: readonly string[]): string[] => {
  const out: string[] = [];
  for (const n of ["anthropic", ...names]) {
    const p = NETWORK_PACKS.find((x) => x.name === n);
    if (p) for (const h of p.hosts) if (!out.includes(h)) out.push(h);
  }
  return out;
};

/** The allowlist for a set of packs plus extra hosts, in a stable order, without duplicates. */
export const allowlistFor = (packs: readonly string[], extra: readonly string[] = []): string[] => [...new Set([...packHosts(packs), ...extra.map((h) => h.trim()).filter(Boolean)])];

/**
 * Packs a repository implies, from its manifests. Pure: give it the files'
 * paths and contents. Package manifests are read as data (JSON.parse, text
 * search), never run.
 */
export const detectPacks = (files: { path: string; text: string }[]): PackName[] => {
  const found = new Set<PackName>();
  const base = (p: string) => path.posix.basename(p);
  for (const f of files) {
    const b = base(f.path);
    if (b === "package.json") {
      found.add("node");
      let deps: Record<string, unknown> = {};
      try {
        const j = JSON.parse(f.text) as Record<string, Record<string, unknown> | undefined>;
        deps = { ...j.dependencies, ...j.devDependencies, ...j.optionalDependencies, ...j.peerDependencies };
      } catch {
        // an unparsable manifest still means node
      }
      if ("@playwright/test" in deps || "playwright" in deps || "playwright-core" in deps) found.add("playwright");
      if ("cypress" in deps) found.add("cypress");
      if ("puppeteer" in deps) found.add("chromium");
      if (Object.values(deps).some((v) => typeof v === "string" && /github:|github\.com|^[\w.-]+\/[\w.-]+(#.*)?$/.test(v))) found.add("github");
    } else if (/^(pyproject\.toml|setup\.py|setup\.cfg|Pipfile|requirements.*\.txt)$/.test(b)) {
      found.add("python");
      if (/(^|[\s"'=])playwright\b/m.test(f.text)) found.add("playwright");
    } else if (b === "Cargo.toml") found.add("rust");
    else if (b === "go.mod") found.add("go");
    else if (/^(pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?)$/.test(b)) found.add("jvm");
    else if (b === "Gemfile") found.add("ruby");
  }
  return PACK_NAMES.filter((n) => found.has(n));
};

const MANIFESTS = ["package.json", "pyproject.toml", "setup.py", "setup.cfg", "Pipfile", "requirements*.txt", "Cargo.toml", "go.mod", "pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts", "Gemfile"];

/** Detects packs in a git work tree on the host (your own repository): tracked manifests only, at most 60 files. */
export const detectPacksInRepo = async (repoPath: string): Promise<PackName[]> => {
  const { stdout } = await promisify(execFile)("git", ["-C", repoPath, "ls-files", "--", ...MANIFESTS.flatMap((m) => [m, `**/${m}`])], { maxBuffer: 4 * 1024 * 1024 });
  const paths = stdout.split("\n").filter((p) => p && !p.includes("node_modules/")).slice(0, 60);
  const files: { path: string; text: string }[] = [];
  for (const p of paths) {
    const text = await fs.readFile(path.join(repoPath, p), "utf8").catch(() => "");
    files.push({ path: p, text: text.slice(0, 200_000) });
  }
  return detectPacks(files);
};

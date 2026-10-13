import { test, expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { githubApi, parseGithubRepo } from "../../src/github/api.js";
import { githubAuthEnv, Mirrors } from "../../src/github/mirror.js";
import { configSchema, secretValues } from "../../src/config.js";

const execFileP = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await execFileP("git", args, { cwd })).stdout.trim();

/** A stand-in for the repository on GitHub: a local repository with two branches and a manifest. */
const makeUpstream = async (dir: string) => {
  await fs.mkdir(dir, { recursive: true });
  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "config", "user.name", "Owner");
  await git(dir, "config", "user.email", "owner@example.com");
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ devDependencies: { "@playwright/test": "1" } }));
  await fs.mkdir(path.join(dir, "api"));
  await fs.writeFile(path.join(dir, "api", "requirements-dev.txt"), "pytest\n");
  await git(dir, "add", ".");
  await git(dir, "commit", "-q", "-m", "init");
  await git(dir, "checkout", "-q", "-b", "feature");
  await fs.writeFile(path.join(dir, "f.txt"), "f\n");
  await git(dir, "add", ".");
  await git(dir, "commit", "-q", "-m", "feature work");
  await git(dir, "checkout", "-q", "main");
};

test("parseGithubRepo takes owner/name and github.com URLs, nothing else", () => {
  expect(parseGithubRepo("acme/nuppi")).toBe("acme/nuppi");
  expect(parseGithubRepo(" https://github.com/acme/nuppi.git/ ")).toBe("acme/nuppi");
  expect(parseGithubRepo("https://github.com/acme/nuppi")).toBe("acme/nuppi");
  expect(parseGithubRepo("git@github.com:acme/nuppi.git")).toBe("acme/nuppi");
  expect(parseGithubRepo("https://gitlab.com/acme/nuppi")).toBeNull();
  expect(parseGithubRepo("acme/nuppi/tree/main")).toBeNull();
  expect(parseGithubRepo("acme/..")).toBeNull();
  expect(parseGithubRepo("/Users/me/repo")).toBeNull();
});

test("the token reaches git only through the environment, scoped to github.com, with credential helpers off", () => {
  const env = githubAuthEnv("ghp_secret");
  expect(env.GIT_CONFIG_COUNT).toBe("2");
  expect(env.GIT_CONFIG_KEY_0).toBe("credential.helper");
  expect(env.GIT_CONFIG_VALUE_0).toBe("");
  expect(env.GIT_CONFIG_KEY_1).toBe("http.https://github.com/.extraheader");
  expect(Buffer.from(env.GIT_CONFIG_VALUE_1!.replace("AUTHORIZATION: basic ", ""), "base64").toString()).toBe("x-access-token:ghp_secret");
  expect(githubAuthEnv(undefined).GIT_CONFIG_COUNT).toBe("1");
});

test("local work targets from before are dropped; the GitHub token is a secret the commit scan looks for", () => {
  const c = configSchema.parse({ workTargets: [{ name: "old", path: "/x" }, { name: "nuppi", github: "acme/nuppi", defaultBranch: "main" }] });
  expect(c.workTargets).toEqual([{ name: "nuppi", github: "acme/nuppi", defaultBranch: "main" }]);
  expect(secretValues({ githubToken: "github_pat_abcdefghijklmnop" })).toContain("github_pat_abcdefghijklmnop");
});

test("a mirror fetches every branch, reuses a fresh fetch, prunes deleted branches, and reads branches, logs and packs without a checkout", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "verstas-github-"));
  try {
    const upstream = path.join(tmp, "upstream");
    await makeUpstream(upstream);
    let tokenAsked = 0;
    const mirrors = new Mirrors({ home: path.join(tmp, "home"), token: async () => (tokenAsked++, "tok"), remote: () => upstream });
    const dir = mirrors.path("Acme/Nuppi");
    expect(dir).toBe(path.join(tmp, "home", "mirrors", "acme", "nuppi.git"));
    expect((await mirrors.status("Acme/Nuppi")).fetchedAt).toBeNull();

    // Concurrent callers share one fetch.
    await Promise.all([mirrors.fresh("Acme/Nuppi"), mirrors.fresh("Acme/Nuppi")]);
    expect(tokenAsked).toBe(1);
    expect(await git(dir, "rev-parse", "--is-bare-repository")).toBe("true");
    expect(await fs.readdir(path.join(dir, "hooks")).catch(() => [])).toEqual([]);
    expect(await git(dir, "remote")).toBe("");
    expect((await mirrors.branches("Acme/Nuppi")).sort()).toEqual(["feature", "main"]);
    expect(await mirrors.hasBranch("Acme/Nuppi", "feature")).toBe(true);
    expect(await mirrors.hasBranch("Acme/Nuppi", "nope")).toBe(false);
    expect(await mirrors.hasBranch("Acme/Nuppi", "--upload-pack=x")).toBe(false);
    expect((await mirrors.log("Acme/Nuppi", "feature", 5)).map((c) => c.subject)).toEqual(["feature work", "init"]);
    expect(await mirrors.packs("Acme/Nuppi", "main")).toEqual(expect.arrayContaining(["node", "playwright", "python"]));

    // Fresh within maxAge: no second fetch.
    await mirrors.fresh("Acme/Nuppi");
    expect(tokenAsked).toBe(1);

    // GitHub moved on: a fetch brings the new commit and drops the deleted branch; Verstas's own refs stay.
    await git(dir, "update-ref", "refs/verstas/s/nuppi", "refs/heads/main");
    await fs.writeFile(path.join(upstream, "b.txt"), "b\n");
    await git(upstream, "add", ".");
    await git(upstream, "commit", "-q", "-m", "merged PR");
    await git(upstream, "branch", "-q", "-D", "feature");
    await mirrors.fetch("Acme/Nuppi");
    expect(await mirrors.branches("Acme/Nuppi")).toEqual(["main"]);
    expect((await mirrors.log("Acme/Nuppi", "main", 1))[0]!.subject).toBe("merged PR");
    expect(await git(dir, "rev-parse", "--verify", "refs/verstas/s/nuppi")).toMatch(/^[0-9a-f]{40}$/);
    expect((await mirrors.status("Acme/Nuppi")).fetchedAt).not.toBeNull();
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("a failed fetch says why without the token, and is remembered on the status", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "verstas-github-"));
  try {
    const mirrors = new Mirrors({ home: tmp, token: async () => "tok-not-in-errors", remote: () => path.join(tmp, "missing", "tok-not-in-errors") });
    const err = await mirrors.fetch("acme/nuppi").catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("Fetching acme/nuppi from GitHub failed");
    expect((err as Error).message).not.toContain("tok-not-in-errors");
    expect((await mirrors.status("acme/nuppi")).error).toBeTruthy();
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("the GitHub API client sends the token to the API origin and reports what it finds", async () => {
  const seen: { url: string; auth: string | null }[] = [];
  const fake = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen.push({ url: String(url), auth: headers.get("authorization") });
    const u = String(url);
    if (u.endsWith("/user")) return new Response(JSON.stringify({ login: "me" }));
    if (u.endsWith("/repos/acme/nuppi")) return new Response(JSON.stringify({ full_name: "acme/nuppi", default_branch: "trunk", private: true, permissions: { push: true } }));
    return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
  }) as typeof fetch;
  const api = githubApi("tok", "https://api.example", fake);
  expect(await api.whoami()).toEqual({ login: "me" });
  expect(await api.repo("acme/nuppi")).toEqual({ github: "acme/nuppi", defaultBranch: "trunk", private: true, canPush: true });
  await expect(api.repo("acme/gone")).rejects.toThrow(/not found, or the token cannot see it/);
  expect(seen.every((s) => s.url.startsWith("https://api.example/") && s.auth === "Bearer tok")).toBe(true);
  expect(await githubApi(undefined, "https://api.example", fake).whoami()).toBeNull();
});

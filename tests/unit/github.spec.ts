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

test("a clone's state is read with git in the clone: commits since the base, uncommitted files, the base itself", async () => {
  const { readBoxRepoState, loadRepoStateCache, saveRepoStateCache } = await import("../../src/sessions/repo-state.js");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "verstas-state-"));
  try {
    const clone = path.join(tmp, "workspace", "app");
    await makeUpstream(clone);
    await git(clone, "checkout", "-q", "-b", "verstas/s");
    const base = await git(clone, "rev-parse", "HEAD");
    // The container's shell, played by a local one with /workspace mapped to the temp directory.
    const sh = {
      exec: async (cmd: readonly string[], opts: { workdir?: string } = {}) => {
        const cwd = (opts.workdir ?? "/workspace").replace(/^\/workspace/, path.join(tmp, "workspace"));
        return execFileP(cmd[0]!, cmd.slice(1), { cwd }).then((r) => ({ code: 0, stdout: r.stdout, stderr: r.stderr }), (e) => ({ code: 1, stdout: "", stderr: String(e) }));
      },
    };
    const repo = { name: "app", github: "acme/app", branch: "main", runBranch: "verstas/s", baseCommit: base };

    const none = await readBoxRepoState(sh, repo);
    expect(none).toMatchObject({ head: base, ahead: 0, dirty: 0, commits: [], base: { sha: base, subject: "init" } });

    await fs.writeFile(path.join(clone, "a.txt"), "a\n");
    await git(clone, "add", ".");
    await git(clone, "commit", "-q", "-m", "T-1: first");
    await fs.writeFile(path.join(clone, "b.txt"), "uncommitted\n");
    const some = await readBoxRepoState(sh, repo);
    expect(some?.ahead).toBe(1);
    expect(some?.dirty).toBe(1);
    expect(some?.commits.map((c) => c.subject)).toEqual(["T-1: first"]);

    // No base recorded (an older session): the latest commits, no count.
    const old = await readBoxRepoState(sh, { ...repo, baseCommit: undefined });
    expect(old?.ahead).toBeNull();
    expect(old?.commits[0]?.subject).toBe("T-1: first");
    // No clone: nothing to say.
    expect(await readBoxRepoState(sh, { ...repo, name: "missing" })).toBeNull();

    await saveRepoStateCache(tmp, { app: some! });
    expect((await loadRepoStateCache(tmp)).app?.ahead).toBe(1);
    expect(await loadRepoStateCache(path.join(tmp, "nope"))).toEqual({});
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("the mirror says how far GitHub moved past a base", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "verstas-github-"));
  try {
    const upstream = path.join(tmp, "upstream");
    await makeUpstream(upstream);
    const base = await git(upstream, "rev-parse", "main");
    const mirrors = new Mirrors({ home: path.join(tmp, "home"), token: async () => undefined, remote: () => upstream });
    await mirrors.fetch("acme/app");
    expect(await mirrors.countSince("acme/app", base, "main")).toBe(0);
    for (const n of [1, 2]) {
      await fs.writeFile(path.join(upstream, `${n}.txt`), "x\n");
      await git(upstream, "add", ".");
      await git(upstream, "commit", "-q", "-m", `merged ${n}`);
    }
    await mirrors.fetch("acme/app");
    expect(await mirrors.countSince("acme/app", base, "main")).toBe(2);
    expect((await mirrors.tip("acme/app", "main"))?.subject).toBe("merged 2");
    expect(await mirrors.tip("acme/app", "gone")).toBeNull();
    expect(await mirrors.countSince("acme/app", "not-a-sha", "main")).toBeNull();
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("publish: a bundle of the session's commits goes into the mirror and is pushed to a verstas/ branch, never anything else", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "verstas-publish-"));
  try {
    // GitHub, played by a bare repository.
    const work = path.join(tmp, "work");
    await makeUpstream(work);
    const upstream = path.join(tmp, "upstream.git");
    await execFileP("git", ["clone", "-q", "--bare", work, upstream]);
    const mirrors = new Mirrors({ home: path.join(tmp, "home"), token: async () => "tok", remote: () => upstream });
    await mirrors.fetch("acme/app");

    // The session's clone, made from the mirror, with a ticket's commit.
    const clone = path.join(tmp, "clone");
    await execFileP("git", ["clone", "-q", "--no-local", "--template=", "--single-branch", "--branch", "main", mirrors.path("acme/app"), clone]);
    await git(clone, "checkout", "-q", "-b", "verstas/s");
    const base = await git(clone, "rev-parse", "HEAD");
    await git(clone, "config", "user.name", "Verstas");
    await git(clone, "config", "user.email", "v@localhost");
    await fs.writeFile(path.join(clone, "a.txt"), "a\n");
    await git(clone, "add", ".");
    await git(clone, "commit", "-q", "-m", "T-1: first");
    const bundle = path.join(tmp, "app.bundle");
    await git(clone, "bundle", "create", bundle, "verstas/s", `^${base}`);

    const ref = "refs/verstas/s/app";
    const sha = await mirrors.importBundle("acme/app", bundle, "verstas/s", ref);
    expect(sha).toBe(await git(clone, "rev-parse", "HEAD"));
    expect(await mirrors.remoteSha("acme/app", "verstas/s-1")).toBeNull();
    await mirrors.push("acme/app", ref, "verstas/s-1", null);
    expect(await git(upstream, "rev-parse", "refs/heads/verstas/s-1")).toBe(sha);
    expect(await mirrors.remoteSha("acme/app", "verstas/s-1")).toBe(sha);
    // main on "GitHub" is untouched.
    expect(await git(upstream, "rev-parse", "refs/heads/main")).toBe(base);

    // A second ticket: the branch moves forward, leased on what Verstas pushed.
    await fs.writeFile(path.join(clone, "b.txt"), "b\n");
    await git(clone, "add", ".");
    await git(clone, "commit", "-q", "-m", "T-2: second");
    await git(clone, "bundle", "create", bundle, "verstas/s", `^${base}`);
    const sha2 = await mirrors.importBundle("acme/app", bundle, "verstas/s", ref);
    await mirrors.push("acme/app", ref, "verstas/s-1", sha);
    expect(await git(upstream, "rev-parse", "refs/heads/verstas/s-1")).toBe(sha2);
    // Someone moved the branch on GitHub: a push leased on what Verstas pushed is refused.
    await git(upstream, "update-ref", "refs/heads/verstas/s-1", base);
    await expect(mirrors.push("acme/app", ref, "verstas/s-1", sha2)).rejects.toThrow(/changed on GitHub/);
    expect(await git(upstream, "rev-parse", "refs/heads/verstas/s-1")).toBe(base);

    // Only verstas/ branches, only Verstas's refs.
    await expect(mirrors.push("acme/app", ref, "main", null)).rejects.toThrow(/only verstas\/ branches/);
    await expect(mirrors.push("acme/app", "refs/heads/main", "verstas/x-1", null)).rejects.toThrow(/Bad ref/);
    await expect(mirrors.importBundle("acme/app", bundle, "verstas/s", "refs/heads/main")).rejects.toThrow(/Bad ref/);
    // Fetches prune branches deleted on GitHub but keep Verstas's refs.
    await mirrors.fetch("acme/app");
    expect(await git(mirrors.path("acme/app"), "rev-parse", ref)).toBe(sha2);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("publish helpers: rounds, branch names, flagged files, the default text", async () => {
  const { publishTarget, remoteBranchFor, flaggedPaths, defaultPullText } = await import("../../src/sessions/publish.js");
  const pr = (round: number, state: "open" | "merged" | "closed") => ({ round, number: round, url: "u", remoteBranch: `verstas/s-${round}`, headSha: "x", base: "main", title: "t", state, publishedAt: "now" });
  expect(publishTarget(undefined)).toEqual({ round: 1, update: null });
  expect(publishTarget([pr(1, "open")])).toMatchObject({ round: 1, update: { number: 1 } });
  expect(publishTarget([pr(1, "merged")])).toEqual({ round: 2, update: null });
  expect(publishTarget([pr(1, "merged"), pr(2, "closed")])).toEqual({ round: 3, update: null });
  expect(remoteBranchFor("2026-10-13-nuppi", 2)).toBe("verstas/2026-10-13-nuppi-2");
  expect(flaggedPaths(["src/a.ts", ".github/workflows/ci.yml", "web/package.json", "Makefile", "docs/x.md"])).toEqual([".github/workflows/ci.yml", "web/package.json", "Makefile"]);
  const one = defaultPullText({ name: "Nuppi", goal: "" }, [{ sha: "a", date: "", subject: "T-1: login" }]);
  expect(one.title).toBe("T-1: login");
  const two = defaultPullText({ name: "Nuppi", goal: "Ship it\nmore" }, [{ sha: "b", date: "", subject: "T-2: b" }, { sha: "a", date: "", subject: "T-1: a" }], 3);
  expect(two.title).toBe("Nuppi");
  expect(two.body).toContain("Goal: Ship it");
  expect(two.body).toContain("- T-1: a\n- T-2: b\n- … and 3 more");
});

test("the pull request API: create a draft, find by branch, read its state as merged or not", async () => {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const pull = (state: string, merged: string | null) => ({ number: 7, html_url: "https://github.com/acme/app/pull/7", state, draft: true, merged_at: merged, title: "T-1", head: { ref: "verstas/s-1", sha: "abc" }, base: { ref: "main" } });
  const fake = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ method: init?.method ?? "GET", url: u, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (u.endsWith("/pulls") && init?.method === "POST") return new Response(JSON.stringify(pull("open", null)), { status: 201 });
    if (u.includes("/pulls?")) return new Response(JSON.stringify(u.includes("verstas%2Fs-9") ? [] : [pull("open", null)]));
    if (u.endsWith("/pulls/7") && init?.method === "PATCH") return new Response(JSON.stringify(pull("open", null)));
    if (u.endsWith("/pulls/7")) return new Response(JSON.stringify(pull("closed", "2026-10-13T00:00:00Z")));
    if (u.endsWith("/pulls/8")) return new Response(JSON.stringify({ message: "Validation Failed", errors: [{ message: "No commits between main and verstas/s-1" }] }), { status: 422 });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const api = githubApi("tok", "https://api.example", fake);
  expect(await api.createPull("acme/app", { head: "verstas/s-1", base: "main", title: "T-1", body: "b", draft: true })).toMatchObject({ number: 7, state: "open", draft: true });
  expect(calls[0]).toMatchObject({ method: "POST", url: "https://api.example/repos/acme/app/pulls", body: { head: "verstas/s-1", base: "main", draft: true } });
  expect((await api.findPull("acme/app", "verstas/s-1"))?.number).toBe(7);
  expect(calls[1]!.url).toContain("head=acme%3Averstas%2Fs-1");
  expect(await api.findPull("acme/app", "verstas/s-9")).toBeNull();
  expect((await api.pull("acme/app", 7)).state).toBe("merged");
  await api.updatePull("acme/app", 7, { title: "T-1 and T-2" });
  expect(calls.at(-1)).toMatchObject({ method: "PATCH", body: { title: "T-1 and T-2" } });
  await expect(api.pull("acme/app", 8)).rejects.toThrow(/Validation Failed: No commits between/);
});

import { test, expect } from "@playwright/test";
import { publishAll, publishSkip } from "../../src/sessions/publish.js";
import type { BoxRepoState } from "../../src/sessions/repo-state.js";
import type { PullRecord, Session } from "../../src/core/types.js";

/** Publish all: which repositories go, which are left out and why, the one confirm, and a failure that stops nothing else. */

type Repo = Session["repos"][number];
const sha = (c: string) => c.repeat(40);
const repo = (name: string, prs?: PullRecord[]): Repo => ({ name, github: `acme/${name}`, branch: "main", runBranch: "verstas/run", baseCommit: sha("b"), prs });
const pr = (number: number, state: PullRecord["state"], headSha = sha("a")): PullRecord => ({ round: 1, number, url: `https://github.com/acme/x/pull/${number}`, remoteBranch: "verstas/s-1", headSha, base: "main", title: "Earlier", state, publishedAt: "2026-11-09T08:00:00.000Z" });
const box = (ahead: number, extra: Partial<BoxRepoState> = {}): BoxRepoState => ({ at: "2026-11-09T09:00:00.000Z", head: sha("c"), ahead, dirty: 0, commits: ahead ? [{ sha: sha("c"), date: "2026-11-09T08:30:00.000Z", subject: "T-1: work" }] : [], base: null, ...extra });

test("a repository is left out when it has nothing new, or when a finished pull request's commits are still on the branch", () => {
  expect(publishSkip(repo("api"), box(2))).toBeUndefined();
  expect(publishSkip(repo("api"), null)).toMatch(/could not be read/);
  expect(publishSkip(repo("api"), box(0))).toMatch(/no commits/);
  // An open pull request that already has the head needs no push; one that is behind gets the new commits.
  expect(publishSkip(repo("api", [pr(4, "open", sha("c"))]), box(2))).toMatch(/#4 already has every commit/);
  expect(publishSkip(repo("api", [pr(4, "open")]), box(2))).toBeUndefined();
  // Merged, and the merged head is still among the branch's commits: a new pull request would carry the old work again.
  expect(publishSkip(repo("api", [pr(4, "merged", sha("c"))]), box(2))).toMatch(/#4 was merged.*sync to main first/);
  expect(publishSkip(repo("api", [pr(4, "merged")]), box(2))).toBeUndefined();
});

test("publish all opens and updates in one call, leaves out what has nothing, and goes on after a failure", async () => {
  const repos = [repo("api", [pr(4, "open")]), repo("web"), repo("docs"), repo("infra"), { ...repo("local"), github: undefined }];
  const state: Record<string, BoxRepoState> = { api: box(3), web: box(1, { dirty: 2 }), docs: box(0), infra: box(1) };
  const published: string[] = [];
  const r = await publishAll(
    repos,
    {
      read: async (x) => ({ st: state[x.name] ?? null, paths: ["src/a.ts"] }),
      publish: async (x) => {
        if (x.name === "infra") throw new Error("push rejected");
        published.push(x.name);
        return { pr: pr(x.name === "api" ? 4 : 9, "open"), updated: x.name === "api" };
      },
    },
    { acknowledgeFlagged: false },
  );
  expect(r.published).toBe(true);
  expect(published).toEqual(["api", "web"]);
  expect(r.rows.map((x) => [x.repo, x.outcome])).toEqual([["api", "updated"], ["web", "opened"], ["docs", "skipped"], ["infra", "failed"], ["local", "skipped"]]);
  expect(r.rows[1]).toMatchObject({ dirty: 2, pr: { number: 9 } });
  expect(r.rows[3]!.reason).toBe("push rejected");
  expect(r.rows[4]!.reason).toMatch(/not a GitHub repository/);
});

test("build or CI files among the changes stop everything once: nothing is pushed until the call comes again acknowledged", async () => {
  const repos = [repo("api"), repo("web")];
  let pushes = 0;
  const io = {
    read: async (x: Repo) => ({ st: box(1), paths: x.name === "api" ? [".github/workflows/ci.yml", "src/a.ts", "package.json"] : ["src/b.ts"] }),
    publish: async () => {
      pushes++;
      return { pr: pr(1, "open"), updated: false };
    },
  };
  const asked = await publishAll(repos, io, { acknowledgeFlagged: false });
  expect(asked.published).toBe(false);
  expect(asked.flagged).toEqual([{ repo: "api", paths: [".github/workflows/ci.yml", "package.json"] }]);
  expect(asked.rows.map((x) => x.outcome)).toEqual(["ready", "ready"]);
  expect(pushes).toBe(0);
  const done = await publishAll(repos, io, { acknowledgeFlagged: true });
  expect(done.published).toBe(true);
  expect(pushes).toBe(2);
  // Files in a repository that is left out ask nothing.
  const none = await publishAll([repo("api")], { ...io, read: async () => ({ st: box(0), paths: ["package.json"] }) }, { acknowledgeFlagged: false });
  expect(none).toMatchObject({ published: true, flagged: [] });
});

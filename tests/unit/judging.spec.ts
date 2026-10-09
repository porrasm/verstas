import { test, expect } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunTokens } from "../../src/agent-api/agent-api.js";
import { emptyBoard, getTicket, importBoard, parseMarkdownBoard, replaceTicket } from "../../src/board/board.js";
import { saveBoard, writeJsonAtomic } from "../../src/board/store.js";
import { inboxSchema, now, sessionSchema, ticketSchema, type RepoSpec } from "../../src/core/types.js";
import { earlierAttempts, plannedVsTouched, reviewLevel, type RepoChange } from "../../src/harness/judging.js";
import { reviewerPrompt } from "../../src/harness/prompts.js";
import { RunManager, type Shell, type WorkerRunner } from "../../src/harness/run.js";
import { SessionHub } from "../../src/sessions/hub.js";
import { sessionPaths } from "../../src/sessions/sessions.js";
import type { Job } from "../../src/worker/worker.js";

/**
 * Judging a change that may touch any subset of a session's repositories:
 * the rules (pure) and the run with a shell that answers per repository.
 * The harness runs no checks: the reviewer runs the repositories' own.
 */

const repo = (name: string, extra: Partial<RepoSpec> = {}): RepoSpec => ({ name, sourcePath: `/x/${name}`, branch: "main", runBranch: "verstas/t", ...extra });
const change = (r: string, paths: string[] = ["src/a.ts"]): RepoChange => ({ repo: r, added: 3, removed: 1, files: paths.length, stat: "", diff: `diff ${r}`, paths, scattered: [] });

test("the review level is the ticket's own setting, else the session's; the old \"checks\" value reads as none", () => {
  expect(reviewLevel({ review: undefined }, { reviewer: true })).toEqual({ mode: "full", why: "the session's setting" });
  expect(reviewLevel({ review: undefined }, { reviewer: false })).toEqual({ mode: "none", why: "the session's setting" });
  expect(reviewLevel({ review: "none" }, { reviewer: true })).toEqual({ mode: "none", why: "the ticket's own setting" });
  expect(reviewLevel({ review: "full" }, { reviewer: false })).toEqual({ mode: "full", why: "the ticket's own setting" });
  expect(reviewLevel({ review: "checks" }, { reviewer: true }).mode).toBe("none");
});

test("a ticket's earlier attempts at the top of the history are its base; older ones behind other work are listed", () => {
  const log = ["aaaaaaa1\tT-5 (wip attempt 1): X", "bbbbbbb2\tT-5 (waiting): X", "ccccccc3\tT-4: Y", "ddddddd4\tT-5 (wip): X", "eeeeeee5\tInitial"].join("\n");
  expect(earlierAttempts(log, "T-5")).toEqual({ base: "bbbbbbb2", scattered: ["ddddddd4"] });
  // A done commit ("T-4: Y") is not an attempt.
  expect(earlierAttempts(log, "T-4")).toEqual({ base: undefined, scattered: [] });
  expect(earlierAttempts("", "T-1")).toEqual({ base: undefined, scattered: [] });
  // T-1's commits never match T-10's.
  expect(earlierAttempts("aaaaaaa1\tT-10 (wip): X", "T-1")).toEqual({ base: undefined, scattered: [] });
});

test("plannedVsTouched says how the plan and the change differ, and nothing when they agree", () => {
  expect(plannedVsTouched([], ["api"])).toBeUndefined();
  expect(plannedVsTouched(["api"], ["api"])).toBeUndefined();
  expect(plannedVsTouched(["api"], ["api", "handbook"])).toBe("planned api; touched api, handbook");
  expect(plannedVsTouched(["api", "web"], [])).toBe("planned api, web; touched nothing");
});

test("tickets read the older single repo as a list, and the board format takes several", () => {
  expect(ticketSchema.parse({ id: "T-1", title: "x", repo: "api", createdAt: "t", updatedAt: "t" }).repos).toEqual(["api"]);
  expect(ticketSchema.parse({ id: "T-1", title: "x", createdAt: "t", updatedAt: "t" }).repos).toEqual([]);
  const md = parseMarkdownBoard("## T-1 · Endpoint (S)\nRepos: api, handbook · Priority: 5\nDo it.\n");
  expect(md.tickets[0]).toMatchObject({ repos: ["api", "handbook"], priority: 5 });
  expect(importBoard(emptyBoard(), { tickets: [{ title: "Old", repo: "api" }] }).board.tickets[0]!.repos).toEqual(["api"]);
});

test("the reviewer sees one section per repository, how plan and change differ, and is told to run the checks itself", () => {
  const t = ticketSchema.parse({ id: "T-1", title: "Endpoint", repos: ["api"], createdAt: "t", updatedAt: "t" });
  const prompt = reviewerPrompt(t, [change("handbook"), change("api")], undefined, { why: "the session's setting", planned: "planned api; touched handbook, api" });
  expect(prompt).toContain("### /workspace/handbook");
  expect(prompt).toContain("### /workspace/api");
  expect(prompt).toContain("planned api; touched handbook, api");
  expect(prompt).toContain("Nobody has run the repositories' checks on this change");
  expect(prompt).not.toContain("run by the harness");
});

// --- The run, with a shell that answers per repository ---------------------

/** Repositories with a staged change (numstat lines); every command succeeds, and `checks()` lists any check command the harness ran (it must run none). */
const repoShell = (changed: Record<string, string>) => {
  const calls: { cmd: string; dir: string }[] = [];
  const commits: { dir: string; args: string[] }[] = [];
  const shell: Shell = {
    async exec(cmd, opts) {
      const s = cmd.join(" ");
      const dir = String((opts as { workdir?: string } | undefined)?.workdir ?? "").replace("/workspace/", "");
      calls.push({ cmd: s, dir });
      const num = changed[dir] ?? "";
      if (s === "git diff --cached --numstat") return { code: 0, stdout: num, stderr: "" };
      if (s === "git diff --cached --stat") return { code: 0, stdout: num ? ` ${dir} stat` : "", stderr: "" };
      if (s === "git diff --cached") return { code: 0, stdout: num ? `diff --git a/${dir}` : "", stderr: "" };
      if (s === "git diff --cached --quiet") return { code: num ? 1 : 0, stdout: "", stderr: "" };
      if (cmd.includes("commit")) {
        commits.push({ dir, args: [...cmd] });
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  return { shell, calls, commits, checks: () => calls.filter((c) => c.cmd.startsWith("bash -lc")).map((c) => `${c.dir}:${c.cmd.slice("bash -lc ".length)}`) };
};

const makeRun = async (repos: RepoSpec[], tickets: { id: string; title: string; repos?: string[] }[], caps: Record<string, unknown> = {}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "verstas-judging-"));
  const id = "2026-10-08-judging";
  const paths = sessionPaths(root, id);
  await fs.mkdir(paths.workspace, { recursive: true });
  await fs.mkdir(paths.runs, { recursive: true });
  await writeJsonAtomic(paths.session, sessionSchema.parse({ id, name: "j", createdAt: now(), initializedAt: now(), repos, setupMode: "agentic", caps: { reviewer: true, ticketAttempts: 2, runTickets: 10, ...caps } }));
  await saveBoard(paths.dir, importBoard(emptyBoard("g"), { tickets: tickets.map((t) => ({ ...t, state: "ready" as const })) }).board);
  await writeJsonAtomic(paths.inbox, inboxSchema.parse({}));
  return { root, id, paths, hub: new SessionHub(root) };
};

const worker = (hub: SessionHub, sessionId: string, reviewer: (job: Job) => string = () => "VERDICT: ok\nfine"): WorkerRunner & { jobs: Job[] } => {
  const jobs: Job[] = [];
  return {
    jobs,
    async run(job, _onEvent, _signal) {
      jobs.push(job);
      if (job.role === "implementer") {
        const h = await hub.get(sessionId);
        await h.mutate((d) => ({ next: { board: replaceTicket(d.board, { ...getTicket(d.board, job.ticket!), report: "done" }) } }));
      }
      const text = job.role === "reviewer" ? reviewer(job) : "";
      return { kind: "worker_done", t: now(), ticket: job.ticket, role: job.role, ok: true, stopReason: "success", rateLimited: false, costUsd: 0, turns: 1, seconds: 1, text, stderr: "" };
    },
  };
};

const runWith = (s: Awaited<ReturnType<typeof makeRun>>, shell: Shell, w: WorkerRunner) =>
  new RunManager({ hub: s.hub, tokens: new RunTokens(), shell: () => shell, worker: () => w, ensureSandbox: async () => undefined, agentApiUrl: "http://x/agent", rateLimitSleepMs: 20 });

const repos = () => [repo("api"), repo("handbook")];

test("with the reviewer off, a change is accepted on the implementer's word, no check runs, and it is committed where it changed", async () => {
  const s = await makeRun(repos(), [{ id: "T-1", title: "Typo", repos: ["handbook"] }], { reviewer: false });
  try {
    const sh = repoShell({ handbook: "1\t1\tguide.md\n" });
    const w = worker(s.hub, s.id);
    await (await runWith(s, sh.shell, w).start(s.id)).done;
    const t = getTicket((await s.hub.get(s.id)).board, "T-1");
    expect(t.state).toBe("done");
    expect(sh.checks()).toEqual([]);
    expect(w.jobs.map((j) => j.role)).toEqual(["implementer"]);
    expect(t.touched).toEqual([{ repo: "handbook", added: 1, removed: 1, files: 1 }]);
    expect(t.notes.at(-1)?.text).toMatch(/^Accepted without review/);
    expect(sh.commits.map((c) => c.dir)).toEqual(["handbook"]);
    expect(sh.commits[0]!.args).toContain("Verstas-Ticket: T-1");
  } finally {
    await fs.rm(s.root, { recursive: true, force: true });
  }
});

test("a ticket that also touched an unplanned repository is judged as one: no harness check, one reviewer over both, commits in both", async () => {
  const s = await makeRun(repos(), [{ id: "T-1", title: "Endpoint", repos: ["api"] }]);
  try {
    const sh = repoShell({ api: "10\t2\tsrc/e.ts\n", handbook: "4\t0\tapi.md\n" });
    const prompts: string[] = [];
    const w = worker(s.hub, s.id);
    const base = w.run.bind(w);
    w.run = async (job, onEvent, signal) => {
      if (job.role === "reviewer") prompts.push(await fs.readFile(job.promptFile.replace("/workspace", s.paths.workspace), "utf8"));
      return base(job, onEvent, signal);
    };
    await (await runWith(s, sh.shell, w).start(s.id)).done;
    const t = getTicket((await s.hub.get(s.id)).board, "T-1");
    expect(t.state).toBe("done");
    expect(sh.checks()).toEqual([]);
    expect(t.touched?.map((x) => x.repo)).toEqual(["api", "handbook"]);
    expect(t.diff).toEqual({ added: 14, removed: 2, files: 2 });
    expect(t.notes.map((n) => n.text).join("\n")).toContain("planned api; touched api, handbook");
    expect(prompts[0]).toContain("### /workspace/api");
    expect(prompts[0]).toContain("### /workspace/handbook: 1 files, +4 −0");
    expect(sh.commits.map((c) => c.dir)).toEqual(["api", "handbook"]);
    expect(sh.commits[0]!.args).toContain("Verstas-Repos: api, handbook");
  } finally {
    await fs.rm(s.root, { recursive: true, force: true });
  }
});

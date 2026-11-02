import { test, expect } from "@playwright/test";
import { promises as fs } from "node:fs";
import type net from "node:net";
import os from "node:os";
import path from "node:path";
import { createAgentApi, RunTokens } from "../../src/agent-api/agent-api.js";
import { emptyBoard, getTicket, importBoard, parseMarkdownBoard } from "../../src/board/board.js";
import { saveBoard, writeJsonAtomic } from "../../src/board/store.js";
import { inboxSchema, now, sessionSchema, ticketSchema, type RepoSpec } from "../../src/core/types.js";
import { classifyCommits, plannedVsTouched, reviewLevel, type RepoChange } from "../../src/harness/judging.js";
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
const change = (r: string, paths: string[] = ["src/a.ts"], commits: RepoChange["commits"] = { mine: [], others: [], unlabelled: [] }): RepoChange => ({ repo: r, added: 3, removed: 1, files: paths.length, stat: "", diff: `diff ${r}`, paths, commits });

test("the review level is the ticket's own setting, else the session's; the old \"checks\" value reads as none", () => {
  expect(reviewLevel({ review: undefined }, { reviewer: true })).toEqual({ mode: "full", why: "the session's setting" });
  expect(reviewLevel({ review: undefined }, { reviewer: false })).toEqual({ mode: "none", why: "the session's setting" });
  expect(reviewLevel({ review: "none" }, { reviewer: true })).toEqual({ mode: "none", why: "the ticket's own setting" });
  expect(reviewLevel({ review: "full" }, { reviewer: false })).toEqual({ mode: "full", why: "the ticket's own setting" });
  expect(reviewLevel({ review: "checks" }, { reviewer: true }).mode).toBe("none");
});

test("the commits since a ticket's baseline are sorted into the ticket's own (id in the subject or a trailer), other tickets' and unlabelled", () => {
  const log = ["aaaaaaa1\tT-5: parser\t", "bbbbbbb2\tfix typo\t", "ccccccc3\tT-4: docs\tT-4", "ddddddd4\tLead 1.2: work in progress\tT-5,T-4", "eeeeeee5\tT-50: other\t", "not a sha\tx\t"].join("\n");
  expect(classifyCommits(log, "T-5")).toEqual({ mine: ["aaaaaaa1 T-5: parser", "ddddddd4 Lead 1.2: work in progress"], others: ["ccccccc3 T-4: docs", "eeeeeee5 T-50: other"], unlabelled: ["bbbbbbb2 fix typo"] });
  expect(classifyCommits("", "T-1")).toEqual({ mine: [], others: [], unlabelled: [] });
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

test("the reviewer sees one section per repository, the commits in the range by owner, how plan and change differ, and is told to run the checks itself", () => {
  const t = ticketSchema.parse({ id: "T-1", title: "Endpoint", repos: ["api"], createdAt: "t", updatedAt: "t" });
  const prompt = reviewerPrompt(t, [change("handbook"), change("api", ["src/e.ts"], { mine: ["aaaaaaa1 T-1: endpoint"], others: ["bbbbbbb2 T-2: engine"], unlabelled: ["ccccccc3 typo"] })], { why: "the session's setting", planned: "planned api; touched handbook, api" });
  expect(prompt).toContain("### /workspace/handbook");
  expect(prompt).toContain("### /workspace/api");
  expect(prompt).toContain("This ticket's commits (in the diff): aaaaaaa1 T-1: endpoint");
  expect(prompt).toContain("Other tickets' commits in the range (not in the diff): bbbbbbb2 T-2: engine");
  expect(prompt).toContain("name no ticket (not in the diff; look at them): ccccccc3 typo");
  expect(prompt).toContain("planned api; touched handbook, api");
  expect(prompt).toContain("## The lead's report\n(no report was filed");
  expect(prompt).toContain("Nobody has run the repositories' checks on this change");
  expect(prompt).not.toContain("run by the harness");
});

// --- The run, with a shell that answers per repository ---------------------

const BASE = "2222222222222222222222222222222222222222";

/** Repositories with a change in the working tree (numstat lines); every command succeeds, and `checks()` lists any check command the harness ran (it must run none). */
const repoShell = (changed: Record<string, string>) => {
  const calls: { cmd: string; dir: string }[] = [];
  const commits: { dir: string; args: string[] }[] = [];
  const shell: Shell = {
    async exec(cmd, opts) {
      const s = cmd.join(" ");
      const dir = String((opts as { workdir?: string } | undefined)?.workdir ?? "").replace("/workspace/", "");
      calls.push({ cmd: s, dir });
      const num = changed[dir] ?? "";
      if (s === "git rev-parse HEAD") return { code: 0, stdout: `${BASE}\n`, stderr: "" };
      if (cmd[1] === "log") return { code: 0, stdout: "", stderr: "" };
      if (s.startsWith("git diff --cached --numstat")) return { code: 0, stdout: num, stderr: "" };
      if (s.startsWith("git diff --cached --stat")) return { code: 0, stdout: num ? ` ${dir} stat` : "", stderr: "" };
      if (s === "git diff --cached" || s === `git diff --cached ${BASE}`) return { code: 0, stdout: num ? `diff --git a/${dir}` : "", stderr: "" };
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
  await writeJsonAtomic(paths.session, sessionSchema.parse({ id, name: "j", createdAt: now(), initializedAt: now(), repos, setupMode: "agentic", caps: { reviewer: true, runTickets: 10, ...caps } }));
  await saveBoard(paths.dir, importBoard(emptyBoard("g"), { tickets: tickets.map((t) => ({ ...t, state: "ready" as const })) }).board);
  await writeJsonAtomic(paths.inbox, inboxSchema.parse({}));
  return { root, id, paths, hub: new SessionHub(root) };
};

/** A lead that moves every ticket through in_progress, a report and review, against the real agent API; the reviewer answers `reviewer`. */
const runLead = async (s: Awaited<ReturnType<typeof makeRun>>, shell: Shell, reviewer: (job: Job) => string = () => "VERDICT: ok\nfine") => {
  const tokens = new RunTokens();
  const jobs: Job[] = [];
  const prompts: string[] = [];
  let port = 0;
  const worker: WorkerRunner = {
    async run(job, _onEvent, _signal, o) {
      jobs.push(job);
      const base = { kind: "worker_done" as const, t: now(), ticket: job.ticket, role: job.role, ok: true, stopReason: "success", rateLimited: false, costUsd: 0, turns: 1, seconds: 1, text: "", stderr: "" };
      if (job.role === "reviewer") {
        prompts.push(await fs.readFile(job.promptFile.replace("/workspace", s.paths.workspace), "utf8"));
        return { ...base, text: reviewer(job) };
      }
      const api = async (method: string, p: string, body?: unknown) => {
        const res = await fetch(`http://127.0.0.1:${port}/agent${p}`, { method, headers: { authorization: `Bearer ${o!.runToken}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
        return (await res.json()) as Record<string, unknown>;
      };
      const board = (await api("GET", "/board")) as { tickets: { id: string; state: string }[] };
      for (const t of board.tickets.filter((x) => x.state === "ready")) {
        await api("POST", `/tickets/${t.id}/move`, { to: "in_progress" });
        await api("POST", `/tickets/${t.id}/report`, { report: "done" });
        await api("POST", `/tickets/${t.id}/move`, { to: "review" });
        for (;;) {
          await new Promise((r) => setTimeout(r, 5));
          if ((await api("GET", `/tickets/${t.id}`)).state !== "review") break;
        }
      }
      return base;
    },
  };
  const mgr = new RunManager({ hub: s.hub, tokens, shell: () => shell, worker: () => worker, ensureSandbox: async () => undefined, agentApiUrl: "http://x/agent", rateLimitSleepMs: 20 });
  const server = createAgentApi(s.hub, tokens, mgr).listen(0, "127.0.0.1");
  port = await new Promise<number>((r) => server.on("listening", () => r((server.address() as net.AddressInfo).port)));
  try {
    await (await mgr.start(s.id)).done;
  } finally {
    server.close();
  }
  return { jobs, prompts };
};

const repos = () => [repo("api"), repo("handbook")];

test("with the reviewer off, a change is accepted on the lead's word, no check runs, and it is committed where it changed", async () => {
  const s = await makeRun(repos(), [{ id: "T-1", title: "Typo", repos: ["handbook"] }], { reviewer: false });
  try {
    const sh = repoShell({ handbook: "1\t1\tguide.md\n" });
    const r = await runLead(s, sh.shell);
    const t = getTicket((await s.hub.get(s.id)).board, "T-1");
    expect(t.state).toBe("done");
    expect(sh.checks()).toEqual([]);
    expect(r.jobs.map((j) => j.role)).toEqual(["lead"]);
    expect(t.touched).toEqual([{ repo: "handbook", added: 1, removed: 1, files: 1 }]);
    expect(t.notes.at(-1)?.text).toMatch(/^Accepted on the lead's word/);
    // The ticket commit lands where the change is; the life's backup commit follows there too.
    expect(sh.commits[0]).toMatchObject({ dir: "handbook" });
    expect(sh.commits[0]!.args).toContain("Verstas-Ticket: T-1");
  } finally {
    await fs.rm(s.root, { recursive: true, force: true });
  }
});

test("a ticket that also touched an unplanned repository is judged as one: no harness check, one reviewer over both, commits in both", async () => {
  const s = await makeRun(repos(), [{ id: "T-1", title: "Endpoint", repos: ["api"] }]);
  try {
    const sh = repoShell({ api: "10\t2\tsrc/e.ts\n", handbook: "4\t0\tapi.md\n" });
    const r = await runLead(s, sh.shell);
    const t = getTicket((await s.hub.get(s.id)).board, "T-1");
    expect(t.state).toBe("done");
    expect(sh.checks()).toEqual([]);
    expect(t.touched?.map((x) => x.repo)).toEqual(["api", "handbook"]);
    expect(t.diff).toEqual({ added: 14, removed: 2, files: 2 });
    expect(t.notes.map((n) => n.text).join("\n")).toContain("planned api; touched api, handbook");
    expect(r.prompts[0]).toContain("### /workspace/api");
    expect(r.prompts[0]).toContain("### /workspace/handbook: 1 files, +4 −0");
    // The review diffed each repository from its baseline.
    expect(sh.calls.filter((c) => c.cmd === `git diff --cached ${BASE}`).map((c) => c.dir)).toEqual(["api", "handbook"]);
    expect(sh.commits.slice(0, 2).map((c) => c.dir)).toEqual(["api", "handbook"]);
    expect(sh.commits[0]!.args).toContain("Verstas-Repos: api, handbook");
  } finally {
    await fs.rm(s.root, { recursive: true, force: true });
  }
});

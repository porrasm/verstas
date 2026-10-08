import { test, expect } from "@playwright/test";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createAgentApi, RunTokens, type AgentRunHooks } from "../../src/agent-api/agent-api.js";
import { emptyBoard, getTicket, importBoard, parseMarkdownBoard, replaceTicket } from "../../src/board/board.js";
import { saveBoard, writeJsonAtomic } from "../../src/board/store.js";
import { checkFiles, effectivePolicy, inboxSchema, now, sessionSchema, ticketSchema, type RepoSpec } from "../../src/core/types.js";
import { earlierAttempts, guardHits, mergePolicy, planChecks, plannedVsTouched, reviewLevel, type RepoChange } from "../../src/harness/judging.js";
import { reviewerPrompt } from "../../src/harness/prompts.js";
import { RunManager, type Shell, type WorkerRunner } from "../../src/harness/run.js";
import { SessionHub } from "../../src/sessions/hub.js";
import { sessionPaths } from "../../src/sessions/sessions.js";
import type { Job } from "../../src/worker/worker.js";

/**
 * Judging a change that may touch any subset of a session's repositories:
 * the rules (pure), the run with a shell that answers per repository, and
 * the agent API that lets the agents keep each repository's policy.
 */

const repo = (name: string, extra: Partial<RepoSpec> = {}): RepoSpec => ({ name, sourcePath: `/x/${name}`, branch: "main", runBranch: "verstas/t", ...extra });
const agent = (p: Omit<NonNullable<RepoSpec["agentPolicy"]>, "setBy">): RepoSpec["agentPolicy"] => ({ ...p, setBy: {} });
const change = (r: string, paths: string[] = ["src/a.ts"]): RepoChange => ({ repo: r, added: 3, removed: 1, files: paths.length, stat: "", diff: `diff ${r}`, paths, scattered: [] });

const session = {
  repos: [
    repo("api", { agentPolicy: agent({ check: "bash scripts/check.sh", review: "full" }) }),
    repo("web", { agentPolicy: agent({ check: "npm test", review: "full" }) }),
    repo("types", { agentPolicy: agent({ check: "npm run typecheck", alsoCheck: ["api", "web"] }) }),
    repo("handbook", { agentPolicy: agent({ check: null, review: "none" }) }),
  ],
};

test("a change runs the checks of the repositories it touched, plus their also-checks, and nobody else's", () => {
  const names = (changed: string[], override?: Map<string, string | null>) => planChecks(session, changed, override).map((c) => `${c.repo.name}:${c.why}`);
  expect(names(["api"])).toEqual(["api:changed"]);
  expect(names(["web"])).toEqual(["web:changed"]);
  expect(names(["handbook"])).toEqual([]); // no check
  expect(names(["api", "handbook"])).toEqual(["api:changed"]);
  expect(names(["types"])).toEqual(["api:types changed", "web:types changed", "types:changed"]);
  expect(names([])).toEqual([]);
  // A proposed check replaces the repository's own and runs even when that repository is untouched.
  const proposed = planChecks(session, ["api"], new Map([["handbook", "npx markdownlint ."]]));
  expect(proposed.map((c) => [c.repo.name, c.policy.check])).toEqual([["api", { kind: "command", command: "bash scripts/check.sh" }], ["handbook", { kind: "command", command: "npx markdownlint ." }]]);
});

test("your fields win over the agents', and the agents' over the defaults", () => {
  expect(effectivePolicy(repo("a"))).toMatchObject({ check: { kind: "auto" }, checkFrom: "default", review: undefined, alsoCheck: [] });
  expect(effectivePolicy(repo("a", { agentPolicy: agent({ check: null }) }))).toMatchObject({ check: { kind: "none" }, checkFrom: "agents" });
  expect(effectivePolicy(repo("a", { check: "make test", agentPolicy: agent({ check: null, review: "none" }) }))).toMatchObject({ check: { kind: "command", command: "make test" }, checkFrom: "you", review: "none" });
  expect(effectivePolicy(repo("a", { noCheck: true, review: "full", agentPolicy: agent({ check: "npm test", review: "none" }) }))).toMatchObject({ check: { kind: "none" }, checkFrom: "you", review: "full" });
  // The check's own files are guarded: its script, and package.json for a package script.
  expect(checkFiles("bash scripts/check.sh")).toEqual(["scripts/check.sh"]);
  expect(checkFiles("npm test && node ./tools/ci.mjs --fast")).toEqual(["tools/ci.mjs", "package.json"]);
  expect(checkFiles("make check")).toEqual(["Makefile"]);
});

test("the review level is the strictest of the touched repositories; a check's files or a proposal call the reviewer; your ticket setting wins", () => {
  const caps = { reviewer: true };
  const none = { guarded: [], proposals: [] };
  expect(reviewLevel({}, caps, session, [change("handbook")], none)).toMatchObject({ mode: "none" });
  expect(reviewLevel({}, caps, session, [change("handbook"), change("api")], none)).toMatchObject({ mode: "full" });
  expect(reviewLevel({}, { reviewer: false }, session, [change("types")], none)).toMatchObject({ mode: "checks" }); // types inherits the session's
  expect(reviewLevel({}, { reviewer: false }, session, [], none)).toMatchObject({ mode: "checks" });
  expect(reviewLevel({}, caps, session, [change("handbook")], { guarded: ["handbook/x.sh"], proposals: [] })).toMatchObject({ mode: "full" });
  expect(reviewLevel({}, caps, session, [change("handbook")], { guarded: [], proposals: [{ repo: "handbook", patch: { check: "x" }, reason: "r", at: now() }] })).toMatchObject({ mode: "full" });
  expect(reviewLevel({ review: "checks" }, caps, session, [change("api")], { guarded: ["api/scripts/check.sh"], proposals: [] })).toMatchObject({ mode: "checks", why: "the ticket's own setting" });
  expect(guardHits(session, [change("api", ["scripts/check.sh", "src/a.ts"]), change("web", ["package.json"])])).toEqual(["api/scripts/check.sh", "web/package.json"]);
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

test("an agent's policy change records who and why, and leaves the fields you set alone", () => {
  const r = repo("api", { review: "full", agentPolicy: agent({ check: "npm test" }) });
  const m = mergePolicy(r, { check: "bash scripts/check.sh", review: "none", guardPaths: ["vitest.config.ts"] }, { by: "lead", reason: "faster", at: "t" });
  expect(m.refused).toEqual(["review"]);
  expect(m.policy).toMatchObject({ check: "bash scripts/check.sh", guardPaths: ["vitest.config.ts"], setBy: { check: { by: "lead", reason: "faster" }, guardPaths: { by: "lead" } } });
  expect(m.policy.review).toBeUndefined();
});

test("tickets read the older single repo as a list, and the board format takes several", () => {
  expect(ticketSchema.parse({ id: "T-1", title: "x", repo: "api", createdAt: "t", updatedAt: "t" }).repos).toEqual(["api"]);
  expect(ticketSchema.parse({ id: "T-1", title: "x", createdAt: "t", updatedAt: "t" }).repos).toEqual([]);
  const md = parseMarkdownBoard("## T-1 · Endpoint (S)\nRepos: api, handbook · Priority: 5\nDo it.\n");
  expect(md.tickets[0]).toMatchObject({ repos: ["api", "handbook"], priority: 5 });
  expect(importBoard(emptyBoard(), { tickets: [{ title: "Old", repo: "api" }] }).board.tickets[0]!.repos).toEqual(["api"]);
});

test("the reviewer sees one section per repository, the reviewed ones first and context last", () => {
  const t = ticketSchema.parse({ id: "T-1", title: "Endpoint", repos: ["api"], createdAt: "t", updatedAt: "t" });
  const prompt = reviewerPrompt(t, [change("handbook"), change("api")], [], undefined, { why: "the strictest of handbook, api (api)", planned: "planned api; touched handbook, api", proposals: [], guarded: [], context: ["handbook"] });
  expect(prompt.indexOf("### /workspace/api")).toBeLessThan(prompt.indexOf("### /workspace/handbook"));
  expect(prompt).toContain("context: this repository's changes need no review of their own");
  expect(prompt).toContain("planned api; touched handbook, api");
});

// --- The run, with a shell that answers per repository ---------------------

/** Repositories with a staged change (numstat lines) and check commands that fail; everything else succeeds. */
const repoShell = (changed: Record<string, string>, failing: string[] = []) => {
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
      if (cmd[0] === "bash" && cmd[1] === "-lc") return failing.includes(`${dir}:${cmd[2]}`) ? { code: 1, stdout: "", stderr: "boom" } : { code: 0, stdout: "ok", stderr: "" };
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

const repos = () => [repo("api", { agentPolicy: agent({ check: "bash scripts/check.sh", review: "full" }) }), repo("handbook", { agentPolicy: agent({ check: null, review: "none" }) })];

test("a change to the handbook alone runs no check and no reviewer; it is accepted and committed there only", async () => {
  const s = await makeRun(repos(), [{ id: "T-1", title: "Typo", repos: ["handbook"] }]);
  try {
    const sh = repoShell({ handbook: "1\t1\tguide.md\n" });
    const w = worker(s.hub, s.id);
    await (await runWith(s, sh.shell, w).start(s.id)).done;
    const t = getTicket((await s.hub.get(s.id)).board, "T-1");
    expect(t.state).toBe("done");
    expect(sh.checks()).toEqual([]);
    expect(w.jobs.map((j) => j.role)).toEqual(["implementer"]);
    expect(t.touched).toEqual([{ repo: "handbook", added: 1, removed: 1, files: 1, check: "skipped" }]);
    expect(sh.commits.map((c) => c.dir)).toEqual(["handbook"]);
    expect(sh.commits[0]!.args).toContain("Verstas-Ticket: T-1");
  } finally {
    await fs.rm(s.root, { recursive: true, force: true });
  }
});

test("a ticket that also touched an unplanned repository is judged by both: api's check, one reviewer over both, commits in both", async () => {
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
    expect(sh.checks()).toEqual(["api:bash scripts/check.sh"]);
    expect(t.touched?.map((x) => [x.repo, x.check])).toEqual([["api", "passed"], ["handbook", "none"]]);
    expect(t.diff).toEqual({ added: 14, removed: 2, files: 2 });
    expect(t.notes.map((n) => n.text).join("\n")).toContain("planned api; touched api, handbook");
    expect(prompts[0]).toContain("### /workspace/api");
    expect(prompts[0]).toContain("### /workspace/handbook: 1 files, +4 −0 (context");
    expect(sh.commits.map((c) => c.dir)).toEqual(["api", "handbook"]);
    expect(sh.commits[0]!.args).toContain("Verstas-Repos: api, handbook");
  } finally {
    await fs.rm(s.root, { recursive: true, force: true });
  }
});

test("a failing check sends the ticket back naming the repository; a proposed check is tried and applied on acceptance", async () => {
  const s = await makeRun(repos(), [{ id: "T-1", title: "Lint docs", repos: ["handbook"] }], { ticketAttempts: 3 });
  try {
    const h = await s.hub.get(s.id);
    await h.mutate((d) => ({ next: { board: replaceTicket(d.board, { ...getTicket(d.board, "T-1"), policyProposals: [{ repo: "handbook", patch: { check: "npx markdownlint .", review: "checks" }, reason: "the docs have a linter now", at: now() }] }) } }));
    // First attempt: the proposed check fails. Second: it passes.
    let fail = true;
    const sh = repoShell({ handbook: "2\t0\tguide.md\n" });
    const exec = sh.shell.exec.bind(sh.shell);
    sh.shell.exec = async (cmd, opts) => (cmd[2] === "npx markdownlint ." && fail ? { code: 1, stdout: "", stderr: "MD001" } : exec(cmd, opts));
    const w = worker(s.hub, s.id);
    const base = w.run.bind(w);
    w.run = async (job, onEvent, signal) => {
      const out = await base(job, onEvent, signal);
      if (job.role === "implementer" && getTicket((await s.hub.get(s.id)).board, "T-1").attempts === 1) fail = false;
      return out;
    };
    await (await runWith(s, sh.shell, w).start(s.id)).done;
    const after = await s.hub.get(s.id);
    const t = getTicket(after.board, "T-1");
    expect(t.state).toBe("done");
    expect(t.attempts).toBe(2);
    expect(t.notes.map((n) => n.text).join("\n")).toContain("failed twice; no reviewer ran");
    expect(t.notes.map((n) => n.text).join("\n")).toContain("in handbook (the check this ticket proposes)");
    // The proposal called the reviewer (a policy change is reviewed) and then applied.
    expect(w.jobs.filter((j) => j.role === "reviewer")).toHaveLength(1);
    expect(t.policyProposals).toBeUndefined();
    const hb = after.session.repos.find((r) => r.name === "handbook")!;
    expect(hb.agentPolicy).toMatchObject({ check: "npx markdownlint .", review: "checks", setBy: { check: { by: "ticket", ticket: "T-1", reason: "the docs have a linter now" } } });
  } finally {
    await fs.rm(s.root, { recursive: true, force: true });
  }
});

test("a change to a check's own file always gets the reviewer, even in a repository that needs none", async () => {
  const s = await makeRun([repo("ops", { agentPolicy: agent({ check: "bash ci/check.sh", review: "none" }) })], [{ id: "T-1", title: "Speed up" }]);
  try {
    const sh = repoShell({ ops: "1\t5\tci/check.sh\n" });
    const w = worker(s.hub, s.id);
    await (await runWith(s, sh.shell, w).start(s.id)).done;
    expect(w.jobs.map((j) => j.role)).toEqual(["implementer", "reviewer"]);
    expect(getTicket((await s.hub.get(s.id)).board, "T-1").notes.map((n) => n.text).join("\n")).toContain("judged: full (it changes the check's own files (ops/ci/check.sh))");
  } finally {
    await fs.rm(s.root, { recursive: true, force: true });
  }
});

// --- The agent API: who may set a policy ------------------------------------

test("setup sets a repository's policy after its check passes; a worker cannot; your fields are refused; the lead's change reaches your inbox", async () => {
  const s = await makeRun([repo("api", { review: "full" }), repo("handbook")], [{ id: "T-1", title: "x" }]);
  const tokens = new RunTokens();
  const verified: string[] = [];
  const hooks: AgentRunHooks = {
    submitted: () => undefined,
    handoff: () => undefined,
    verifyCheck: async (_s, r, command) => {
      verified.push(`${r}:${command}`);
      return command.includes("broken") ? { ok: false, summary: "failed twice (exit 1)", tail: "boom" } : { ok: true, summary: "passed", tail: "" };
    },
  };
  const server = createAgentApi(s.hub, tokens, hooks).listen(0, "127.0.0.1");
  const port = await new Promise<number>((r) => server.on("listening", () => r((server.address() as net.AddressInfo).port)));
  const as = (role: "worker" | "lead", job: string, currentTicket?: string) => tokens.issue({ sessionId: s.id, runId: 1, role, job, currentTicket });
  const call = async (token: string, method: string, p: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}/agent${p}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  try {
    const setup = as("worker", "setup");
    expect((await call(setup, "PUT", "/repos/api/policy", { check: "npm test", reason: "the suite, 40 s" })).status).toBe(200);
    expect((await call(setup, "PUT", "/repos/handbook/policy", { check: null, review: "none", reason: "markdown only" })).status).toBe(200);
    const broken = await call(setup, "PUT", "/repos/api/policy", { check: "broken.sh", reason: "x" });
    expect(broken.status).toBe(422);
    expect(String(broken.json.error)).toContain("fails in api");
    expect((await call(setup, "PUT", "/repos/api/policy", { review: "none", reason: "x" })).status).toBe(403); // yours
    expect((await call(setup, "PUT", "/repos/api/policy", { alsoCheck: ["api"], reason: "x" })).status).toBe(400);
    expect((await call(as("worker", "implementer", "T-1"), "PUT", "/repos/api/policy", { check: "true", reason: "x" })).status).toBe(403);
    expect((await call(as("worker", "reviewer", "T-1"), "POST", "/repos/api/policy/propose", { check: "true", reason: "x" })).status).toBe(403);
    expect((await call(as("lead", "lead"), "PUT", "/repos/api/policy", { check: "npm test -- --bail", reason: "stop at the first failure" })).status).toBe(200);
    expect(verified).toEqual(["api:npm test", "api:broken.sh", "api:npm test -- --bail"]);

    const h = await s.hub.get(s.id);
    expect(h.session.repos.map((r) => effectivePolicy(r))).toMatchObject([{ check: { kind: "command", command: "npm test -- --bail" }, checkFrom: "agents", review: "full" }, { check: { kind: "none" }, review: "none" }]);
    expect(h.session.repos[0]!.agentPolicy?.setBy.check).toMatchObject({ by: "lead", reason: "stop at the first failure" });
    expect(h.inbox.messages.map((m) => m.text)).toEqual(['The lead changed the check policy of api: check "npm test -- --bail". Why: stop at the first failure']);
    const got = await call(setup, "GET", "/repos/policy");
    expect((got.json.repos as { name: string; setByUser: string[] }[]).map((r) => [r.name, r.setByUser])).toEqual([["api", ["review"]], ["handbook", []]]);
  } finally {
    await new Promise((r) => server.close(r));
    await fs.rm(s.root, { recursive: true, force: true });
  }
});

test("the worker holding a ticket proposes a policy change; it waits on the ticket, newest per repository", async () => {
  const s = await makeRun([repo("api"), repo("handbook")], [{ id: "T-1", title: "x" }]);
  const tokens = new RunTokens();
  const server = createAgentApi(s.hub, tokens).listen(0, "127.0.0.1");
  const port = await new Promise<number>((r) => server.on("listening", () => r((server.address() as net.AddressInfo).port)));
  try {
    const h = await s.hub.get(s.id);
    await h.mutate((d) => ({ next: { board: { ...d.board, tickets: d.board.tickets.map((t) => ({ ...t, state: "in_progress" as const })) } } }));
    const token = tokens.issue({ sessionId: s.id, runId: 1, role: "worker", job: "implementer", currentTicket: "T-1" });
    const propose = (body: unknown) => fetch(`http://127.0.0.1:${port}/agent/repos/api/policy/propose`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.status);
    expect(await propose({ check: "npm test", reason: "tests exist now" })).toBe(200);
    expect(await propose({ check: "npm test && npm run lint", reason: "and a lint" })).toBe(200);
    const t = getTicket((await s.hub.get(s.id)).board, "T-1");
    expect(t.policyProposals?.map((p) => [p.repo, p.patch.check])).toEqual([["api", "npm test && npm run lint"]]);
  } finally {
    await new Promise((r) => server.close(r));
    await fs.rm(s.root, { recursive: true, force: true });
  }
});

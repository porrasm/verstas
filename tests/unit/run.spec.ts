import { test, expect } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgentApi, RunTokens } from "../../src/agent-api/agent-api.js";
import type net from "node:net";
import { importBoard, emptyBoard, getTicket, transition } from "../../src/board/board.js";
import { saveBoard, writeJsonAtomic } from "../../src/board/store.js";
import { inboxSchema, now, requestSchema, reviseGoal, sessionSchema, type VerstasEvent } from "../../src/core/types.js";
import { parseVerdict, RunManager, type Shell, type WorkerDone, type WorkerRunner } from "../../src/harness/run.js";
import { SessionHub } from "../../src/sessions/hub.js";
import { sessionPaths } from "../../src/sessions/sessions.js";
import type { Job } from "../../src/worker/worker.js";

/**
 * The loop with fakes: a shell that answers git like a repository with a
 * change in the working tree, and a lead scripted against the real agent
 * API on a local port, the way the board server inside the box would call
 * it. What is asserted is the loop's decisions: board moves, commit
 * messages, run state, what each prompt carries.
 */

/** Every repository's HEAD, as the fake shell reports it: the baseline of a ticket that enters in_progress. */
const BASE = "1111111111111111111111111111111111111111";

const makeSession = async (
  opts: {
    reviewer?: boolean;
    goal?: string;
    /** Minutes between progress checks (the default is 30; 0 is off). */
    progressMinutes?: number;
    leadMinutes?: number;
    leadTurns?: number;
    /** false: a plan that still needs Initialize (the default is an initialized session). */
    initialized?: boolean;
    agents?: { worker?: { driver: "claude" | "codex" | "cursor"; model?: string }; reviewer?: { driver: "claude" | "codex" | "cursor"; model?: string } };
    /** The board; the default has T-1 ready and T-2 ready after T-1. */
    tickets?: unknown[];
  } = {},
) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "verstas-run-"));
  const id = "2026-10-03-run";
  const paths = sessionPaths(root, id);
  await fs.mkdir(paths.workspace, { recursive: true });
  await fs.mkdir(paths.runs, { recursive: true });
  await fs.mkdir(paths.notes, { recursive: true });
  await writeJsonAtomic(
    paths.session,
    sessionSchema.parse({
      id,
      name: "run",
      createdAt: now(),
      initializedAt: opts.initialized === false ? null : now(),
      repos: [{ name: "app", sourcePath: "/x", branch: "main", runBranch: `verstas/${id}` }],
      goal: opts.goal ?? "",
      agents: opts.agents ?? {},
      caps: {
        reviewer: opts.reviewer ?? true,
        ...(opts.progressMinutes !== undefined ? { progressMinutes: opts.progressMinutes } : {}),
        ...(opts.leadMinutes ? { leadMinutes: opts.leadMinutes } : {}),
        ...(opts.leadTurns ? { leadTurns: opts.leadTurns } : {}),
      },
    }),
  );
  const tickets = opts.tickets ?? [{ id: "T-1", title: "Schema", state: "ready", repo: "app" }, { id: "T-2", title: "Engine", state: "ready", deps: ["T-1"] }];
  await saveBoard(paths.dir, tickets.length ? importBoard(emptyBoard("g"), { tickets }).board : emptyBoard("g"));
  await writeJsonAtomic(paths.inbox, inboxSchema.parse({}));
  return { root, id, paths, hub: new SessionHub(root) };
};

type FakeShell = Shell & {
  commits: string[];
  /** Every commit command in full, for the trailers. */
  commitArgs: string[][];
  calls: string[][];
  /** The numstat of the working tree (and of a diff from the baseline). */
  numstat: string;
  /** `git log <base>..HEAD` in the review's format: sha, subject, Verstas-Ticket trailers. */
  log: string;
  /** Whether the working tree is dirty (`git diff --cached --quiet` exits 1). */
  dirty: boolean;
};

const fakeShell = (): FakeShell => {
  const sh: FakeShell = {
    commits: [],
    commitArgs: [],
    calls: [],
    numstat: "3\t1\tsrc/a.ts\n",
    log: "",
    dirty: true,
    async exec(cmd) {
      sh.calls.push([...cmd]);
      const s = cmd.join(" ");
      if (s === "git rev-parse HEAD") return { code: 0, stdout: `${BASE}\n`, stderr: "" };
      if (cmd[0] === "git" && cmd[1] === "log" && s.includes("Verstas-Ticket")) return { code: 0, stdout: sh.log, stderr: "" };
      if (s.startsWith("git log --oneline")) return { code: 0, stdout: "", stderr: "" };
      if (s === "git diff --cached --numstat" || s === `git diff --cached --numstat ${BASE}`) return { code: 0, stdout: sh.dirty || s.endsWith(BASE) ? sh.numstat : "", stderr: "" };
      if (s === "git diff --cached --stat" || s === `git diff --cached --stat ${BASE}`) return { code: 0, stdout: " src/a.ts | 4 +-", stderr: "" };
      if (s === "git diff --cached" || s === `git diff --cached ${BASE}`) return { code: 0, stdout: "diff --git a/src/a.ts", stderr: "" };
      if (s === "git diff --cached --quiet") return { code: sh.dirty ? 1 : 0, stdout: "", stderr: "" };
      if (cmd[0] === "git" && cmd[1] === "show") return { code: 0, stdout: s.includes("--numstat") ? "2\t0\tsrc/b.ts\n" : `diff --git a/src/b.ts (${cmd[cmd.length - 1]})`, stderr: "" };
      if (s.includes("commit")) {
        sh.commits.push(cmd[cmd.length - 1]!);
        sh.commitArgs.push([...cmd]);
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  return sh;
};

/** A path inside the container, on the host. */
const onHost = (s: { paths: { workspace: string } }, p: string): string => p.replace(/^\/workspace/, s.paths.workspace);

type Api = (method: string, p: string, body?: unknown) => Promise<{ status: number; json: Record<string, unknown> }>;
/** The script of every job but the reviewer: the lead or a prompt. `n` counts the jobs so far. */
type Script = (api: Api, job: Job, n: number, signal: AbortSignal) => Promise<Partial<WorkerDone>>;

/**
 * A run against the real agent API on a local port. The reviewer is
 * scripted by `verdict`; every other job runs `script` with an API client
 * bound to that job's own run token.
 */
const harness = async (
  s: Awaited<ReturnType<typeof makeSession>>,
  script: Script,
  opts: {
    verdict?: (ticket: string | undefined) => string;
    reviewerRateLimited?: boolean;
    heal?: (mgr: RunManager) => Promise<string[]>;
    shell?: FakeShell;
    /** How long a minute of progressMinutes is (ms). */
    progressMinuteMs?: number;
    secrets?: string[];
    snapshots?: string[];
  } = {},
) => {
  const tokens = new RunTokens();
  const shell = opts.shell ?? fakeShell();
  const jobs: Job[] = [];
  /** The prompts of every job but the reviewer, in order. */
  const prompts: string[] = [];
  /** What the harness sent the live worker (messages from the user, the pause nudge, progress checks). */
  const sent: string[] = [];
  const seen: { role: string; token: string; info: unknown }[] = [];
  let n = 0;
  let port = 0;
  const worker: WorkerRunner = {
    async run(job, _onEvent, signal, o) {
      jobs.push(job);
      seen.push({ role: job.role, token: o!.runToken!, info: tokens.lookup(o!.runToken!) });
      o?.attach?.({ driver: job.driver ?? "claude", send: (t) => (sent.push(t), true) });
      const base = { kind: "worker_done" as const, t: now(), ticket: job.ticket, role: job.role, ok: true, stopReason: "success", rateLimited: false, costUsd: 0.1, turns: 3, seconds: 1, text: "", stderr: "" };
      if (job.role === "reviewer") return opts.reviewerRateLimited ? { ...base, ok: false, rateLimited: true, stopReason: "error" } : { ...base, text: opts.verdict?.(job.ticket) ?? "VERDICT: ok" };
      prompts.push(await fs.readFile(onHost(s, job.promptFile), "utf8"));
      const api: Api = async (method, p, body) => {
        const res = await fetch(`http://127.0.0.1:${port}/agent${p}`, { method, headers: { authorization: `Bearer ${o!.runToken}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: res.status, json: (await res.json()) as Record<string, unknown> };
      };
      const out = await script(api, job, ++n, signal);
      return { ...base, stopReason: signal.aborted ? "aborted" : "success", ...out };
    },
  };
  const mgr: RunManager = new RunManager({
    hub: s.hub,
    tokens,
    shell: () => shell,
    worker: () => worker,
    ensureSandbox: async () => undefined,
    agentApiUrl: "http://host.docker.internal:4701/agent",
    rateLimitSleepMs: 20,
    handoffGraceMs: 50,
    progressMinuteMs: opts.progressMinuteMs,
    healSandbox: opts.heal ? () => opts.heal!(mgr) : undefined,
    secrets: opts.secrets ? async () => opts.secrets! : undefined,
    snapshotSandbox: opts.snapshots
      ? async (session) => {
          opts.snapshots!.push(session.id);
          return { image: "verstas-snap-x", baseImageId: "sha256:base" };
        }
      : undefined,
  });
  const server = createAgentApi(s.hub, tokens, mgr).listen(0, "127.0.0.1");
  port = await new Promise<number>((r) => server.on("listening", () => r((server.address() as net.AddressInfo).port)));
  return { mgr, tokens, jobs, prompts, shell, sent, seen, close: () => server.close() };
};

/** What board_move does: move, and for a move to review wait for the verdict. */
const move = async (api: Api, id: string, to: string, note?: string) => {
  const r = await api("POST", `/tickets/${id}/move`, { to, ...(note ? { note } : {}) });
  if (r.status !== 200 || to !== "review") return r.json;
  for (;;) {
    await new Promise((res) => setTimeout(res, 5));
    const t = (await api("GET", `/tickets/${id}`)).json;
    if (t.state !== "review") return t;
  }
};

const start = (api: Api, id: string) => api("POST", `/tickets/${id}/move`, { to: "in_progress" });

const finishTicket = async (api: Api, id: string) => {
  expect((await start(api, id)).status).toBe(200);
  await api("POST", `/tickets/${id}/report`, { report: `${id} done` });
  return move(api, id, "review");
};

const events = async (s: Awaited<ReturnType<typeof makeSession>>, run = 1): Promise<VerstasEvent[]> =>
  (await fs.readFile(path.join(s.paths.runs, String(run), "events.jsonl"), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as VerstasEvent);

// --- The board alone -----------------------------------------------------------

test("one lead works the board: it moves tickets itself, the harness judges what it moves to review and commits each ticket", async () => {
  const s = await makeSession();
  const r = await harness(s, async (api, job) => {
    expect(job.role).toBe("lead");
    // Deps are the lead's to read: T-2 waits on T-1 only if the lead says so.
    expect((await api("GET", "/board")).json.tickets).toHaveLength(2);
    expect(await finishTicket(api, "T-1")).toMatchObject({ state: "done" });
    const t2 = (await api("GET", "/tickets/T-2")).json;
    expect(t2.baseline).toBeUndefined();
    expect(await finishTicket(api, "T-2")).toMatchObject({ state: "done" });
    return { text: "board done" };
  });
  try {
    const run = await (await r.mgr.start(s.id)).done;
    expect(run.state).toBe("finished");
    expect(run.ticketsDone).toBe(2);
    expect(run.rounds).toBe(1);
    expect(r.jobs.map((j) => j.role)).toEqual(["lead", "reviewer", "reviewer"]);
    // The ticket commits, then the backup commit of the life (nothing left uncommitted: the fake tree is dirty, so it commits too).
    expect(r.shell.commits.slice(0, 2)).toEqual(["T-1: Schema", "T-2: Engine"]);
    expect(r.shell.commitArgs[0]).toContain("Verstas-Ticket: T-1");
    const lead = r.jobs[0]!;
    // No lead cap unless the session sets one, and no budget.
    expect(lead.caps).toEqual({});
    expect(lead.agentSession).toMatchObject({ resume: false });
    expect(r.prompts[0]).toContain("# The session");
    expect(r.prompts[0]).toContain("(No goal is written");
    expect(r.prompts[0]).toContain("T-2 [ready] Engine");
    const sys = await fs.readFile(onHost(s, lead.systemPromptFile), "utf8");
    expect(sys).toContain("Role: lead");
    expect(sys).toContain("how you work is yours to decide");
    const h = await s.hub.get(s.id);
    expect(h.board.tickets.map((t) => t.state)).toEqual(["done", "done"]);
    expect(h.board.tickets[0]!.baseline).toBeUndefined(); // cleared at done
    expect(h.board.tickets[0]!.diff).toEqual({ added: 3, removed: 1, files: 1 });
    expect(h.board.tickets[0]!.notes.map((n) => n.text)).toEqual(expect.arrayContaining([expect.stringContaining("Moved to in_progress by the lead"), expect.stringContaining("Moved to review by the lead"), expect.stringContaining("Reviewed ok")]));
    expect(h.session.state).toBe("finished");
    expect(await fs.readFile(path.join(s.paths.workspace, "VERSTAS.md"), "utf8")).toContain("/workspace/app");
    expect(await fs.readFile(path.join(s.paths.runs, "1", "tickets", "T-1.md"), "utf8")).toContain("T-1 done");
  } finally {
    r.close();
    await fs.rm(s.root, { recursive: true, force: true });
  }
});

test("a move into in_progress records the baseline the review reads from; a requeued ticket keeps it", async () => {
  const s = await makeSession();
  let reviews = 0;
  const r = await harness(
    s,
    async (api) => {
      expect((await start(api, "T-1")).status).toBe(200);
      expect((await api("GET", "/tickets/T-1")).json.baseline).toEqual({ app: BASE });
      expect(await move(api, "T-1", "review")).toMatchObject({ state: "ready" });
      // Back to ready with the baseline kept, so the earlier commits stay in the next review.
      expect((await api("GET", "/tickets/T-1")).json.baseline).toEqual({ app: BASE });
      expect((await start(api, "T-1")).status).toBe(200);
      expect(await move(api, "T-1", "review")).toMatchObject({ state: "done" });
      expect(await finishTicket(api, "T-2")).toMatchObject({ state: "done" });
      return {};
    },
    { verdict: () => (++reviews === 1 ? "VERDICT: fixable\nno test for the null case" : "VERDICT: ok") },
  );
  try {
    expect((await (await r.mgr.start(s.id)).done).ticketsDone).toBe(2);
    // The review diffs from the baseline; nothing is committed on a fixable verdict.
    expect(r.shell.calls).toContainEqual(["git", "diff", "--cached", BASE]);
    expect(r.shell.commits.filter((c) => c.startsWith("T-1"))).toEqual(["T-1: Schema"]);
    const t1 = getTicket((await s.hub.get(s.id)).board, "T-1");
    expect(t1.notes.map((n) => n.text).join("\n")).toContain("Not done yet (no test for the null case); the reviewer's notes are on the ticket");
  } finally {
    r.close();
    await fs.rm(s.root, { recursive: true, force: true });
  }
});

test("several tickets in progress: a review reads the commits that carry the ticket's id since its baseline, lists the others, and the backup commit names every ticket in progress", async () => {
  const s = await makeSession();
  const shell = fakeShell();
  shell.log = ["aaaaaaa1\tT-2: engine core\tT-2", "bbbbbbb2\tT-1: the schema\t", "ccccccc3\tfix typo\t", "ddddddd4\tT-1 (wip): parser\tT-1"].join("\n");
  const r = await harness(
    s,
    async (api, _job, n) => {
      if (n > 1) {
        // The lives that follow change nothing: a clean tree, no board move.
        shell.dirty = false;
        return { text: "nothing more from me" };
      }
      expect((await start(api, "T-1")).status).toBe(200);
      expect((await start(api, "T-2")).status).toBe(200);
      expect(await move(api, "T-1", "review")).toMatchObject({ state: "done" });
      return { text: "T-1 is in; T-2 continues" };
    },
    { shell },
  );
  try {
    const run = await (await r.mgr.start(s.id)).done;
    const reviewPrompt = await fs.readFile(onHost(s, r.jobs.find((j) => j.role === "reviewer")!.promptFile), "utf8");
    expect(reviewPrompt).toContain("This ticket's commits (in the diff): bbbbbbb2 T-1: the schema; ddddddd4 T-1 (wip): parser");
    expect(reviewPrompt).toContain("Other tickets' commits in the range (not in the diff): aaaaaaa1 T-2: engine core");
    expect(reviewPrompt).toContain("Commits in the range that name no ticket (not in the diff; look at them): ccccccc3 fix typo");
    expect(reviewPrompt).toContain("## working tree (uncommitted)");
    // With another ticket in progress the harness does not commit T-1's working tree under T-1; the life's backup commit takes it, labelled.
    expect(r.shell.commits.some((c) => c.startsWith("T-1: "))).toBe(false);
    const backup = r.shell.commitArgs.find((c) => c[c.length - 1]!.startsWith("Lead 1.1: "))!;
    expect(backup).toContain("Verstas-Ticket: T-2");
    // The run paused: T-2 was left in progress by a lead that ended; the next run's lead takes it up.
    expect(run.pauseReason).toContain("twice without");
    expect((await s.hub.get(s.id)).board.tickets.map((t) => `${t.id}:${t.state}`)).toEqual(["T-1:done", "T-2:ready"]);
  } finally {
    r.close();
    await fs.rm(s.root, { recursive: true, force: true });
  }
});

test("a fixable verdict returns the ticket to ready with the notes every time (no attempt cap); blocked blocks it", async () => {
  const s = await makeSession({ tickets: [{ id: "T-1", title: "Schema", state: "ready" }] });
  let reviews = 0;
  const r = await harness(
    s,
    async (api) => {
      for (let i = 0; i < 3; i++) expect(await finishTicket(api, "T-1")).toMatchObject({ state: "ready" });
      expect(await finishTicket(api, "T-1")).toMatchObject({ state: "blocked" });
      return {};
    },
    { verdict: () => (++reviews <= 3 ? "VERDICT: fixable\nagain" : "VERDICT: blocked\ncannot be done as written") },
  );
  try {
    const run = await (await r.mgr.start(s.id)).done;
    // Nothing left that can run: the board's one ticket is blocked.
    expect(run.state).toBe("finished");
    const t1 = getTicket((await s.hub.get(s.id)).board, "T-1");
    expect(t1.notes.filter((n) => n.text.startsWith("Not done yet"))).toHaveLength(3);
    expect(t1.notes.at(-1)!.text).toContain("Reviewer: blocked. cannot be done as written");
    expect(r.shell.commits.filter((c) => c.startsWith("T-1"))).toEqual([]);
  } finally {
    r.close();
    await fs.rm(s.root, { recursive: true, force: true });
  }
});

test("with the reviewer off the lead moves tickets to done itself; with it on, done comes from the verdict and the lead's move is refused", async () => {
  const on = await makeSession();
  const r1 = await harness(on, async (api) => {
    expect((await start(api, "T-1")).status).toBe(200);
    const refused = await api("POST", "/tickets/T-1/move", { to: "done" });
    expect(refused.status).toBe(403);
    expect(String(refused.json.error)).toContain("through review");
    expect(await move(api, "T-1", "review")).toMatchObject({ state: "done" });
    // Out of review is the harness's; into waiting is a request's.
    expect((await api("POST", "/tickets/T-2/move", { to: "waiting" })).status).toBe(403);
    expect(await finishTicket(api, "T-2")).toMatchObject({ state: "done" });
    return {};
  });
  try {
    expect((await (await r1.mgr.start(on.id)).done).ticketsDone).toBe(2);
  } finally {
    r1.close();
    await fs.rm(on.root, { recursive: true, force: true });
  }

  const off = await makeSession({ reviewer: false });
  const r2 = await harness(off, async (api) => {
    expect((await start(api, "T-1")).status).toBe(200);
    expect((await api("POST", "/tickets/T-1/move", { to: "done", note: "schema in, tests pass" })).status).toBe(200);
    // Review still works without a reviewer: the lead's word is the verdict.
    expect(await finishTicket(api, "T-2")).toMatchObject({ state: "done" });
    return {};
  });
  try {
    const run = await (await r2.mgr.start(off.id)).done;
    expect(run.state).toBe("finished");
    expect(r2.jobs.map((j) => j.role)).toEqual(["lead"]);
    const h = await off.hub.get(off.id);
    expect(h.board.tickets.map((t) => t.state)).toEqual(["done", "done"]);
    expect(h.board.tickets[0]!.notes.at(-1)!.text).toBe("Moved to done by the lead: schema in, tests pass");
    expect(h.board.tickets[1]!.notes.at(-1)!.text).toMatch(/^Accepted on the lead's word/);
    expect(r2.shell.commits[0]).toBe("T-2: Engine");
  } finally {
    r2.close();
    await fs.rm(off.root, { recursive: true, force: true });
  }
});

test("the lead owns the board: it creates tickets of any kind (ready or in progress at once), edits and deletes them", async () => {
  const s = await makeSession({ reviewer: false });
  const r = await harness(s, async (api) => {
    const feat = await api("POST", "/tickets", { title: "Export as CSV", kind: "feature", spec: "x", state: "in_progress" });
    expect(feat.status).toBe(201);
    expect(feat.json.state).toBe("in_progress");
    const id = String(feat.json.id);
    expect((await api("GET", `/tickets/${id}`)).json.baseline).toEqual({ app: BASE });
    expect((await api("PATCH", "/tickets/T-2", { title: "Engine v2", reason: "renamed" })).status).toBe(200);
    expect((await api("DELETE", "/tickets/T-2", { reason: "folded into T-1" })).status).toBe(200);
    expect((await api("POST", `/tickets/${id}/move`, { to: "done" })).status).toBe(200);
    expect((await api("POST", "/tickets/T-1/move", { to: "backlog", note: "not now" })).status).toBe(200);
    return {};
  });
  try {
    const run = await (await r.mgr.start(s.id)).done;
    expect(run.state).toBe("finished");
    const h = await s.hub.get(s.id);
    expect(h.board.tickets.map((t) => `${t.id}:${t.state}:${t.kind}`)).toEqual(["T-1:backlog:feature", "T-3:done:feature"]);
  } finally {
    r.close();
    await fs.rm(s.root, { recursive: true, force: true });
  }
});

// --- The goal, alone and with the board ---------------------------------------------

test("a goal without tickets: every life is committed, the conversation continues, the prompt carries the goal and the note, and done ends the run with the claim kept", async () => {
  const s = await makeSession({ goal: "A CLI that greets the user by name", tickets: [] });
  const r = await harness(s, async (api, job, n) => {
    expect(job.role).toBe("lead");
    if (n === 1) {
      await fs.writeFile(path.join(s.paths.notes, "state.md"), "# Plan\n- scaffold the CLI (done)\n- greet by name (next)\n");
      return { text: "Scaffolded the CLI; the greeting is next.\n\nDetails follow." };
    }
    expect((await api("POST", "/done", { note: "Greets by name. Verified: `node cli.js Ada` prints Hello, Ada; 3 tests pass." })).status).toBe(200);
    return { text: "Goal met." };
  });
  try {
    const run = await (await r.mgr.start(s.id)).done;
    expect(run).toMatchObject({ state: "finished", rounds: 2, ticketsDone: 0 });
    expect(run.pauseReason).toContain("done: Greets by name");
    expect(r.shell.commits).toEqual(["Lead 1.1: Scaffolded the CLI; the greeting is next.", "Lead 1.2: Goal met."]);
    expect(r.jobs).toHaveLength(2);
    expect(r.jobs[0]!.agentSession).toMatchObject({ resume: false });
    expect(r.jobs[1]!.agentSession).toEqual({ id: r.jobs[0]!.agentSession!.id, resume: true });
    expect(r.prompts[0]).toContain("## Goal\nA CLI that greets the user by name");
    expect(r.prompts[0]).toContain("you are the first lead here");
    expect(r.prompts[0]).toContain("### app");
    expect(r.prompts[1]).toContain("# Continue");
    expect(r.prompts[1]).toContain("life 2 of this run");
    expect(r.prompts[1]).toContain("committed what your last life left in app");
    const h = await s.hub.get(s.id);
    expect(h.session.goalMet).toMatchObject({ runId: 1, note: expect.stringContaining("Greets by name") });
    expect(h.session.state).toBe("finished");
  } finally {
    r.close();
    await fs.rm(s.root, { recursive: true, force: true });
  }
});

test("a goal and tickets together: the lead works both; done with tickets still ready does not end the run, and Start refuses when there is neither", async () => {
  const s = await makeSession({ goal: "Ship the greeting CLI" });
  const r = await harness(s, async (api, _job, n) => {
    if (n === 1) {
      expect(await finishTicket(api, "T-1")).toMatchObject({ state: "done" });
      expect((await api("POST", "/done", { note: "The CLI greets; T-2 is not mine to judge." })).status).toBe(200);
      return { text: "done, I think" };
    }
    expect(await finishTicket(api, "T-2")).toMatchObject({ state: "done" });
    expect((await api("POST", "/done", { note: "Everything holds." })).status).toBe(200);
    return { text: "done" };
  });
  try {
    const run = await (await r.mgr.start(s.id)).done;
    expect(run).toMatchObject({ state: "finished", rounds: 2, ticketsDone: 2 });
    expect(r.prompts[0]).toContain("## Goal\nShip the greeting CLI");
    expect(r.prompts[0]).toContain("T-1 [ready] Schema");
    const ev = await events(s);
    expect(ev.some((e) => e.kind === "status" && e.text.includes("says the goal is met, but 1 ticket is still ready or in progress"))).toBe(true);
    const h = await s.hub.get(s.id);
    expect(h.session.goalMet?.note).toBe("Everything holds.");
  } finally {
    r.close();
    await fs.rm(s.root, { recursive: true, force: true });
  }

  const empty = await makeSession({ tickets: [] });
  const r2 = await harness(empty, async () => ({}));
  try {
    await expect(r2.mgr.start(empty.id)).rejects.toThrow("Nothing to work on");
    expect(r2.jobs).toHaveLength(0);
  } finally {
    r2.close();
    await fs.rm(empty.root, { recursive: true, force: true });
  }
});

test("a handoff starts a fresh lead with the note and the tickets in progress; a cap stop starts fresh with the last words; a revised goal reaches the continue prompt; starting again after a met goal says so", async () => {
  const s = await makeSession({ goal: "A CLI that greets the user by name" });
  const r = await harness(s, async (api, _job, n) => {
    if (n === 1) {
      expect((await start(api, "T-2")).status).toBe(200);
      const res = await api("POST", "/handoff", { note: "Halfway: the parser is done, the greeting tests are next." });
      expect(res.status).toBe(200);
      expect(String(res.json.next)).toContain("fresh lead");
      expect((await api("POST", "/tickets/T-1/move", { to: "in_progress" })).json.error).toContain("handed off");
      return { text: "handing off" };
    }
    if (n === 2) return { stopReason: "time_cap", text: "ran out while writing the tests" };
    if (n === 3) {
      const h = await s.hub.get(s.id);
      await h.mutate((d) => ({ next: { session: reviseGoal(d.session, "A CLI that greets the user by name, in Finnish", now()) } }));
      return { text: "tests written" };
    }
    if (n === 4) {
      // The fresh lead found T-2 in progress and finishes it without moving it again.
      await api("POST", "/tickets/T-2/report", { report: "engine done" });
      expect(await move(api, "T-2", "review")).toMatchObject({ state: "done" });
      expect(await finishTicket(api, "T-1")).toMatchObject({ state: "done" });
      expect((await api("POST", "/done", { note: "Done in Finnish." })).status).toBe(200);
      return { text: "met" };
    }
    // Run 2, same goal: the lead is told the claim was made before.
    expect((await api("POST", "/done", { note: "Improved the edge cases; still met." })).status).toBe(200);
    return { text: "met again" };
  });
  try {
    const run = await (await r.mgr.start(s.id)).done;
    expect(run).toMatchObject({ state: "finished", rounds: 4 });
    const ids = r.jobs.filter((j) => j.role === "lead").map((j) => j.agentSession!);
    expect(ids[1]!.resume).toBe(false);
    expect(ids[1]!.id).not.toBe(ids[0]!.id);
    expect(ids[2]!.resume).toBe(false);
    expect(ids[3]).toEqual({ id: ids[2]!.id, resume: true });
    expect(await fs.readFile(path.join(s.paths.notes, "state.md"), "utf8")).toContain("Halfway: the parser is done");
    expect(r.prompts[1]).toContain("# The session");
    expect(r.prompts[1]).toContain("Note from the previous lead");
    expect(r.prompts[1]).toContain("Halfway: the parser is done");
    expect(r.prompts[1]).toContain("## In progress: T-2");
    expect(r.prompts[2]).toContain("stopped at a cap");
    expect(r.prompts[2]).toContain("ran out while writing the tests");
    expect(r.prompts[3]).toContain("# Continue");
    expect(r.prompts[3]).toContain("The goal was revised");
    expect(r.prompts[3]).toContain("in Finnish");
    expect(r.prompts[3]).toContain("In progress: T-2 (in_progress)");
    let h = await s.hub.get(s.id);
    expect(h.session.goals).toHaveLength(1);
    expect(h.session.goals[0]).toMatchObject({ text: "A CLI that greets the user by name", outcome: "revised" });
    expect(h.session.goalMet?.note).toBe("Done in Finnish.");

    const again = await (await r.mgr.start(s.id)).done;
    expect(again).toMatchObject({ state: "finished", rounds: 1 });
    expect(r.prompts[4]).toContain("said this goal was met");
    expect(r.prompts[4]).toContain("Done in Finnish.");
    h = await s.hub.get(s.id);
    expect(h.session.goalMet).toMatchObject({ runId: 2, note: "Improved the edge cases; still met." });
  } finally {
    r.close();
    await fs.rm(s.root, { recursive: true, force: true });
  }
});

test("two lives with no commit, no board change and no change to the note pause the run; lead caps apply when set", async () => {
  const quiet = fakeShell();
  quiet.dirty = false;
  const s = await makeSession({ goal: "Greet", tickets: [] });
  const r = await harness(s, async () => ({ text: "Still reading the code." }), { shell: quiet });
  try {
    const run = await (await r.mgr.start(s.id)).done;
    expect(run).toMatchObject({ state: "paused", pauseReason: "the lead ended twice without a commit, a board change or a change to notes/state.md", rounds: 2 });
    expect(r.shell.commits).toEqual([]);
  } finally {
    r.close();
    await fs.rm(s.root, { recursive: true, force: true });
  }

  const capped = await makeSession({ goal: "Greet", tickets: [], leadMinutes: 90, leadTurns: 300 });
  const r2 = await harness(capped, async (api) => {
    expect((await api("POST", "/done", { note: "greets" })).status).toBe(200);
    return { text: "one step" };
  });
  try {
    const run = await (await r2.mgr.start(capped.id)).done;
    expect(run.state).toBe("finished");
    expect(r2.jobs[0]!.caps).toEqual({ minutes: 90, turns: 300 });
  } finally {
    r2.close();
    await fs.rm(capped.root, { recursive: true, force: true });
  }
});

test("a request names the ticket it parks and the lead moves on; a request about the goal pauses the run once nothing else can go on; the outcome is in the next prompt", async () => {
  const s = await makeSession({ goal: "Ship it", tickets: [{ id: "T-1", title: "Schema", state: "ready" }, { id: "T-3", title: "Docs", state: "ready" }] });
  let mgr: RunManager;
  const r = await harness(s, async (api, _job, n) => {
    if (n === 1) {
      expect((await start(api, "T-1")).status).toBe(200);
      expect((await start(api, "T-3")).status).toBe(200);
      const req = await api("POST", "/requests", { summary: "need the staging DSN", ticket: "T-1", actions: [{ kind: "question", text: "Which database?" }] });
      expect(req.status).toBe(201);
      expect(String(req.json.next)).toContain("T-1 parks");
      // Parking happens in the background.
      for (let i = 0; i < 100 && (await api("GET", "/tickets/T-1")).json.state !== "waiting"; i++) await new Promise((res) => setTimeout(res, 5));
      await api("POST", "/tickets/T-3/report", { report: "docs" });
      expect(await move(api, "T-3", "review")).toMatchObject({ state: "done" });
      // A request about the goal itself, not a ticket.
      const goalReq = await api("POST", "/requests", { summary: "Which language should the greeting default to?", actions: [{ kind: "question", text: "Language?", options: ["English", "Finnish"] }] });
      expect(String(goalReq.json.next)).toContain("notes/state.md");
      return { text: "T-1 waits on the user" };
    }
    mgr.pauseAfterTicket(s.id);
    return { text: "Finnish it is." };
  });
  mgr = r.mgr;
  try {
    const first = await (await r.mgr.start(s.id)).done;
    expect(first).toMatchObject({ state: "paused", pauseReason: "requests", ticketsDone: 1 });
    let h = await s.hub.get(s.id);
    expect(h.board.tickets.map((t) => `${t.id}:${t.state}`)).toEqual(["T-1:waiting", "T-3:done"]);
    expect(h.inbox.requests.map((x) => x.ticketId)).toEqual(["T-1", undefined]);
    expect(h.session.state).toBe("waiting");
    // No commit for the park itself; the ticket commit and the backup commit of the life.
    expect(r.shell.commits).toEqual(["T-3: Docs", "Lead 1.1: T-1 waits on the user"]);

    await h.mutate((d) => ({
      next: {
        inbox: { ...d.inbox, requests: d.inbox.requests.map((x) => ({ ...x, state: "resolved" as const, answer: x.ticketId ? "staging-dsn" : "Finnish", decidedAt: now(), actions: x.actions.map((a) => ({ ...a, state: "approved" as const, outcome: x.ticketId ? "staging-dsn" : "Finnish" })) })) },
        board: { ...d.board, tickets: d.board.tickets.map((t) => (t.state === "waiting" ? { ...t, state: "ready" as const } : t)) },
      },
    }));
    const second = await (await r.mgr.start(s.id)).done;
    expect(second).toMatchObject({ state: "paused", pauseReason: "user", rounds: 1 });
    expect(r.prompts[1]).toContain("Requests the user decided");
    expect(r.prompts[1]).toContain("Answer: Finnish");
    expect(r.prompts[1]).toContain("Answer: staging-dsn");
    expect(r.sent).toEqual([expect.stringContaining("asked the run to pause")]);
    h = await s.hub.get(s.id);
    expect(h.session.state).toBe("paused");
  } finally {
    r.close();
    await fs.rm(s.root, { recursive: true, force: true });
  }
});

test("pause refuses the next move into progress and ends after the lead; stop requeues what is in progress", async () => {
  const s = await makeSession();
  let mgr: RunManager;
  const r = await harness(s, async (api, _job, n, signal) => {
    if (n === 1) {
      expect((await start(api, "T-1")).status).toBe(200);
      mgr.pauseAfterTicket(s.id);
      await api("POST", "/tickets/T-1/report", { report: "schema" });
      expect(await move(api, "T-1", "review")).toMatchObject({ state: "done" });
      expect((await api("POST", "/tickets/T-2/move", { to: "in_progress" })).json.error).toContain("pause");
      return {};
    }
    expect((await start(api, "T-2")).status).toBe(200);
    mgr.stopNow(s.id);
    await new Promise((res) => (signal.aborted ? res(null) : signal.addEventListener("abort", () => res(null))));
    return {};
  });
  mgr = r.mgr;
  try {
    const paused = await (await r.mgr.start(s.id)).done;
    expect(paused).toMatchObject({ state: "paused", pauseReason: "user", ticketsDone: 1 });
    const stopped = await (await r.mgr.start(s.id)).done;
    expect(stopped.state).toBe("stopped");
    const h = await s.hub.get(s.id);
    expect(h.board.tickets.map((t) => t.state)).toEqual(["done", "ready"]);
    expect(h.board.tickets[1]!.notes.at(-1)!.text).toContain("Run stopped by the user; requeued");
  } finally {
    r.close();
    await fs.rm(s.root, { recursive: true, force: true });
  }
});

test("a pause while a ticket is in progress puts it back to ready with the work kept", async () => {
  const s = await makeSession();
  let mgr: RunManager;
  const r = await harness(s, async (api) => {
    expect((await start(api, "T-1")).status).toBe(200);
    mgr.pauseAfterTicket(s.id);
    return { text: "stopping as asked" };
  });
  mgr = r.mgr;
  try {
    const run = await (await r.mgr.start(s.id)).done;
    expect(run).toMatchObject({ state: "paused", pauseReason: "user" });
    const h = await s.hub.get(s.id);
    expect(h.board.tickets[0]!.state).toBe("ready");
    expect(h.board.tickets[0]!.baseline).toEqual({ app: BASE });
    expect(h.board.tickets[0]!.notes.at(-1)!.text).toContain("requeued with the work kept");
  } finally {
    r.close();
    await fs.rm(s.root, { recursive: true, force: true });
  }
});

test("a lead that ignores its handoff is stopped after the grace period and a fresh lead takes over", async () => {
  const s = await makeSession();
  const r = await harness(s, async (api, _job, n, signal) => {
    if (n === 1) {
      await api("POST", "/handoff", { note: "context is noisy" });
      await new Promise((res) => (signal.aborted ? res(null) : signal.addEventListener("abort", () => res(null))));
      return { stopReason: "aborted", text: "" };
    }
    await finishTicket(api, "T-1");
    await finishTicket(api, "T-2");
    return {};
  });
  try {
    const run = await (await r.mgr.start(s.id)).done;
    expect(run).toMatchObject({ state: "finished", ticketsDone: 2 });
    expect(r.prompts[1]).toContain("context is noisy");
  } finally {
    r.close();
    await fs.rm(s.root, { recursive: true, force: true });
  }
});

test("your rules for the lead come from a file, read for every new lead; an empty file adds nothing", async () => {
  const { readLeadRules, systemMd } = await import("../../src/harness/prompts.js");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "verstas-rules-"));
  try {
    const file = path.join(dir, "lead.md");
    expect(await readLeadRules(file)).toBeUndefined();
    await fs.writeFile(file, "  \n");
    expect(await readLeadRules(file)).toBeUndefined();
    await fs.writeFile(file, "Work the highest priority ticket first. Always submit.");
    const rules = await readLeadRules(file);
    const sys = systemMd("lead", rules);
    expect(sys).toContain("Always submit.");
    expect(sys).toContain("Role: lead");
    expect(sys).toContain("Read /workspace/VERSTAS.md first"); // the facts stay
    expect(systemMd("lead")).not.toContain("Always submit.");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a stop that comes before the lead starts starts no lead", async () => {
  const s = await makeSession();
  const r = await harness(s, async () => ({}), {
    heal: async (mgr) => {
      mgr.stopNow(s.id);
      return [];
    },
  });
  try {
    const run = await (await r.mgr.start(s.id)).done;
    expect(run.state).toBe("stopped");
    expect(r.jobs).toHaveLength(0);
  } finally {
    r.close();
    await fs.rm(s.root, { recursive: true, force: true });
  }
});

test("a rate-limited reviewer stops further moves into progress, and the run sleeps before the next lead", async () => {
  const s = await makeSession();
  const refusals: string[] = [];
  const r = await harness(
    s,
    async (api, _job, n) => {
      if (n === 1) {
        expect(await finishTicket(api, "T-1")).toMatchObject({ state: "ready" });
        refusals.push(String((await api("POST", "/tickets/T-1/move", { to: "in_progress" })).json.error));
        return {};
      }
      return { text: "nothing to do" };
    },
    { reviewerRateLimited: true },
  );
  try {
    await (await r.mgr.start(s.id)).done;
    expect(refusals[0]).toContain("rate limited");
    expect(r.jobs.filter((j) => j.role === "reviewer")).toHaveLength(1);
    expect(getTicket((await s.hub.get(s.id)).board, "T-1").notes.map((n) => n.text)).toContain("Reviewer was rate limited; requeued with the work kept");
  } finally {
    r.close();
    await fs.rm(s.root, { recursive: true, force: true });
  }
});

test("a submit that lands after the run ended is put back, never left in review", async () => {
  const s = await makeSession();
  const r = await harness(s, async () => ({}));
  try {
    const h = await s.hub.get(s.id);
    await h.mutate((d) => ({ next: { board: transition(transition(d.board, "T-1", "in_progress"), "T-1", "review") } }));
    r.mgr.submitted({ sessionId: s.id, runId: 99, role: "lead", currentTicket: "T-1" }, "T-1");
    for (let i = 0; i < 100 && (await s.hub.get(s.id)).board.tickets[0]!.state === "review"; i++) await new Promise((res) => setTimeout(res, 5));
    expect((await s.hub.get(s.id)).board.tickets[0]!.state).toBe("ready");
  } finally {
    r.close();
    await fs.rm(s.root, { recursive: true, force: true });
  }
});

test("every progressMinutes the running lead is asked for a progress update, which it posts to the inbox; 0 turns the check off", async () => {
  const s = await makeSession({ goal: "Greet by name", tickets: [], progressMinutes: 1 });
  let asked = 0;
  const r = await harness(
    s,
    async (api, _job, n) => {
      if (n === 1) {
        const t0 = Date.now();
        while (r.sent.length < 2 && Date.now() - t0 < 2000) await new Promise((res) => setTimeout(res, 5));
        asked = r.sent.length;
        expect((await api("POST", "/messages", { text: "Well under way. The CLI parses its arguments and greets; the name flag is next." })).status).toBe(201);
        await fs.writeFile(path.join(s.paths.notes, "state.md"), "# Plan\n- greet by name (in flight)\n");
        return { text: "The name flag is in flight." };
      }
      expect((await api("POST", "/done", { note: "Greets by name." })).status).toBe(200);
      return { text: "Goal met." };
    },
    { progressMinuteMs: 30 },
  );
  try {
    const run = await (await r.mgr.start(s.id)).done;
    expect(run.state).toBe("finished");
    expect(asked).toBeGreaterThanOrEqual(2);
    expect(r.sent[0]).toContain("Progress check");
    expect(r.sent[0]).toContain("`message`");
    const h = await s.hub.get(s.id);
    expect(h.inbox.messages.map((m) => m.text)).toEqual(["Well under way. The CLI parses its arguments and greets; the name flag is next."]);
    const ev = await events(s);
    expect(ev.filter((e) => e.kind === "status" && e.text.startsWith("progress check: the lead was asked")).length).toBe(r.sent.length);
  } finally {
    r.close();
    await fs.rm(s.root, { recursive: true, force: true });
  }

  const off = await makeSession({ goal: "Greet", tickets: [], progressMinutes: 0 });
  const r2 = await harness(
    off,
    async (api) => {
      await new Promise((res) => setTimeout(res, 150));
      expect((await api("POST", "/done", { note: "Done." })).status).toBe(200);
      return { text: "Goal met." };
    },
    { progressMinuteMs: 10 },
  );
  try {
    expect((await (await r2.mgr.start(off.id)).done).state).toBe("finished");
    expect(r2.sent).toEqual([]);
  } finally {
    r2.close();
    await fs.rm(off.root, { recursive: true, force: true });
  }
});

test("recover after a host crash: stops the orphaned worker, requeues tickets in progress, closes the run", async () => {
  const s = await makeSession();
  try {
    const h = await s.hub.get(s.id);
    await h.mutate((d) => ({
      next: {
        session: { ...d.session, state: "running" as const },
        board: { ...d.board, tickets: d.board.tickets.map((t) => (t.id === "T-1" ? { ...t, state: "in_progress" as const } : t)) },
      },
    }));
    await fs.mkdir(path.join(s.paths.runs, "1"), { recursive: true });
    await writeJsonAtomic(path.join(s.paths.runs, "1", "run.json"), { id: 1, sessionId: s.id, startedAt: now(), state: "running", currentTicket: "T-1" });
    const r = await harness(s, async () => ({}));
    try {
      const did = await r.mgr.recover(s.id);
      expect(did.join("; ")).toContain("requeued T-1");
      expect(r.shell.calls).toContainEqual(["pkill", "-TERM", "-f", "/opt/verstas/worker.js"]);
      expect((await s.hub.get(s.id)).board.tickets[0]!.state).toBe("ready");
      expect((await s.hub.get(s.id)).session.state).toBe("paused");
      expect(JSON.parse(await fs.readFile(path.join(s.paths.runs, "1", "run.json"), "utf8"))).toMatchObject({ state: "stopped", pauseReason: "host app restarted" });
      expect(await r.mgr.recover(s.id)).toEqual([]);
    } finally {
      r.close();
    }
  } finally {
    await fs.rm(s.root, { recursive: true, force: true });
  }
});

// --- Judging details ------------------------------------------------------------------

test("a ticket with no diff is done when the reviewer accepts the report; the expected repositories are a hint", async () => {
  const s = await makeSession();
  const shell = fakeShell();
  shell.dirty = false;
  shell.numstat = "";
  const h0 = await s.hub.get(s.id);
  await h0.mutate((d) => ({ next: { board: { ...d.board, tickets: d.board.tickets.map((t) => (t.id === "T-1" ? { ...t, repos: ["capability"] } : t)) } } }));
  const r = await harness(
    s,
    async (api) => {
      expect(await finishTicket(api, "T-1")).toMatchObject({ state: "done" });
      shell.numstat = "3\t1\tsrc/a.ts\n";
      expect(await finishTicket(api, "T-2")).toMatchObject({ state: "done" });
      return {};
    },
    { shell, verdict: () => "VERDICT: ok\nThe report answers the question." },
  );
  try {
    const run = await (await r.mgr.start(s.id)).done;
    expect(run.state).toBe("finished");
    const h = await s.hub.get(s.id);
    expect(h.board.tickets.map((t) => t.state)).toEqual(["done", "done"]);
    expect(r.jobs.filter((j) => j.role === "reviewer")).toHaveLength(2);
    const t1 = h.board.tickets[0]!;
    expect(t1.notes.at(-1)?.text).toContain("no files changed");
    const t2 = h.board.tickets[1]!;
    expect(t2.notes.map((n) => n.text).join("\n")).toContain("judged: full");
  } finally {
    r.close();
    await fs.rm(s.root, { recursive: true, force: true });
  }
});

test("each ticket is judged by its own review mode, or the session's when it sets none", async () => {
  const s = await makeSession({
    reviewer: false,
    tickets: [
      { id: "T-1", title: "Full", state: "ready", review: "full" },
      { id: "T-2", title: "Checks", state: "ready", review: "checks" },
      { id: "T-3", title: "None", state: "ready", review: "none" },
      { id: "T-4", title: "Default", state: "ready" },
    ],
  });
  const r = await harness(s, async (api) => {
    for (const id of ["T-1", "T-2", "T-3", "T-4"]) expect(await finishTicket(api, id)).toMatchObject({ state: "done" });
    return {};
  });
  try {
    const run = await (await r.mgr.start(s.id)).done;
    expect(run.ticketsDone).toBe(4);
    expect(r.jobs.filter((j) => j.role === "reviewer").map((j) => j.ticket)).toEqual(["T-1"]);
    const h = await s.hub.get(s.id);
    const doneNote = (tid: string) => getTicket(h.board, tid).notes.at(-1)!.text;
    expect(doneNote("T-1")).toMatch(/^Reviewed ok/);
    expect(doneNote("T-2")).toMatch(/^Accepted on the lead's word/);
    expect(doneNote("T-4")).toMatch(/^Accepted on the lead's word/);
    expect(r.shell.commits.slice(0, 4)).toEqual(["T-1: Full", "T-2: Checks", "T-3: None", "T-4: Default"]);
  } finally {
    r.close();
    await fs.rm(s.root, { recursive: true, force: true });
  }
});

test("a change that contains the Claude token is never committed; the ticket is blocked with the reason", async () => {
  const s = await makeSession({ reviewer: false, tickets: [{ id: "T-1", title: "Schema", state: "ready" }] });
  const token = "sk-ant-oat01-THIS-IS-A-FAKE-TOKEN-FOR-THE-TEST-0123456789";
  const shell = fakeShell();
  const base = shell.exec.bind(shell);
  shell.exec = async (cmd, opts) => (cmd.join(" ") === "git diff --cached --no-color --text" ? { code: 0, stdout: `+CLAUDE_CODE_OAUTH_TOKEN=${token}\n`, stderr: "" } : base(cmd, opts));
  const r = await harness(
    s,
    async (api) => {
      expect(await finishTicket(api, "T-1")).toMatchObject({ state: "blocked" });
      return {};
    },
    { shell, secrets: [token] },
  );
  try {
    await (await r.mgr.start(s.id)).done;
    const t1 = (await s.hub.get(s.id)).board.tickets[0]!;
    expect(t1.state).toBe("blocked");
    expect(t1.notes.at(-1)?.text).toContain("Claude token appears in the changes to app");
    expect(shell.commits).toEqual([]);
    expect(shell.calls).toContainEqual(["git", "reset", "-q"]);
    expect(shell.calls.some((c) => c.join(" ").includes(token))).toBe(false);
  } finally {
    r.close();
    await fs.rm(s.root, { recursive: true, force: true });
  }
});

test("parseVerdict reads the first verdict line and a short reason", () => {
  expect(parseVerdict("VERDICT: ok\nClean.\nTested.")).toEqual({ verdict: "ok", reason: "Clean. Tested." });
  expect(parseVerdict("Some preamble\nverdict: Fixable because x")).toEqual({ verdict: "fixable", reason: "because x" });
  expect(parseVerdict("no verdict here")).toBeNull();
});

// --- Tokens, messages, other runs ---------------------------------------------------

test("every worker gets its own run token, scoped to its role and revoked when it ends", async () => {
  const s = await makeSession();
  const r = await harness(s, async (api, job) => {
    if (job.role === "lead") {
      await finishTicket(api, "T-1");
      await finishTicket(api, "T-2");
    }
    return {};
  });
  try {
    await (await r.mgr.start(s.id)).done;
    expect(r.seen.map((x) => x.role)).toEqual(["lead", "reviewer", "reviewer"]);
    expect(new Set(r.seen.map((x) => x.token)).size).toBe(3);
    expect(r.seen[0]!.info).toMatchObject({ role: "lead" });
    expect(r.seen[1]!.info).toMatchObject({ role: "worker", currentTicket: "T-1" });
    for (const x of r.seen) expect(r.tokens.lookup(x.token)).toBeUndefined();
  } finally {
    r.close();
    await fs.rm(s.root, { recursive: true, force: true });
  }
});

test("a message from the user reaches the lead running now, is logged, and is refused when nothing runs or the driver cannot take it", async () => {
  const s = await makeSession({ reviewer: false });
  let release: () => void = () => undefined;
  const r = await harness(s, async (api) => {
    await finishTicket(api, "T-1");
    await new Promise<void>((res) => (release = res));
    await finishTicket(api, "T-2");
    return {};
  });
  try {
    expect(await r.mgr.message(s.id, "hello?")).toEqual({ ok: false, error: "No run is active" });
    const ctl = await r.mgr.start(s.id);
    while (r.jobs.length === 0) await new Promise((res) => setTimeout(res, 5));
    await new Promise((res) => setTimeout(res, 50));
    expect(await r.mgr.message(s.id, "  why is this taking so long?  ")).toEqual({ ok: true, to: "lead" });
    expect(r.sent).toEqual(["why is this taking so long?"]);
    release();
    await ctl.done;
    const ev = await events(s);
    expect(ev.some((e) => e.kind === "status" && e.text === "message from the user to the lead: why is this taking so long?")).toBe(true);
    expect(await r.mgr.message(s.id, "late")).toEqual({ ok: false, error: "No run is active" });
  } finally {
    r.close();
    await fs.rm(s.root, { recursive: true, force: true });
  }

  const codex = await makeSession({ reviewer: false, agents: { worker: { driver: "codex" } } });
  let go: () => void = () => undefined;
  const r2 = await harness(codex, async (api) => {
    await new Promise<void>((res) => (go = res));
    await finishTicket(api, "T-1");
    await finishTicket(api, "T-2");
    return {};
  });
  try {
    const ctl = await r2.mgr.start(codex.id);
    while (r2.jobs.length === 0) await new Promise((res) => setTimeout(res, 5));
    await new Promise((res) => setTimeout(res, 20));
    const m = await r2.mgr.message(codex.id, "hi");
    expect(m.ok).toBe(false);
    expect(String((m as { error: string }).error)).toContain("codex, which cannot take a message mid-run");
    go();
    await ctl.done;
  } finally {
    r2.close();
    await fs.rm(codex.root, { recursive: true, force: true });
  }
});

test("a prompt runs one worker with your text, commits a change as one commit, and keeps the reply", async () => {
  const s = await makeSession();
  const r = await harness(s, async () => ({ text: "Installed the browsers; the e2e suite runs (12 passed). env.md updated." }));
  try {
    const run = await (await r.mgr.start(s.id, { prompt: "Make sure the e2e suite runs\nand update env.md" })).done;
    expect(run.state).toBe("finished");
    expect(r.jobs.map((j) => [j.role, j.ticket])).toEqual([["prompt", undefined]]);
    expect(r.prompts[0]).toContain("# Request from the user");
    expect(r.prompts[0]).toContain("Make sure the e2e suite runs");
    expect(r.shell.commits).toEqual(["Prompt: Make sure the e2e suite runs"]);
    const h = await s.hub.get(s.id);
    expect(h.session.prompts[0]).toMatchObject({ runId: 1, kind: "prompt", reply: expect.stringContaining("12 passed") });
    expect(h.board.tickets.every((t) => t.state === "ready")).toBe(true);
    await expect(r.mgr.start(s.id, { prompt: "  " })).rejects.toThrow(/empty/);
  } finally {
    r.close();
    await fs.rm(s.root, { recursive: true, force: true });
  }
});

// --- Initialization ----------------------------------------------------------------

test("initialization is the container and the recipes: nothing runs before it, no worker runs in it, the box is snapshotted; with start the lead follows", async () => {
  const s = await makeSession({ initialized: false });
  const snapshots: string[] = [];
  const r = await harness(
    s,
    async (api) => {
      await finishTicket(api, "T-1");
      await finishTicket(api, "T-2");
      return {};
    },
    { snapshots },
  );
  try {
    await expect(r.mgr.start(s.id)).rejects.toThrow(/not initialized/);
    await expect(r.mgr.start(s.id, { prompt: "x" })).rejects.toThrow(/not initialized/);

    const run1 = await (await r.mgr.start(s.id, { init: true })).done;
    expect(run1.state).toBe("finished");
    let h = await s.hub.get(s.id);
    expect(h.session.initializedAt).toBeTruthy();
    expect(h.session.snapshot).toMatchObject({ image: "verstas-snap-x" });
    expect(r.jobs).toHaveLength(0);
    expect(h.board.tickets.every((t) => t.state === "ready")).toBe(true);
    expect(snapshots).toHaveLength(1);
  } finally {
    r.close();
    await fs.rm(s.root, { recursive: true, force: true });
  }

  const started = await makeSession({ initialized: false, goal: "Ship it", tickets: [] });
  const snaps: string[] = [];
  const r2 = await harness(
    started,
    async (api) => {
      expect((await api("POST", "/done", { note: "shipped" })).status).toBe(200);
      return { text: "shipped" };
    },
    { snapshots: snaps },
  );
  try {
    const run = await (await r2.mgr.start(started.id, { init: true, start: true })).done;
    expect(run.state).toBe("finished");
    expect(r2.jobs.map((j) => j.role)).toEqual(["lead"]);
    // Once at initialization, once after the work run: the snapshot keeps what the lead installed.
    expect(snaps).toHaveLength(2);
  } finally {
    r2.close();
    await fs.rm(started.root, { recursive: true, force: true });
  }
});

test("VERSTAS.md and the workspace pointer files are written for every run; nothing is put in front of the lead's prompt", async () => {
  const s = await makeSession();
  await fs.writeFile(path.join(s.paths.notes, "brief.md"), "# Project brief\nold\n");
  const r = await harness(s, async (api) => {
    await finishTicket(api, "T-1");
    await finishTicket(api, "T-2");
    return {};
  });
  try {
    await (await r.mgr.start(s.id)).done;
    expect(r.prompts[0]!.startsWith("# The session")).toBe(true);
    expect(r.prompts[0]).not.toContain("Project brief");
    expect(await fs.readFile(path.join(s.paths.workspace, "CLAUDE.md"), "utf8")).toContain("/workspace/VERSTAS.md");
    expect(await fs.readFile(path.join(s.paths.workspace, "AGENTS.md"), "utf8")).toContain("/workspace/VERSTAS.md");
  } finally {
    r.close();
    await fs.rm(s.root, { recursive: true, force: true });
  }
});

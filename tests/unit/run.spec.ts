import { test, expect } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunTokens } from "../../src/agent-api/agent-api.js";
import { importBoard, emptyBoard, getTicket, replaceTicket } from "../../src/board/board.js";
import { saveBoard, writeJsonAtomic } from "../../src/board/store.js";
import { inboxSchema, now, requestSchema, sessionSchema, type VerstasEvent } from "../../src/core/types.js";
import { describeBlockers, parseSetup, parseVerdict, RunManager, type Shell, type WorkerDone, type WorkerRunner } from "../../src/harness/run.js";
import { SessionHub } from "../../src/sessions/hub.js";
import { sessionPaths } from "../../src/sessions/sessions.js";
import type { Job } from "../../src/worker/worker.js";

/**
 * The loop with fakes: a shell that answers git and npm like a repo with
 * passing tests, and a worker scripted per role. What is asserted is the
 * loop's decisions: board moves, commit messages, run state.
 */

const makeSession = async (opts: { reviewer?: boolean; attempts?: number; requirements?: string } = {}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "verstas-run-"));
  const id = "2026-10-03-run";
  const paths = sessionPaths(root, id);
  await fs.mkdir(paths.workspace, { recursive: true });
  await fs.mkdir(paths.runs, { recursive: true });
  await writeJsonAtomic(
    paths.session,
    sessionSchema.parse({
      id,
      name: "run",
      goal: "g",
      createdAt: now(),
      repos: [{ name: "app", sourcePath: "/x", branch: "main", runBranch: `verstas/${id}` }],
      requirements: opts.requirements ?? "",
      caps: { reviewer: opts.reviewer ?? true, ticketAttempts: opts.attempts ?? 2, runTickets: 10 },
    }),
  );
  await saveBoard(paths.dir, importBoard(emptyBoard("g"), { tickets: [{ id: "T-1", title: "Schema", state: "ready", repo: "app" }, { id: "T-2", title: "Engine", state: "ready", deps: ["T-1"] }] }).board);
  await writeJsonAtomic(paths.inbox, inboxSchema.parse({}));
  return { root, id, paths, hub: new SessionHub(root) };
};

const fakeShell = (): Shell & { commits: string[]; calls: string[][] } => {
  const commits: string[] = [];
  const calls: string[][] = [];
  return {
    commits,
    calls,
    async exec(cmd) {
      calls.push([...cmd]);
      const s = cmd.join(" ");
      if (s === "cat package.json") return { code: 0, stdout: JSON.stringify({ scripts: { test: "x" } }), stderr: "" };
      if (s.startsWith("npm run --silent test")) return { code: 0, stdout: "3 passing", stderr: "" };
      if (s.includes("pytest")) return { code: 0, stdout: "", stderr: "" };
      if (s === "git diff --cached --numstat") return { code: 0, stdout: "3\t1\tsrc/a.ts\n", stderr: "" };
      if (s === "git diff --cached --stat") return { code: 0, stdout: " src/a.ts | 4 +-", stderr: "" };
      if (s === "git diff --cached") return { code: 0, stdout: "diff --git a/src/a.ts", stderr: "" };
      if (s === "git diff --cached --quiet") return { code: 1, stdout: "", stderr: "" };
      if (s.includes("commit")) {
        commits.push(cmd[cmd.length - 1]!);
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  };
};

type Script = (job: Job, hub: SessionHub, sessionId: string) => Promise<Partial<WorkerDone> & { text?: string }>;

const fakeWorker = (hub: SessionHub, sessionId: string, script: Script): WorkerRunner & { jobs: Job[] } => {
  const jobs: Job[] = [];
  return {
    jobs,
    async run(job, onEvent, signal) {
      jobs.push(job);
      onEvent({ kind: "text", t: now(), ticket: job.ticket, role: job.role, text: `${job.role} working` });
      const out = await script(job, hub, sessionId);
      return {
        kind: "worker_done",
        t: now(),
        ticket: job.ticket,
        role: job.role,
        ok: true,
        stopReason: signal.aborted ? "aborted" : "success",
        rateLimited: false,
        costUsd: 0.1,
        turns: 3,
        seconds: 1,
        text: "",
        stderr: "",
        ...out,
      };
    },
  };
};

const fileReport = async (hub: SessionHub, sessionId: string, ticket: string, report: string) => {
  const h = await hub.get(sessionId);
  await h.mutate((d) => ({ next: { board: replaceTicket(d.board, { ...getTicket(d.board, ticket), report }) } }));
};

const manager = (s: Awaited<ReturnType<typeof makeSession>>, shell: Shell, worker: WorkerRunner) =>
  new RunManager({
    hub: s.hub,
    tokens: new RunTokens(),
    shell: () => shell,
    worker: () => worker,
    ensureSandbox: async () => undefined,
    agentApiUrl: "http://host.docker.internal:4701/agent",
    rateLimitSleepMs: 20,
  });

test("a ticket that passes gates and review is committed and done; dependents follow", async () => {
  const s = await makeSession();
  try {
    const shell = fakeShell();
    const worker = fakeWorker(s.hub, s.id, async (job, hub, id) => {
      if (job.role === "implementer") await fileReport(hub, id, job.ticket!, "did the thing");
      if (job.role === "reviewer") return { text: "VERDICT: ok\nClean and tested." };
      return {};
    });
    const events: VerstasEvent[] = [];
    s.hub.on("event", (e: { event: VerstasEvent }) => events.push(e.event));
    const ctl = await manager(s, shell, worker).start(s.id);
    const run = await ctl.done;
    expect(run.state).toBe("finished");
    expect(run.ticketsDone).toBe(2);
    const h = await s.hub.get(s.id);
    expect(h.board.tickets.map((t) => t.state)).toEqual(["done", "done"]);
    expect(h.board.tickets[0]!.diff).toEqual({ added: 3, removed: 1, files: 1 });
    expect(shell.commits).toEqual(["T-1: Schema", "T-2: Engine"]);
    expect(worker.jobs.map((j) => `${j.role}:${j.ticket}`)).toEqual(["implementer:T-1", "reviewer:T-1", "implementer:T-2", "reviewer:T-2"]);
    expect(events.filter((e) => e.kind === "gate")).toHaveLength(2);
    expect(h.session.state).toBe("finished");
    // Files the worker reads exist.
    expect(await fs.readFile(path.join(s.paths.workspace, "VERSTAS.md"), "utf8")).toContain("/workspace/app");
    expect(JSON.parse(await fs.readFile(path.join(s.paths.workspace, ".verstas", "job.json"), "utf8"))).toMatchObject({ role: "reviewer", ticket: "T-2" });
    const log = await fs.readFile(path.join(s.paths.runs, "1", "events.jsonl"), "utf8");
    expect(log.split("\n").filter(Boolean).length).toBeGreaterThan(8);
    expect(await fs.readFile(path.join(s.paths.runs, "1", "tickets", "T-1.md"), "utf8")).toContain("did the thing");
  } finally {
    await fs.rm(s.root, { recursive: true, force: true });
  }
});

test("fixable verdicts requeue until the attempt cap, then block", async () => {
  const s = await makeSession({ attempts: 2 });
  try {
    const shell = fakeShell();
    const worker = fakeWorker(s.hub, s.id, async (job, hub, id) => {
      if (job.role === "implementer") await fileReport(hub, id, job.ticket!, "tried");
      if (job.role === "reviewer") return { text: "VERDICT: fixable\nMissing a test for the edge case." };
      return {};
    });
    const run = await (await manager(s, shell, worker).start(s.id)).done;
    const h = await s.hub.get(s.id);
    const t1 = h.board.tickets[0]!;
    expect(t1.state).toBe("blocked");
    expect(t1.attempts).toBe(2);
    expect(t1.notes.map((n) => n.text).join("\n")).toContain("attempt 1 of 2");
    expect(shell.commits).toEqual(["T-1 (wip attempt 1): Schema", "T-1 (blocked): Schema"]);
    // T-2 depends on T-1, which never finished: nothing ready, run pauses on dependencies.
    expect(run.state).toBe("paused");
    expect(run.pauseReason).toBe("T-2 wait on T-1 (blocked)");
    expect(h.board.tickets[1]!.state).toBe("ready");
  } finally {
    await fs.rm(s.root, { recursive: true, force: true });
  }
});

test("an open request parks the ticket; a halt pauses the run", async () => {
  const s = await makeSession({ reviewer: false });
  try {
    const shell = fakeShell();
    const worker = fakeWorker(s.hub, s.id, async (job, hub, id) => {
      const h = await hub.get(id);
      const kind = job.ticket === "T-1" ? "network" : "halt";
      await h.mutate((d) => ({
        next: {
          inbox: {
            ...d.inbox,
            requests: [
              ...d.inbox.requests,
              requestSchema.parse({
                id: `R-${d.inbox.requests.length + 1}`,
                ticketId: job.ticket,
                summary: "need it",
                actions: kind === "network" ? [{ id: "a1", detail: { kind, host: "fonts.googleapis.com" } }] : [],
                halt: kind === "halt" ? { reason: "spec contradiction", severity: "critical" } : undefined,
                createdAt: now(),
              }),
            ],
          },
        },
      }));
      return {};
    });
    const mgr = manager(s, shell, worker);
    const run = await (await mgr.start(s.id)).done;
    const h = await s.hub.get(s.id);
    expect(h.board.tickets[0]!.state).toBe("waiting");
    expect(shell.commits).toEqual(["T-1 (waiting): Schema"]);
    // T-2 depends on T-1 so nothing else was ready; the run paused on the open request.
    expect(run.state).toBe("paused");
    expect(run.pauseReason).toBe("requests");
    expect(h.session.state).toBe("waiting");

    // Answer the request, make T-2 independent, and let T-2 halt the run.
    await h.mutate((d) => ({
      next: {
        inbox: { ...d.inbox, requests: d.inbox.requests.map((r) => ({ ...r, state: "resolved" as const, answer: "allowed", decidedAt: now(), actions: r.actions.map((a) => ({ ...a, state: "approved" as const, outcome: "allowed" })) })) },
        board: { ...d.board, tickets: d.board.tickets.map((t) => (t.id === "T-2" ? { ...t, deps: [] } : t.id === "T-1" ? { ...t, state: "backlog" as const } : t)) },
      },
    }));
    const run2 = await (await mgr.start(s.id)).done;
    expect(run2.id).toBe(2);
    expect(run2.state).toBe("halted");
    expect((await s.hub.get(s.id)).session.state).toBe("halted");
    expect((await s.hub.get(s.id)).board.tickets[1]!.state).toBe("waiting");
  } finally {
    await fs.rm(s.root, { recursive: true, force: true });
  }
});

test("a rate-limited worker requeues the ticket without charging an attempt, sleeps, then continues", async () => {
  const s = await makeSession({ reviewer: false });
  try {
    const shell = fakeShell();
    let calls = 0;
    const worker = fakeWorker(s.hub, s.id, async (job, hub, id) => {
      calls++;
      if (calls === 1) return { ok: false, stopReason: "error_during_execution", rateLimited: true };
      await fileReport(hub, id, job.ticket!, "ok now");
      return {};
    });
    const run = await (await manager(s, shell, worker).start(s.id)).done;
    const h = await s.hub.get(s.id);
    expect(run.state).toBe("finished");
    expect(h.board.tickets[0]!.state).toBe("done");
    expect(h.board.tickets[0]!.attempts).toBe(1);
    expect(h.board.tickets[0]!.notes.map((n) => n.text)).toContain("Rate limited; requeued");
    expect(calls).toBe(3);
  } finally {
    await fs.rm(s.root, { recursive: true, force: true });
  }
});

test("stop now aborts the worker and requeues the ticket", async () => {
  const s = await makeSession({ reviewer: false });
  try {
    const shell = fakeShell();
    let ctlRef: { stopNow: () => void } | undefined;
    const worker = fakeWorker(s.hub, s.id, async () => {
      ctlRef?.stopNow();
      await new Promise((r) => setTimeout(r, 10));
      return { ok: false, stopReason: "aborted" };
    });
    const ctl = await manager(s, shell, worker).start(s.id);
    ctlRef = ctl;
    const run = await ctl.done;
    expect(run.state).toBe("stopped");
    const h = await s.hub.get(s.id);
    expect(h.board.tickets[0]!.state).toBe("ready");
    expect(h.board.tickets[0]!.notes.at(-1)?.text).toContain("stopped by the user");
  } finally {
    await fs.rm(s.root, { recursive: true, force: true });
  }
});

test("planner runs on an empty board and leaves the backlog for approval", async () => {
  const s = await makeSession({ reviewer: false });
  try {
    await saveBoard(s.paths.dir, emptyBoard("g"));
    s.hub.forget(s.id);
    const shell = fakeShell();
    const worker = fakeWorker(s.hub, s.id, async (job, hub, id) => {
      expect(job.role).toBe("planner");
      const h = await hub.get(id);
      await h.mutate((d) => ({ next: { board: importBoard(d.board, { tickets: [{ title: "Planned A" }, { title: "Planned B" }] }, { by: "agent", role: "planner" }).board } }));
      return {};
    });
    const run = await (await manager(s, shell, worker).start(s.id)).done;
    expect(run.state).toBe("finished");
    const h = await s.hub.get(s.id);
    expect(h.board.tickets.map((t) => t.state)).toEqual(["backlog", "backlog"]);
    expect(worker.jobs).toHaveLength(1);
  } finally {
    await fs.rm(s.root, { recursive: true, force: true });
  }
});

test("parseVerdict reads the first verdict line and a short reason", () => {
  expect(parseVerdict("VERDICT: ok\nClean.\nTested.")).toEqual({ verdict: "ok", reason: "Clean. Tested." });
  expect(parseVerdict("Some preamble\nverdict: Fixable because x")).toEqual({ verdict: "fixable", reason: "because x" });
  expect(parseVerdict("no verdict here")).toBeNull();
});

test("a run refuses to start while a live ticket names a repo the session lacks", async () => {
  const s = await makeSession({ reviewer: false });
  try {
    const h = await s.hub.get(s.id);
    await h.mutate((d) => ({ next: { board: { ...d.board, tickets: d.board.tickets.map((t) => (t.id === "T-1" ? { ...t, repo: "capability" } : t)) } } }));
    const shell = fakeShell();
    const worker = fakeWorker(s.hub, s.id, async () => ({}));
    await expect(manager(s, shell, worker).start(s.id)).rejects.toThrow(/T-1 names repo "capability", but the session's repositories are: app/);
    expect(worker.jobs).toHaveLength(0);
  } finally {
    await fs.rm(s.root, { recursive: true, force: true });
  }
});

test("gates are skipped, not failed, when dependencies are not installed", async () => {
  const s = await makeSession({ reviewer: false });
  try {
    const shell = fakeShell();
    const base = shell.exec.bind(shell);
    shell.exec = async (cmd, opts) => (cmd.join(" ") === "test -d node_modules" ? { code: 1, stdout: "", stderr: "" } : base(cmd, opts));
    const worker = fakeWorker(s.hub, s.id, async (job, hub, id) => {
      await fileReport(hub, id, job.ticket!, "done");
      return {};
    });
    const events: VerstasEvent[] = [];
    s.hub.on("event", (e: { event: VerstasEvent }) => events.push(e.event));
    const run = await (await manager(s, shell, worker).start(s.id)).done;
    expect(run.state).toBe("finished");
    const gates = events.filter((e) => e.kind === "gate") as Extract<VerstasEvent, { kind: "gate" }>[];
    expect(gates.every((g) => g.ok && g.summary.startsWith("skipped"))).toBe(true);
    expect((await s.hub.get(s.id)).board.tickets.map((t) => t.state)).toEqual(["done", "done"]);
  } finally {
    await fs.rm(s.root, { recursive: true, force: true });
  }
});

test("describeBlockers groups waiting tickets by what they wait on", () => {
  const b = importBoard(emptyBoard(), {
    tickets: [
      { id: "T-1", title: "a" },
      { id: "T-2", title: "b", state: "ready", deps: ["T-1"] },
      { id: "T-3", title: "c", state: "ready", deps: ["T-1"] },
      { id: "T-4", title: "d", state: "ready", deps: ["T-1", "T-2"] },
    ],
  }).board;
  expect(describeBlockers(b)).toBe("T-2, T-3, T-4 wait on T-1 (backlog); T-4 wait on T-2 (ready)");
});

test("setup phase: work is refused until the box is confirmed; needs parks on its request, ready waits for you", async () => {
  const s = await makeSession({ reviewer: false, requirements: "Postgres 17 reachable\nthe e2e suite runs" });
  try {
    const shell = fakeShell();
    let calls = 0;
    const prompts: string[] = [];
    const worker = fakeWorker(s.hub, s.id, async (job, hub, id) => {
      calls++;
      if (job.role === "setup") prompts.push(await fs.readFile(job.promptFile.replace("/workspace", s.paths.workspace), "utf8"));
      if (job.role === "setup" && calls === 1) {
        const h = await hub.get(id);
        await h.mutate((d) => ({ next: { inbox: { ...d.inbox, requests: [...d.inbox.requests, requestSchema.parse({ id: "R-1", summary: "the e2e suite needs the Playwright CDN", actions: [{ id: "a1", detail: { kind: "pack", pack: "playwright" } }], createdAt: now() })] } } }));
        return { text: "SETUP: needs\n- [x] Postgres 17 reachable (svc pg, psql -c 'select 1')\n- [ ] the e2e suite runs (browser download refused)\nFiled R-1." };
      }
      if (job.role === "setup") return { text: "SETUP: ready\n- [x] Postgres 17 reachable (psql)\n- [x] the e2e suite runs (12 passed)\nAll set." };
      await fileReport(hub, id, job.ticket!, "done");
      return {};
    });
    const mgr = manager(s, shell, worker);
    await expect(mgr.start(s.id)).rejects.toThrow(/Set up environment/);

    const run1 = await (await mgr.start(s.id, { setup: true })).done;
    expect(run1.state).toBe("paused");
    expect(run1.pauseReason).toBe("requests");
    let h = await s.hub.get(s.id);
    expect(h.session.readiness).toMatchObject({ verdict: "needs", checks: [{ ok: true, text: "Postgres 17 reachable (svc pg, psql -c 'select 1')" }, { ok: false, text: "the e2e suite runs (browser download refused)" }] });
    expect(h.session.state).toBe("waiting");
    expect(h.board.tickets.every((t) => t.state === "ready")).toBe(true); // nothing touched
    expect(prompts[0]).toContain("Postgres 17 reachable");

    // You answer; the next setup run sees the outcome and reports ready.
    await h.mutate((d) => ({ next: { inbox: { ...d.inbox, requests: d.inbox.requests.map((r) => ({ ...r, state: "resolved" as const, decidedAt: now(), actions: r.actions.map((a) => ({ ...a, state: "approved" as const, outcome: "allowed cdn.playwright.dev" })) })) } } }));
    const run2 = await (await mgr.start(s.id, { setup: true })).done;
    expect(run2.state).toBe("finished");
    h = await s.hub.get(s.id);
    expect(h.session.readiness).toMatchObject({ verdict: "ready" });
    expect(h.session.state).toBe("setup"); // ready, but not confirmed
    expect(prompts[1]).toContain("allowed cdn.playwright.dev");
    await expect(mgr.start(s.id)).rejects.toThrow(/confirm it/);

    // Confirmed: tickets run, and every worker gets the environment description.
    await fs.writeFile(path.join(s.paths.notes, "env.md"), "# Environment\n- postgres: svc pg, port 5432\n");
    await h.mutate((d) => ({ next: { session: { ...d.session, readiness: { ...d.session.readiness!, confirmedAt: now() } } } }));
    const run3 = await (await mgr.start(s.id)).done;
    expect(run3.state).toBe("finished");
    expect(worker.jobs.map((j) => j.role)).toEqual(["setup", "setup", "implementer", "implementer"]);
    const implPrompt = await fs.readFile(path.join(s.paths.workspace, ".verstas", "prompt.md"), "utf8");
    expect(implPrompt).toContain("svc pg, port 5432");
    expect(await fs.readFile(path.join(s.paths.workspace, "VERSTAS.md"), "utf8")).toContain("the e2e suite runs");
  } finally {
    await fs.rm(s.root, { recursive: true, force: true });
  }
});

test("without requirements there is no setup phase", async () => {
  const s = await makeSession({ reviewer: false });
  try {
    const worker = fakeWorker(s.hub, s.id, async (job, hub, id) => {
      await fileReport(hub, id, job.ticket!, "done");
      return {};
    });
    const run = await (await manager(s, fakeShell(), worker).start(s.id)).done;
    expect(run.state).toBe("finished");
    expect(worker.jobs.every((j) => j.role === "implementer")).toBe(true);
  } finally {
    await fs.rm(s.root, { recursive: true, force: true });
  }
});

test("parseSetup reads the verdict, the checklist and a summary", () => {
  expect(parseSetup("SETUP: ready\n- [x] node 22 (node -v)\n* [X] tests pass\nAll good.")).toEqual({ ready: true, checks: [{ ok: true, text: "node 22 (node -v)" }, { ok: true, text: "tests pass" }], summary: "All good." });
  expect(parseSetup("Preamble\nsetup: needs\n- [ ] redis (not installed)\nFiled R-2.")).toEqual({ ready: false, checks: [{ ok: false, text: "redis (not installed)" }], summary: "Filed R-2." });
  expect(parseSetup("nothing")).toBeNull();
});

test("the project brief is put first in every worker prompt, and a brief-only run calls one orientation worker", async () => {
  const s = await makeSession({ reviewer: true });
  try {
    await fs.mkdir(s.paths.notes, { recursive: true });
    await fs.writeFile(path.join(s.paths.notes, "brief.md"), "# Project brief\n## app\n- Build / test / run: npm test (12 s)\n");
    const shell = fakeShell();
    const prompts: string[] = [];
    const worker = fakeWorker(s.hub, s.id, async (job, hub, id) => {
      prompts.push(`${job.role}:` + (await fs.readFile(job.promptFile.replace("/workspace", s.paths.workspace), "utf8")));
      if (job.role === "implementer") await fileReport(hub, id, job.ticket!, "done");
      if (job.role === "reviewer") return { text: "VERDICT: ok" };
      if (job.role === "setup") {
        await fs.writeFile(path.join(s.paths.notes, "brief.md"), "# Project brief\nrefreshed\n");
        return { text: "SETUP: ready\nbrief refreshed" };
      }
      return {};
    });
    const mgr = manager(s, shell, worker);
    await (await mgr.start(s.id)).done;
    expect(prompts.length).toBe(4);
    for (const p of prompts) expect(p.split(":").slice(1).join(":").startsWith("# Project brief (notes/brief.md")).toBe(true);
    expect(prompts[0]).toContain("npm test (12 s)");
    expect(await fs.readFile(path.join(s.paths.workspace, "CLAUDE.md"), "utf8")).toContain("notes/brief.md");

    const run = await (await mgr.start(s.id, { brief: true })).done;
    expect(run.state).toBe("finished");
    expect(worker.jobs.at(-1)?.role).toBe("setup");
    expect(prompts.at(-1)).toContain("# Brief only");
    expect(await fs.readFile(path.join(s.paths.notes, "brief.md"), "utf8")).toContain("refreshed");
    expect((await s.hub.get(s.id)).board.tickets.every((t) => t.state === "done")).toBe(true); // untouched by the brief run
  } finally {
    await fs.rm(s.root, { recursive: true, force: true });
  }
});

const addRequest = async (hub: SessionHub, sessionId: string, ticketId: string) => {
  const h = await hub.get(sessionId);
  await h.mutate((d) => ({
    next: { inbox: { ...d.inbox, requests: [...d.inbox.requests, requestSchema.parse({ id: `R-${d.inbox.requests.length + 1}`, ticketId, summary: "need a host", actions: [{ id: "a1", detail: { kind: "network", host: "cdn.example.com" } }], createdAt: now() })] } },
  }));
};

const resolveAll = async (hub: SessionHub, sessionId: string) => {
  const h = await hub.get(sessionId);
  await h.mutate((d) => ({
    next: {
      inbox: { ...d.inbox, requests: d.inbox.requests.map((r) => ({ ...r, state: "resolved" as const, decidedAt: now(), actions: r.actions.map((a) => ({ ...a, state: "approved" as const })) })) },
      board: { ...d.board, tickets: d.board.tickets.map((t) => (t.state === "waiting" ? { ...t, state: "ready" as const } : t)) },
    },
  }));
};

test("parking on a request costs no attempt; only verdicts count", async () => {
  const s = await makeSession({ attempts: 2 });
  try {
    const shell = fakeShell();
    let impl = 0;
    const worker = fakeWorker(s.hub, s.id, async (job, hub, id) => {
      if (job.role === "implementer" && job.ticket === "T-1" && ++impl === 1) {
        await addRequest(hub, id, "T-1");
        return {};
      }
      if (job.role === "implementer") await fileReport(hub, id, job.ticket!, "tried");
      if (job.role === "reviewer") return { text: "VERDICT: fixable\nOne more pass." };
      return {};
    });
    const mgr = manager(s, shell, worker);
    await (await mgr.start(s.id)).done;
    let h = await s.hub.get(s.id);
    expect(h.board.tickets[0]!.state).toBe("waiting");
    expect(h.board.tickets[0]!.attempts).toBe(0);
    await resolveAll(s.hub, s.id);
    await (await mgr.start(s.id)).done;
    h = await s.hub.get(s.id);
    const t1 = h.board.tickets[0]!;
    // Two judged attempts after the park: requeued once, then blocked.
    expect(t1.attempts).toBe(2);
    expect(t1.state).toBe("blocked");
    expect(t1.notes.map((n) => n.text).join("\n")).toContain("attempt 1 of 2");
  } finally {
    await fs.rm(s.root, { recursive: true, force: true });
  }
});

test("a failing harness gate is evidence for the reviewer, not a verdict", async () => {
  const s = await makeSession();
  try {
    const shell = fakeShell();
    const base = shell.exec.bind(shell);
    shell.exec = async (cmd, opts) => (cmd.join(" ").startsWith("npm run --silent test") ? { code: 1, stdout: "", stderr: "browserType.launch: Executable doesn't exist" } : base(cmd, opts));
    const reviewerPrompts: string[] = [];
    const worker = fakeWorker(s.hub, s.id, async (job, hub, id) => {
      if (job.role === "implementer") await fileReport(hub, id, job.ticket!, "done; e2e needs the browser from T-2");
      if (job.role === "reviewer") {
        reviewerPrompts.push(await fs.readFile(job.promptFile.replace("/workspace", s.paths.workspace), "utf8"));
        return { text: "VERDICT: ok\nThe e2e failure is the missing browser, which a later ticket installs." };
      }
      return {};
    });
    const run = await (await manager(s, shell, worker).start(s.id)).done;
    expect(run.state).toBe("finished");
    expect((await s.hub.get(s.id)).board.tickets.map((t) => t.state)).toEqual(["done", "done"]);
    expect(reviewerPrompts[0]).toContain("evidence, not a verdict");
    expect(reviewerPrompts[0]).toContain("FAILED npm run test");
  } finally {
    await fs.rm(s.root, { recursive: true, force: true });
  }
});

test("a ticket with no diff is done when the reviewer accepts the report", async () => {
  const s = await makeSession();
  try {
    const shell = fakeShell();
    const base = shell.exec.bind(shell);
    shell.exec = async (cmd, opts) => (cmd.join(" ") === "git diff --cached --numstat" ? { code: 0, stdout: "", stderr: "" } : base(cmd, opts));
    const worker = fakeWorker(s.hub, s.id, async (job, hub, id) => {
      if (job.role === "implementer") await fileReport(hub, id, job.ticket!, "Investigated; findings in the report.");
      if (job.role === "reviewer") return { text: "VERDICT: ok\nThe report answers the question." };
      return {};
    });
    const run = await (await manager(s, shell, worker).start(s.id)).done;
    expect(run.state).toBe("finished");
    const h = await s.hub.get(s.id);
    expect(h.board.tickets.map((t) => t.state)).toEqual(["done", "done"]);
    expect(worker.jobs.filter((j) => j.role === "reviewer")).toHaveLength(2);
    expect(h.board.tickets[0]!.notes.at(-1)?.text).toContain("no files changed");
  } finally {
    await fs.rm(s.root, { recursive: true, force: true });
  }
});

test("without a reviewer, no diff and no report is not done", async () => {
  const s = await makeSession({ reviewer: false, attempts: 1 });
  try {
    const shell = fakeShell();
    const base = shell.exec.bind(shell);
    shell.exec = async (cmd, opts) => (cmd.join(" ") === "git diff --cached --numstat" ? { code: 0, stdout: "", stderr: "" } : base(cmd, opts));
    const worker = fakeWorker(s.hub, s.id, async () => ({}));
    await (await manager(s, shell, worker).start(s.id)).done;
    const t1 = (await s.hub.get(s.id)).board.tickets[0]!;
    expect(t1.state).toBe("blocked");
    expect(t1.notes.at(-1)?.text).toContain("no files changed and no report");
  } finally {
    await fs.rm(s.root, { recursive: true, force: true });
  }
});

test("recover after a host crash: stops the orphaned worker, requeues held tickets, closes the run", async () => {
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
    const shell = fakeShell();
    const mgr = manager(s, shell, fakeWorker(s.hub, s.id, async () => ({})));
    const did = await mgr.recover(s.id);
    expect(did.join("; ")).toContain("requeued T-1");
    expect(shell.calls).toContainEqual(["pkill", "-TERM", "-f", "/opt/verstas/worker.js"]);
    expect((await s.hub.get(s.id)).board.tickets[0]!.state).toBe("ready");
    expect((await s.hub.get(s.id)).session.state).toBe("paused");
    const run = JSON.parse(await fs.readFile(path.join(s.paths.runs, "1", "run.json"), "utf8"));
    expect(run).toMatchObject({ state: "stopped", pauseReason: "host app restarted" });
    // Nothing left to do the second time.
    expect(await mgr.recover(s.id)).toEqual([]);
  } finally {
    await fs.rm(s.root, { recursive: true, force: true });
  }
});

test("a prompt runs one worker with your text and the notes, commits a change as one commit, keeps the reply, and is allowed during setup", async () => {
  const s = await makeSession({ requirements: "the e2e suite runs" });
  try {
    await fs.mkdir(s.paths.notes, { recursive: true });
    await fs.writeFile(path.join(s.paths.notes, "env.md"), "# Environment\n- node 22\n");
    const shell = fakeShell();
    let promptText = "";
    const worker = fakeWorker(s.hub, s.id, async (job) => {
      promptText = await fs.readFile(job.promptFile.replace("/workspace", s.paths.workspace), "utf8");
      return { text: "Installed the browsers; the e2e suite runs (12 passed). env.md updated." };
    });
    const run = await (await manager(s, shell, worker).start(s.id, { prompt: "Make sure the e2e suite runs\nand update env.md" })).done;
    expect(run.state).toBe("finished");
    expect(worker.jobs.map((j) => [j.role, j.ticket])).toEqual([["prompt", undefined]]);
    expect(promptText).toContain("# Request from the user");
    expect(promptText).toContain("node 22");
    expect(shell.commits).toEqual(["Prompt: Make sure the e2e suite runs"]);
    const h = await s.hub.get(s.id);
    expect(h.session.prompts).toHaveLength(1);
    expect(h.session.prompts[0]).toMatchObject({ runId: 1, reply: expect.stringContaining("12 passed") });
    expect(h.board.tickets.every((t) => t.state === "ready")).toBe(true);
    expect(h.session.state).toBe("setup"); // still gated: a prompt is not a confirmation
    await expect(manager(s, shell, worker).start(s.id, { prompt: "  " })).rejects.toThrow(/empty/);
  } finally {
    await fs.rm(s.root, { recursive: true, force: true });
  }
});

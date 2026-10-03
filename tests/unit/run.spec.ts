import { test, expect } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunTokens } from "../../src/agent-api/agent-api.js";
import { importBoard, emptyBoard, getTicket, replaceTicket } from "../../src/board/board.js";
import { saveBoard, writeJsonAtomic } from "../../src/board/store.js";
import { inboxSchema, now, requestSchema, sessionSchema, type VerstasEvent } from "../../src/core/types.js";
import { parseVerdict, RunManager, type Shell, type WorkerDone, type WorkerRunner } from "../../src/harness/run.js";
import { SessionHub } from "../../src/sessions/hub.js";
import { sessionPaths } from "../../src/sessions/sessions.js";
import type { Job } from "../../src/worker/worker.js";

/**
 * The loop with fakes: a shell that answers git and npm like a repo with
 * passing tests, and a worker scripted per role. What is asserted is the
 * loop's decisions: board moves, commit messages, run state.
 */

const makeSession = async (opts: { reviewer?: boolean; attempts?: number } = {}) => {
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
    expect(run.pauseReason).toBe("waiting on dependencies");
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
                detail: kind === "network" ? { kind, host: "fonts.googleapis.com" } : { kind, reason: "spec contradiction", severity: "critical" },
                why: "need it",
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
        inbox: { ...d.inbox, requests: d.inbox.requests.map((r) => ({ ...r, state: "approved" as const, answer: "allowed", decidedAt: now() })) },
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

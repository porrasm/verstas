import { test, expect } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgentApi, RunTokens } from "../../src/agent-api/agent-api.js";
import type net from "node:net";
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

const makeSession = async (
  opts: {
    reviewer?: boolean;
    attempts?: number;
    resume?: boolean;
    mode?: "loop" | "lead";
    requirements?: string;
    /** false: a plan that still needs Initialize (the default is an initialized session). */
    initialized?: boolean;
    setupMode?: "agentic" | "skip";
    agents?: { worker?: { driver: "claude" | "codex" | "cursor"; model?: string }; reviewer?: { driver: "claude" | "codex" | "cursor"; model?: string } };
  } = {},
) => {
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
      createdAt: now(),
      initializedAt: opts.initialized === false ? null : now(),
      repos: [{ name: "app", sourcePath: "/x", branch: "main", runBranch: `verstas/${id}` }],
      requirements: opts.requirements ?? "",
      setupMode: opts.setupMode ?? "agentic",
      mode: opts.mode ?? "loop",
      agents: opts.agents ?? {},
      caps: { reviewer: opts.reviewer ?? true, ticketAttempts: opts.attempts ?? 2, runTickets: 10, resumeWorker: opts.resume ?? false },
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

/** A path inside the container, on the host. */
const onHost = (s: { paths: { workspace: string } }, p: string): string => p.replace(/^\/workspace/, s.paths.workspace);

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
    expect(JSON.parse(await fs.readFile(onHost(s, worker.jobs.at(-1)!.promptFile.replace("prompt.md", "job.json")), "utf8"))).toMatchObject({ role: "reviewer", ticket: "T-2" });
    // Each worker had its own directory.
    expect(new Set(worker.jobs.map((j) => j.promptFile)).size).toBe(4);
    const log = await fs.readFile(path.join(s.paths.runs, "1", "events.jsonl"), "utf8");
    expect(log.split("\n").filter(Boolean).length).toBeGreaterThan(8);
    expect(await fs.readFile(path.join(s.paths.runs, "1", "tickets", "T-1.md"), "utf8")).toContain("did the thing");
  } finally {
    await fs.rm(s.root, { recursive: true, force: true });
  }
});

test("the reviewer can be a different agent: each job names its driver and model, and the workspace carries files for every agent", async () => {
  const s = await makeSession({ agents: { worker: { driver: "claude", model: "sonnet" }, reviewer: { driver: "codex", model: "gpt-5.1-codex" } } });
  try {
    const shell = fakeShell();
    const worker = fakeWorker(s.hub, s.id, async (job, hub, id) => {
      if (job.role === "implementer") await fileReport(hub, id, job.ticket!, "done");
      if (job.role === "reviewer") return { text: "VERDICT: ok" };
      return {};
    });
    const run = await (await manager(s, shell, worker).start(s.id)).done;
    expect(run.state).toBe("finished");
    expect(worker.jobs.map((j) => `${j.role}:${j.driver}:${j.model}`)).toEqual(["implementer:claude:sonnet", "reviewer:codex:gpt-5.1-codex", "implementer:claude:sonnet", "reviewer:codex:gpt-5.1-codex"]);
    expect(JSON.parse(await fs.readFile(onHost(s, worker.jobs.at(-1)!.promptFile.replace("prompt.md", "job.json")), "utf8"))).toMatchObject({ role: "reviewer", driver: "codex", model: "gpt-5.1-codex" });
    expect(await fs.readFile(path.join(s.paths.workspace, "AGENTS.md"), "utf8")).toContain("/workspace/VERSTAS.md");
    expect(await fs.stat(path.join(s.paths.workspace, ".cursor", "mcp.json")).catch(() => null)).toBeNull();
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

test("the planner runs your request and leaves the backlog for approval; a work run on an empty board plans nothing", async () => {
  const s = await makeSession({ reviewer: false });
  try {
    await saveBoard(s.paths.dir, emptyBoard());
    s.hub.forget(s.id);
    const shell = fakeShell();
    let promptText = "";
    const worker = fakeWorker(s.hub, s.id, async (job, hub, id) => {
      expect(job.role).toBe("planner");
      promptText = await fs.readFile(job.promptFile.replace("/workspace", s.paths.workspace), "utf8");
      const h = await hub.get(id);
      await h.mutate((d) => ({ next: { board: importBoard(d.board, { tickets: [{ title: "Planned A" }, { title: "Planned B" }] }, { by: "agent", role: "planner" }).board } }));
      return { text: "Two tickets: schema, then engine." };
    });
    const mgr = manager(s, shell, worker);
    // Nothing to work on and no request: the run ends without a planner.
    const idle = await (await mgr.start(s.id)).done;
    expect(idle.state).toBe("finished");
    expect(worker.jobs).toHaveLength(0);
    await expect(mgr.start(s.id, { plan: "  " })).rejects.toThrow(/what to plan/);

    const run = await (await mgr.start(s.id, { plan: "Build the mapping engine with a mock MIDI output" })).done;
    expect(run.state).toBe("finished");
    const h = await s.hub.get(s.id);
    expect(h.board.tickets.map((t) => t.state)).toEqual(["backlog", "backlog"]);
    expect(worker.jobs).toHaveLength(1);
    expect(promptText).toContain("# What to plan\nBuild the mapping engine with a mock MIDI output");
    expect(h.session.prompts).toEqual([expect.objectContaining({ kind: "plan", text: "Build the mapping engine with a mock MIDI output", reply: "Two tickets: schema, then engine." })]);
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

test("initialization: nothing runs before it; needs parks on its request and stays uninitialized; ready initializes and, with start, the tickets follow", async () => {
  const s = await makeSession({ reviewer: false, initialized: false, requirements: "Postgres 17 reachable\nthe e2e suite runs" });
  try {
    const shell = fakeShell();
    let calls = 0;
    const prompts: string[] = [];
    const snapshots: string[] = [];
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
    const mgr = new RunManager({
      hub: s.hub,
      tokens: new RunTokens(),
      shell: () => shell,
      worker: () => worker,
      ensureSandbox: async () => undefined,
      snapshotSandbox: async (session) => {
        snapshots.push(session.id);
        return { image: "verstas-snap-x", baseImageId: "sha256:base" };
      },
      agentApiUrl: "http://host.docker.internal:4701/agent",
      rateLimitSleepMs: 20,
    });
    // A plan: no work, no planner, no prompt until it is initialized.
    await expect(mgr.start(s.id)).rejects.toThrow(/not initialized/);
    await expect(mgr.start(s.id, { plan: "x" })).rejects.toThrow(/not initialized/);
    await expect(mgr.start(s.id, { prompt: "x" })).rejects.toThrow(/not initialized/);

    const run1 = await (await mgr.start(s.id, { init: true, start: true })).done;
    expect(run1.state).toBe("paused");
    expect(run1.pauseReason).toBe("requests");
    let h = await s.hub.get(s.id);
    expect(h.session.initializedAt).toBeNull();
    expect(h.session.readiness).toMatchObject({ verdict: "needs", checks: [{ ok: true, text: "Postgres 17 reachable (svc pg, psql -c 'select 1')" }, { ok: false, text: "the e2e suite runs (browser download refused)" }] });
    expect(h.session.readiness?.confirmedAt).toBeUndefined();
    expect(h.session.state).toBe("waiting");
    expect(h.board.tickets.every((t) => t.state === "ready")).toBe(true); // nothing touched, start was dropped
    expect(prompts[0]).toContain("# Setup instructions from the user\nPostgres 17 reachable");
    expect(prompts[0]).not.toContain("goal");
    expect(snapshots).toEqual([]);

    // You answer; initialization continues, the worker reports ready, and the tickets follow in the same run.
    await h.mutate((d) => ({ next: { inbox: { ...d.inbox, requests: d.inbox.requests.map((r) => ({ ...r, state: "resolved" as const, decidedAt: now(), actions: r.actions.map((a) => ({ ...a, state: "approved" as const, outcome: "allowed cdn.playwright.dev" })) })) } } }));
    await fs.writeFile(path.join(s.paths.notes, "env.md"), "# Environment\n- postgres: svc pg, port 5432\n");
    const run2 = await (await mgr.start(s.id, { init: true, start: true })).done;
    expect(run2.state).toBe("finished");
    h = await s.hub.get(s.id);
    expect(h.session.initializedAt).toBeTruthy();
    expect(h.session.readiness).toMatchObject({ verdict: "ready", confirmedAt: expect.any(String) });
    expect(h.session.snapshot).toMatchObject({ image: "verstas-snap-x" });
    expect(h.session.state).toBe("finished");
    expect(prompts[1]).toContain("allowed cdn.playwright.dev");
    expect(worker.jobs.map((j) => j.role)).toEqual(["setup", "setup", "implementer", "implementer"]);
    const implPrompt = await fs.readFile(onHost(s, worker.jobs.at(-1)!.promptFile), "utf8");
    expect(implPrompt).toContain("svc pg, port 5432");
    expect(await fs.readFile(path.join(s.paths.workspace, "VERSTAS.md"), "utf8")).toContain("the e2e suite runs");

    // Initialized: a setup check runs the worker again and stops; a work run needs no confirmation.
    const run3 = await (await mgr.start(s.id, { setup: true })).done;
    expect(run3.state).toBe("finished");
    expect(worker.jobs.map((j) => j.role).slice(-1)).toEqual(["setup"]);
  } finally {
    await fs.rm(s.root, { recursive: true, force: true });
  }
});

test("initialize without start: ready initializes and the run stops, the tickets wait", async () => {
  const s = await makeSession({ reviewer: false, initialized: false });
  try {
    const worker = fakeWorker(s.hub, s.id, async (job) => {
      expect(job.role).toBe("setup");
      return { text: "SETUP: ready\n- [x] node 22 (node -v)\nFine." };
    });
    const run = await (await manager(s, fakeShell(), worker).start(s.id, { init: true })).done;
    expect(run.state).toBe("finished");
    const h = await s.hub.get(s.id);
    expect(h.session.initializedAt).toBeTruthy();
    expect(h.session.state).toBe("finished");
    expect(h.board.tickets.every((t) => t.state === "ready")).toBe(true);
    expect(worker.jobs).toHaveLength(1);
  } finally {
    await fs.rm(s.root, { recursive: true, force: true });
  }
});

test("skip mode: initialization is the container and the recipes, no setup worker; with start the tickets follow at once", async () => {
  const s = await makeSession({ reviewer: false, initialized: false, setupMode: "skip" });
  try {
    const worker = fakeWorker(s.hub, s.id, async (job, hub, id) => {
      await fileReport(hub, id, job.ticket!, "done");
      return {};
    });
    const run = await (await manager(s, fakeShell(), worker).start(s.id, { init: true, start: true })).done;
    expect(run.state).toBe("finished");
    expect(worker.jobs.map((j) => j.role)).toEqual(["implementer", "implementer"]);
    const h = await s.hub.get(s.id);
    expect(h.session.initializedAt).toBeTruthy();
    expect(h.session.readiness).toBeUndefined();
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

test("a prompt runs one worker with your text and the notes, commits a change as one commit, and keeps the reply", async () => {
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
    expect(h.session.prompts[0]).toMatchObject({ runId: 1, kind: "prompt", reply: expect.stringContaining("12 passed") });
    expect(h.board.tickets.every((t) => t.state === "ready")).toBe(true);
    expect(h.session.state).toBe("finished");
    await expect(manager(s, shell, worker).start(s.id, { prompt: "  " })).rejects.toThrow(/empty/);
  } finally {
    await fs.rm(s.root, { recursive: true, force: true });
  }
});

test("a change that contains the Claude token is never committed; the ticket is blocked with the reason", async () => {
  const s = await makeSession({ reviewer: false });
  try {
    const token = "sk-ant-oat01-THIS-IS-A-FAKE-TOKEN-FOR-THE-TEST-0123456789";
    const shell = fakeShell();
    const base = shell.exec.bind(shell);
    shell.exec = async (cmd, opts) => (cmd.join(" ") === "git diff --cached --no-color --text" ? { code: 0, stdout: `+CLAUDE_CODE_OAUTH_TOKEN=${token}\n`, stderr: "" } : base(cmd, opts));
    const worker = fakeWorker(s.hub, s.id, async (job, hub, id) => {
      await fileReport(hub, id, job.ticket!, "done");
      return {};
    });
    const mgr = new RunManager({ hub: s.hub, tokens: new RunTokens(), shell: () => shell, worker: () => worker, ensureSandbox: async () => undefined, agentApiUrl: "x", secrets: async () => [token] });
    await (await mgr.start(s.id)).done;
    const t1 = (await s.hub.get(s.id)).board.tickets[0]!;
    expect(t1.state).toBe("blocked");
    expect(t1.notes.at(-1)?.text).toContain("Claude token appears in the changes to app");
    expect(shell.commits).toEqual([]);
    expect(shell.calls).toContainEqual(["git", "reset", "-q"]);
    // The token never went into a command the box would see.
    expect(shell.calls.some((c) => c.join(" ").includes(token))).toBe(false);
  } finally {
    await fs.rm(s.root, { recursive: true, force: true });
  }
});

test("with resumeWorker, implementers of a run continue one conversation; the reviewer and a failed resume start fresh", async () => {
  const s = await makeSession({ resume: true });
  try {
    let failResume = false;
    const prompts: string[] = [];
    const worker = fakeWorker(s.hub, s.id, async (job, hub, id) => {
      if (job.role === "implementer") {
        prompts.push(await fs.readFile(onHost(s, job.promptFile), "utf8"));
        if (job.agentSession?.resume && failResume) {
          failResume = false;
          return { ok: false, turns: 0, stopReason: "error_during_execution" };
        }
        await fileReport(hub, id, job.ticket!, "did it");
      }
      if (job.role === "reviewer") return { text: "VERDICT: ok" };
      return {};
    });
    const ctl = await manager(s, fakeShell(), worker).start(s.id);
    expect((await ctl.done).ticketsDone).toBe(2);
    const impl = worker.jobs.filter((j) => j.role === "implementer");
    expect(impl[0]!.agentSession).toMatchObject({ resume: false });
    expect(impl[1]!.agentSession).toEqual({ id: impl[0]!.agentSession!.id, resume: true });
    expect(worker.jobs.filter((j) => j.role === "reviewer").every((j) => !j.agentSession)).toBe(true);
    expect(impl.every((j) => j.budgetFile === j.promptFile.replace("prompt.md", "budget.json"))).toBe(true);
    expect(prompts[1]).toContain("continuing in the same conversation");
    expect(prompts[1]).not.toContain("Recent reports from other workers");

    // A resume that fails before its first turn falls back to a fresh conversation with the full prompt.
    const h = await s.hub.get(s.id);
    await h.mutate((d) => ({ next: { board: importBoard(d.board, { tickets: [{ id: "T-3", title: "Cache", state: "ready" }, { id: "T-4", title: "Docs", state: "ready" }] }).board } }));
    failResume = true;
    worker.jobs.length = 0;
    prompts.length = 0;
    const again = await manager(s, fakeShell(), worker).start(s.id);
    expect((await again.done).ticketsDone).toBe(2);
    const impl2 = worker.jobs.filter((j) => j.role === "implementer");
    expect(impl2.map((j) => j.agentSession?.resume)).toEqual([false, true, false]);
    expect(impl2[2]!.agentSession!.id).not.toBe(impl2[1]!.agentSession!.id);
    expect(prompts[2]).toContain("Recent reports from other workers");
  } finally {
    await fs.rm(s.root, { recursive: true, force: true });
  }
});

test("without resumeWorker every implementer is a throwaway conversation", async () => {
  const s = await makeSession();
  try {
    const worker = fakeWorker(s.hub, s.id, async (job, hub, id) => {
      if (job.role === "implementer") await fileReport(hub, id, job.ticket!, "ok");
      return job.role === "reviewer" ? { text: "VERDICT: ok" } : {};
    });
    await (await manager(s, fakeShell(), worker).start(s.id)).done;
    expect(worker.jobs.every((j) => !j.agentSession)).toBe(true);
  } finally {
    await fs.rm(s.root, { recursive: true, force: true });
  }
});

test("every worker gets its own run token, scoped to its role and ticket and revoked when it ends", async () => {
  const s = await makeSession();
  try {
    const tokens = new RunTokens();
    const seen: { role: string; token: string; info: unknown }[] = [];
    const worker: WorkerRunner = {
      async run(job, _onEvent, _signal, opts) {
        seen.push({ role: job.role, token: opts!.runToken!, info: tokens.lookup(opts!.runToken!) });
        if (job.role === "implementer") await fileReport(s.hub, s.id, job.ticket!, "ok");
        return { kind: "worker_done", t: now(), ticket: job.ticket, role: job.role, ok: true, stopReason: "success", rateLimited: false, costUsd: 0, turns: 1, seconds: 1, text: job.role === "reviewer" ? "VERDICT: ok" : "", stderr: "" };
      },
    };
    const mgr = new RunManager({ hub: s.hub, tokens, shell: () => fakeShell(), worker: () => worker, ensureSandbox: async () => undefined, agentApiUrl: "http://x/agent" });
    await (await mgr.start(s.id)).done;
    expect(seen.map((x) => x.role)).toEqual(["implementer", "reviewer", "implementer", "reviewer"]);
    expect(new Set(seen.map((x) => x.token)).size).toBe(4);
    expect(seen[0]!.info).toMatchObject({ role: "worker", currentTicket: "T-1" });
    expect(seen[3]!.info).toMatchObject({ role: "worker", currentTicket: "T-2" });
    for (const x of seen) expect(tokens.lookup(x.token)).toBeUndefined();

    await (await mgr.start(s.id, { plan: "add caching" })).done;
    expect(seen.at(-1)!.info).toMatchObject({ role: "planner" });
    expect((seen.at(-1)!.info as { currentTicket?: string }).currentTicket).toBeUndefined();
  } finally {
    await fs.rm(s.root, { recursive: true, force: true });
  }
});

// --- Lead mode ---------------------------------------------------------------

type Api = (method: string, p: string, body?: unknown) => Promise<{ status: number; json: Record<string, unknown> }>;
type LeadScript = (api: Api, job: Job, n: number, signal: AbortSignal) => Promise<Partial<WorkerDone>>;

/**
 * A lead run against the real agent API on a local port, the way the board
 * server inside the box would call it. The reviewer is scripted; the lead
 * script gets an API client bound to that lead's own run token.
 */
const leadRun = async (s: Awaited<ReturnType<typeof makeSession>>, lead: LeadScript, opts: { verdict?: (ticket: string) => string } = {}) => {
  const tokens = new RunTokens();
  const shell = fakeShell();
  const jobs: Job[] = [];
  const prompts: string[] = [];
  let leads = 0;
  let port = 0;
  const worker: WorkerRunner = {
    async run(job, _onEvent, signal, o) {
      jobs.push(job);
      const base = { kind: "worker_done" as const, t: now(), ticket: job.ticket, role: job.role, ok: true, stopReason: "success", rateLimited: false, costUsd: 0.1, turns: 3, seconds: 1, text: "", stderr: "" };
      if (job.role === "reviewer") return { ...base, text: opts.verdict?.(job.ticket!) ?? "VERDICT: ok" };
      prompts.push(await fs.readFile(onHost(s, job.promptFile), "utf8"));
      const api: Api = async (method, p, body) => {
        const res = await fetch(`http://127.0.0.1:${port}/agent${p}`, { method, headers: { authorization: `Bearer ${o!.runToken}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: res.status, json: (await res.json()) as Record<string, unknown> };
      };
      const out = await lead(api, job, ++leads, signal);
      return { ...base, stopReason: signal.aborted ? "aborted" : "success", ...out };
    },
  };
  const mgr = new RunManager({ hub: s.hub, tokens, shell: () => shell, worker: () => worker, ensureSandbox: async () => undefined, agentApiUrl: "http://x/agent", rateLimitSleepMs: 20, handoffGraceMs: 50 });
  const server = createAgentApi(s.hub, tokens, mgr).listen(0, "127.0.0.1");
  port = await new Promise<number>((r) => server.on("listening", () => r((server.address() as net.AddressInfo).port)));
  return { mgr, jobs, prompts, shell, close: () => server.close() };
};

/** What board_submit does: submit, then wait for the verdict. */
const submit = async (api: Api, id: string) => {
  const r = await api("POST", `/tickets/${id}/submit`, {});
  if (r.status !== 200) return r.json;
  for (;;) {
    await new Promise((res) => setTimeout(res, 5));
    const t = (await api("GET", `/tickets/${id}`)).json;
    if (t.state !== "review") return t;
  }
};

const finishTicket = async (api: Api, id: string) => {
  expect((await api("POST", `/tickets/${id}/claim`, {})).status).toBe(200);
  await api("POST", `/tickets/${id}/report`, { report: `${id} done` });
  return submit(api, id);
};

test("lead mode: one lead claims, submits and finishes the board; the harness judges and commits each ticket", async () => {
  const s = await makeSession({ mode: "lead" });
  const r = await leadRun(s, async (api, job) => {
    expect(job.role).toBe("lead");
    // T-2 waits on T-1: not claimable yet.
    expect((await api("POST", "/tickets/T-2/claim", {})).json.error).toContain("waits on T-1");
    expect(await finishTicket(api, "T-1")).toMatchObject({ state: "done" });
    expect(await finishTicket(api, "T-2")).toMatchObject({ state: "done" });
    return { text: "board done" };
  });
  try {
    const run = await (await r.mgr.start(s.id)).done;
    expect(run.state).toBe("finished");
    expect(run.ticketsDone).toBe(2);
    expect(r.jobs.map((j) => j.role)).toEqual(["lead", "reviewer", "reviewer"]);
    expect(r.shell.commits).toEqual(["T-1: Schema", "T-2: Engine"]);
    const lead = r.jobs[0]!;
    expect(lead.caps).toMatchObject({ minutes: 180, turns: 600 });
    expect(lead.agentSession).toMatchObject({ resume: false });
    expect(r.prompts[0]).toContain("# Work the board");
    expect(r.prompts[0]).toContain("T-2 [ready] Engine");
    const h = await s.hub.get(s.id);
    expect(h.board.tickets.map((t) => t.state)).toEqual(["done", "done"]);
    expect(h.board.tickets[0]!.notes.map((n) => n.text)).toEqual(expect.arrayContaining([expect.stringContaining("Claimed by the lead"), "Submitted for review by the lead", expect.stringContaining("Reviewed ok")]));
  } finally {
    r.close();
    await fs.rm(s.root, { recursive: true, force: true });
  }
});

test("lead mode: a fixable verdict comes back to the lead, which fixes and resubmits", async () => {
  const s = await makeSession({ mode: "lead" });
  let reviews = 0;
  const r = await leadRun(
    s,
    async (api) => {
      expect(await finishTicket(api, "T-1")).toMatchObject({ state: "ready", attempts: 1 });
      expect(await finishTicket(api, "T-1")).toMatchObject({ state: "done", attempts: 2 });
      expect(await finishTicket(api, "T-2")).toMatchObject({ state: "done" });
      return {};
    },
    { verdict: () => (++reviews === 1 ? "VERDICT: fixable\nno test for the null case" : "VERDICT: ok") },
  );
  try {
    expect((await (await r.mgr.start(s.id)).done).ticketsDone).toBe(2);
    expect(r.shell.commits).toEqual(["T-1 (wip attempt 1): Schema", "T-1: Schema", "T-2: Engine"]);
  } finally {
    r.close();
    await fs.rm(s.root, { recursive: true, force: true });
  }
});

test("lead mode: a lead that ends with work left is resumed; a handoff starts a fresh lead with the note, still holding its ticket", async () => {
  const s = await makeSession({ mode: "lead" });
  const r = await leadRun(s, async (api, _job, n) => {
    if (n === 1) {
      expect(await finishTicket(api, "T-1")).toMatchObject({ state: "done" });
      return { text: "stopping early" };
    }
    if (n === 2) {
      expect((await api("POST", "/tickets/T-2/claim", {})).status).toBe(200);
      expect((await api("POST", "/handoff", { note: "T-2: engine half written, tests next" })).status).toBe(200);
      expect((await api("POST", "/tickets/T-3/claim", {})).json.error).toContain("handed off");
      return {};
    }
    // The fresh lead holds T-2 without claiming it again.
    await api("POST", "/tickets/T-2/report", { report: "engine done" });
    expect(await submit(api, "T-2")).toMatchObject({ state: "done" });
    return {};
  });
  try {
    const run = await (await r.mgr.start(s.id)).done;
    expect(run.state).toBe("finished");
    const leads = r.jobs.filter((j) => j.role === "lead");
    expect(leads).toHaveLength(3);
    expect(leads[1]!.agentSession).toEqual({ id: leads[0]!.agentSession!.id, resume: true });
    expect(r.prompts[1]).toContain("# Continue");
    expect(leads[2]!.agentSession).toMatchObject({ resume: false });
    expect(leads[2]!.agentSession!.id).not.toBe(leads[0]!.agentSession!.id);
    expect(r.prompts[2]).toContain("Note from the previous lead");
    expect(r.prompts[2]).toContain("engine half written");
    expect(r.prompts[2]).toContain("You hold T-2 (in_progress)");
    expect(await fs.readFile(path.join(s.paths.notes, "state.md"), "utf8")).toContain("engine half written");
  } finally {
    r.close();
    await fs.rm(s.root, { recursive: true, force: true });
  }
});

test("lead mode: a request parks the held ticket and the lead moves on; the run waits on the inbox", async () => {
  const s = await makeSession({ mode: "lead" });
  const h0 = await s.hub.get(s.id);
  await h0.mutate((d) => ({ next: { board: importBoard(d.board, { tickets: [{ id: "T-3", title: "Docs", state: "ready" }] }).board } }));
  const r = await leadRun(s, async (api) => {
    expect((await api("POST", "/tickets/T-1/claim", {})).status).toBe(200);
    const req = await api("POST", "/requests", { summary: "need the staging DSN", actions: [{ kind: "question", text: "Which database?" }] });
    expect(req.json.next).toContain("claim another");
    // Parking happens in the background; the next claim succeeds once it has.
    for (let i = 0; i < 100 && (await api("POST", "/tickets/T-3/claim", {})).status !== 200; i++) await new Promise((res) => setTimeout(res, 5));
    await api("POST", "/tickets/T-3/report", { report: "docs" });
    expect(await submit(api, "T-3")).toMatchObject({ state: "done" });
    return { text: "T-1 waits on the user; T-2 waits on T-1" };
  });
  try {
    const run = await (await r.mgr.start(s.id)).done;
    expect(run).toMatchObject({ state: "paused", pauseReason: "requests", ticketsDone: 1 });
    const h = await s.hub.get(s.id);
    expect(h.board.tickets.map((t) => `${t.id}:${t.state}`)).toEqual(["T-1:waiting", "T-2:ready", "T-3:done"]);
    expect(r.shell.commits).toEqual(["T-1 (waiting): Schema", "T-3: Docs"]);
  } finally {
    r.close();
    await fs.rm(s.root, { recursive: true, force: true });
  }
});

test("lead mode: two leads in a row that move nothing pause the run", async () => {
  const s = await makeSession({ mode: "lead" });
  const r = await leadRun(s, async () => ({ text: "I think everything is fine" }));
  try {
    const run = await (await r.mgr.start(s.id)).done;
    expect(run).toMatchObject({ state: "paused", pauseReason: "the lead ended twice without moving a ticket" });
    expect(r.jobs.filter((j) => j.role === "lead")).toHaveLength(2);
  } finally {
    r.close();
    await fs.rm(s.root, { recursive: true, force: true });
  }
});

test("lead mode: pause refuses the next claim and stops after the current ticket; stop requeues what the lead holds", async () => {
  const s = await makeSession({ mode: "lead" });
  let mgr: RunManager;
  const r = await leadRun(s, async (api, _job, n, signal) => {
    if (n === 1) {
      expect((await api("POST", "/tickets/T-1/claim", {})).status).toBe(200);
      mgr.pauseAfterTicket(s.id);
      await api("POST", "/tickets/T-1/report", { report: "schema" });
      expect(await submit(api, "T-1")).toMatchObject({ state: "done" });
      expect((await api("POST", "/tickets/T-2/claim", {})).json.error).toContain("pause");
      return {};
    }
    expect((await api("POST", "/tickets/T-2/claim", {})).status).toBe(200);
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

test("lead mode: a lead that ignores its handoff is stopped after the grace period and a fresh lead takes over", async () => {
  const s = await makeSession({ mode: "lead" });
  const r = await leadRun(s, async (api, _job, n, signal) => {
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

test("the lead's rules can be replaced by a file, read for every new lead; an empty file keeps the built-in rules", async () => {
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
    expect(sys).not.toContain("Claim a ticket with");
    expect(sys).toContain("Read /workspace/VERSTAS.md first"); // the box rules stay
    expect(systemMd("lead")).toContain("Claim a ticket with");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { agentFor, DRIVER_NAMES, eventSchema, isInitialized, now, requestOutcome, runSchema, type Board, type DriverName, type Readiness, type Run, type Session, type Ticket, type TicketState, type VerstasEvent } from "../core/types.js";
import { addNote, getTicket, hasOpenWork, nextReady, replaceTicket, transition, validateRepos } from "../board/board.js";
import { writeJsonAtomic } from "../board/store.js";
import type { SessionHandle, SessionHub } from "../sessions/hub.js";
import type { RunTokens } from "../agent-api/agent-api.js";
import { workspaceSizeMb } from "../sessions/sessions.js";
import { implementerPrompt, mcpConfig, notesIndexMd, plannerPrompt, reviewerPrompt, setupPrompt, systemMd, userPrompt, verstasMd, withContext, workspaceClaudeMd } from "./prompts.js";
import type { Job } from "../worker/worker.js";

/**
 * The loop. Deterministic TypeScript: picks tickets, starts workers,
 * runs gates and the reviewer, commits, moves cards. Models only ever run
 * as workers. Everything that touches Docker is behind two small
 * interfaces so the loop is unit-tested with fakes.
 */

export type WorkerDone = Extract<VerstasEvent, { kind: "worker_done" }>;

export type ShellResult = { code: number; stdout: string; stderr: string };

/** Runs commands inside the session container as the agent user. */
export interface Shell {
  exec(cmd: readonly string[], opts?: { workdir?: string; timeoutMs?: number; input?: string }): Promise<ShellResult>;
}

/** Runs one worker job inside the container; streams events; resolves with the final line. */
export interface WorkerRunner {
  run(job: Job, onEvent: (e: VerstasEvent) => void, signal: AbortSignal, opts?: { rawLog?: string; runToken?: string; /** The job file inside the container; it also tells this worker's processes from others'. */ jobFile?: string }): Promise<WorkerDone>;
}

export const DEBUG = Boolean(process.env.VERSTAS_DEBUG);

export type RunDeps = {
  hub: SessionHub;
  tokens: RunTokens;
  /** Per session, so two sessions can run at once. */
  shell: (sessionId: string) => Shell;
  worker: (sessionId: string) => WorkerRunner;
  /** Called once before the loop; brings the sandbox up with the env file at the given path. */
  ensureSandbox: (session: Session, envFile: string, needsCredentials: boolean) => Promise<void>;
  /** Commits the box to an image once initialization succeeded, so a recreated container starts set up. Best effort. */
  snapshotSandbox?: (session: Session) => Promise<{ image: string; baseImageId: string }>;
  /** Called before every ticket: starts a stopped proxy or container; never recreates. */
  healSandbox?: (sessionId: string) => Promise<string[]>;
  agentApiUrl: string;
  /** Proxy "denied" lines since a timestamp, for the log. */
  proxyDenials?: (sessionId: string, since: string) => Promise<{ host: string; port: number }[]>;
  /** Secret values that must never be committed (the Claude token); every commit's staged diff is scanned for them. */
  secrets?: () => Promise<string[]>;
  /** For tests: a fixed clock. */
  now?: () => string;
  /** For tests: how long to sleep on a rate limit (ms). */
  rateLimitSleepMs?: number;
};

export type RunOptions = {
  /** Initialize the environment; see `RunManager.start`. */
  init?: boolean;
  /** With init: go on to the tickets once initialization succeeds. */
  start?: boolean;
  /** Your planning request: the planner turns it into tickets. */
  plan?: string;
  brief?: boolean;
  setup?: boolean;
  prompt?: string;
};

export type RunControl = {
  run: Run;
  pauseAfterTicket: () => void;
  stopNow: () => void;
  done: Promise<Run>;
};

const WORKSPACE_FILES = ".verstas";

/** What a worker of this role may do through the agent API (src/agent-api/agent-api.ts). */
const tokenRole = (role: Job["role"]): "worker" | "planner" => (role === "planner" ? "planner" : "worker");

export class RunManager {
  private active = new Map<string, RunControl>();
  /** Numbers each worker's job directory. */
  private jobSeq = 0;
  constructor(private readonly deps: RunDeps) {}

  status(sessionId: string): Run | undefined {
    return this.active.get(sessionId)?.run;
  }

  /**
   * init: initialize the environment (the container, the recipes, and the
   * setup worker unless the session's setup mode skips it); with `start`,
   * go on to the tickets when it succeeds. plan: run the planner with your
   * request first. brief: refresh the brief and stop. setup: run the setup
   * worker again and stop. prompt: run one worker with your text, no
   * ticket, and stop. Without any of them this is a work run. Everything
   * but init is refused while the session is not initialized: there is no
   * environment to run in.
   */
  async start(sessionId: string, opts: RunOptions = {}): Promise<RunControl> {
    if (this.active.has(sessionId)) throw new Error("A run is already active for this session");
    const h = await this.deps.hub.get(sessionId);
    if (opts.prompt !== undefined && !opts.prompt.trim()) throw new Error("The prompt is empty");
    if (opts.plan !== undefined && !opts.plan.trim()) throw new Error("Say what to plan");
    if (!opts.init && !isInitialized(h.session)) throw new Error("This session is not initialized: press Initialize on the session page first.");
    // Refuse up front rather than discover it ticket by ticket.
    validateRepos(h.board.tickets, h.session.repos.map((r) => r.name), { ignoreDone: true });
    const id = (await nextRunId(h.paths.runs)) ?? 1;
    const run: Run = runSchema.parse({ id, sessionId, startedAt: (this.deps.now ?? now)(), state: "running" });
    let pauseRequested = false;
    let stopRequested = false;
    const abort = new AbortController();
    const control: RunControl = {
      run,
      pauseAfterTicket: () => {
        pauseRequested = true;
      },
      stopNow: () => {
        stopRequested = true;
        abort.abort();
      },
      done: Promise.resolve(run),
    };
    control.done = this.loop(h, run, opts, { isPause: () => pauseRequested, isStop: () => stopRequested, signal: abort.signal }).finally(() => this.active.delete(sessionId));
    this.active.set(sessionId, control);
    return control;
  }

  pauseAfterTicket(sessionId: string): boolean {
    const c = this.active.get(sessionId);
    if (!c) return false;
    c.pauseAfterTicket();
    return true;
  }

  stopNow(sessionId: string): boolean {
    const c = this.active.get(sessionId);
    if (!c) return false;
    c.stopNow();
    return true;
  }

  /** Sessions with an active run. */
  activeSessions(): string[] {
    return [...this.active.keys()];
  }

  /** Every active run finishes its current ticket, then stops. */
  pauseAll(): string[] {
    const ids = this.activeSessions();
    for (const id of ids) this.pauseAfterTicket(id);
    return ids;
  }

  /** Stops every active run and waits for each loop to requeue its ticket; used on shutdown. */
  async stopAll(timeoutMs = 20_000): Promise<void> {
    const done = [...this.active.values()].map((c) => {
      c.stopNow();
      return c.done.catch(() => undefined);
    });
    await Promise.race([Promise.all(done), new Promise((r) => setTimeout(r, timeoutMs).unref())]);
  }

  /**
   * After the host app died without stopping its runs (a crash, kill -9, a
   * Mac that slept through a restart): stop any worker still running in the
   * session's container, requeue tickets a worker held, close the run that
   * was left "running", and mark the session paused. A worker's run token
   * lived only in the dead process, so an orphaned worker can no longer
   * reach the board; stopping it is the only useful thing to do.
   */
  async recover(sessionId: string): Promise<string[]> {
    if (this.active.has(sessionId)) return [];
    const d = this.deps;
    const clock = d.now ?? now;
    const h = await d.hub.get(sessionId);
    const held = h.board.tickets.filter((t) => t.state === "in_progress" || t.state === "review");
    const busy = ["running", "checking", "planning"].includes(h.session.state);
    const last = await lastRunFile(h.paths.runs);
    const runLeftOpen = last?.run.state === "running";
    if (!held.length && !busy && !runLeftOpen) return [];
    const did: string[] = [];
    const killed = await d.shell(sessionId).exec(["pkill", "-TERM", "-f", "/opt/verstas/worker.js"], { timeoutMs: 15_000 }).catch(() => null);
    if (killed?.code === 0) did.push("stopped a worker left running in the container");
    if (held.length) {
      await h.mutate((docs) => {
        let board = docs.board;
        for (const t of held) board = transition(board, t.id, "ready", { by: "harness", text: "The host app stopped while a worker held this ticket; requeued" });
        return { next: { board } };
      });
      did.push(`requeued ${held.map((t) => t.id).join(", ")}`);
    }
    if (last && runLeftOpen) {
      const closed: Run = { ...last.run, state: "stopped", endedAt: clock(), currentTicket: undefined, pauseReason: "host app restarted" };
      await writeJsonAtomic(last.file, closed);
      await fs.appendFile(path.join(path.dirname(last.file), "events.jsonl"), JSON.stringify({ kind: "run", t: clock(), state: "stopped", reason: "host app restarted" }) + "\n");
      did.push(`closed run ${last.run.id}`);
    }
    if (busy) await h.mutate((docs) => ({ next: { session: { ...docs.session, state: "paused" } } }));
    return did;
  }

  private async loop(
    h: SessionHandle,
    run: Run,
    opts: RunOptions,
    ctl: { isPause: () => boolean; isStop: () => boolean; signal: AbortSignal },
  ): Promise<Run> {
    const d = this.deps;
    const clock = d.now ?? now;
    const runDir = path.join(h.paths.runs, String(run.id));
    await fs.mkdir(path.join(runDir, "tickets"), { recursive: true });
    const log = async (event: VerstasEvent) => {
      await fs.appendFile(path.join(runDir, "events.jsonl"), JSON.stringify(event) + "\n");
      d.hub.emitRunEvent({ sessionId: h.id, runId: run.id, event });
    };
    const saveRun = () => writeJsonAtomic(path.join(runDir, "run.json"), run);
    const setSessionState = (state: Session["state"]) => h.mutate((docs) => ({ next: { session: { ...docs.session, state } } }));
    const status = (text: string, ticket?: string) => log({ kind: "status", t: clock(), ticket, text });

    try {
      await log({ kind: "run", t: clock(), state: "running" });
      await setSessionState("running");
      await saveRun();

      // One env file per session: the container is created once and keeps its
      // environment, so only session-stable values go in it. Each worker's
      // run token is passed on its exec instead (see docker-worker.ts).
      const envFile = path.join(h.paths.dir, "sandbox.env");
      await d.ensureSandbox(h.session, envFile, true);
      await this.writeWorkspaceFiles(h);

      let proceed = true;

      // Initialization and setup. init: the container and recipes are up
      // (ensureSandbox above); a setup worker makes the box fit for the
      // repositories unless the mode skips it. A "ready" verdict initializes
      // the session, and with `start` the tickets follow; "needs" parks on
      // its requests and the session stays uninitialized. setup alone (after
      // initialization): the worker runs again and the run stops.
      if (opts.init || opts.setup) {
        proceed = false;
        const agentic = opts.setup || h.session.setupMode !== "skip";
        if (opts.init) await status(agentic ? "init: container up; a setup worker makes the box fit for the repositories" : "init: container up; no setup worker (skipped)");
        let ready = true;
        if (agentic) {
          await setSessionState("checking");
          if (!opts.init) await status("setup: checking the environment again");
          const answers = h.inbox.requests.filter((r) => r.state !== "open" && !r.ticketId).map(requestOutcome);
          const done = await this.runJob(h, run, { role: "setup", promptText: setupPrompt(h.session, h.board, answers, "setup") }, log, ctl.signal);
          addCost(run, done.costUsd);
          await saveRun();
          if (ctl.signal.aborted) {
            run.state = "stopped";
            ready = false;
          } else {
            const parsed = parseSetup(done.text);
            const open = h.inbox.requests.some((r) => r.state === "open" && !r.ticketId);
            ready = Boolean(parsed?.ready) && !open && done.ok;
            const readiness: Readiness = {
              verdict: ready ? "ready" : "needs",
              at: clock(),
              summary: parsed?.summary || (done.ok ? "the setup worker gave no SETUP line" : `the setup worker ended with ${done.stopReason}`),
              checks: parsed?.checks ?? [],
              confirmedAt: ready ? clock() : undefined,
            };
            await h.mutate((docs) => ({ next: { session: { ...docs.session, readiness } } }));
            if (!ready) {
              run.state = open ? "paused" : "halted";
              run.pauseReason = open ? "requests" : `setup needs attention: ${readiness.summary.slice(0, 300)}`;
              await status(open ? `setup needs you: ${readiness.summary.slice(0, 300)}` : `setup not ready: ${readiness.summary.slice(0, 300)}`);
            } else await status(`setup: ready. ${readiness.summary.slice(0, 300)}`);
          }
        }
        if (ready) {
          if (opts.init) {
            await h.mutate((docs) => ({ next: { session: { ...docs.session, initializedAt: docs.session.initializedAt ?? clock() } } }));
            await status("init: done; the session is initialized");
          }
          // The box as it is now, committed: a recreated container starts from it instead of replaying the setup.
          if (d.snapshotSandbox) {
            const snap = await d.snapshotSandbox(h.session).catch((e: Error) => {
              void status(`snapshot skipped: ${e.message.slice(0, 200)}`);
              return undefined;
            });
            if (snap) await h.mutate((docs) => ({ next: { session: { ...docs.session, snapshot: { ...snap, at: clock() } } } }));
          }
          run.state = "finished";
          if (opts.init && opts.start) {
            proceed = true;
            await setSessionState("running");
          }
        }
      }

      // Your prompt: one worker, your text, the notes in front, no ticket. Any
      // repository change becomes one commit; the reply is kept on the session.
      if (opts.prompt !== undefined) {
        proceed = false;
        const text = opts.prompt;
        await status(`prompt: ${text.trim().split("\n")[0]!.slice(0, 120)}`);
        const done = await this.runJob(h, run, { role: "prompt", promptText: await this.withNotes(h, userPrompt(text)) }, log, ctl.signal);
        addCost(run, done.costUsd);
        const leaked = await this.commitInContainer(h, `Prompt: ${text.trim().split("\n")[0]!.slice(0, 72)}`);
        if (leaked.length) await log({ kind: "error", t: clock(), text: `The Claude token appears in the changes to ${leaked.join(", ")}; nothing was committed there. Remove it from the files.` });
        const entry = { at: clock(), runId: run.id, kind: "prompt" as const, text: text.slice(0, 20_000), reply: done.text.slice(0, 8000), stopReason: done.stopReason };
        await h.mutate((docs) => ({ next: { session: { ...docs.session, prompts: [...docs.session.prompts, entry].slice(-20) } } }));
        run.state = ctl.signal.aborted ? "stopped" : "finished";
      }

      // Brief only: refresh notes/brief.md with a setup worker in brief mode, then stop.
      if (proceed && opts.brief) {
        await setSessionState("checking");
        await status("setup worker: refreshing the project brief");
        const done = await this.runJob(h, run, { role: "setup", promptText: setupPrompt(h.session, h.board, [], "brief") }, log, ctl.signal);
        addCost(run, done.costUsd);
        await status(`brief ${(await this.readNote(h, "brief.md", 16_000)) ? "written" : "missing"} (${done.stopReason})`);
        run.state = "finished";
        proceed = false;
      }

      // Planning: one planner worker turns your request into backlog tickets, then the run stops.
      if (proceed && opts.plan !== undefined) {
        proceed = false;
        const request = opts.plan;
        await setSessionState("planning");
        await status(`planner: ${request.trim().split("\n")[0]!.slice(0, 120)}`);
        const done = await this.runJob(h, run, { role: "planner", promptText: await this.withNotes(h, plannerPrompt(h.session, h.board, request)) }, log, ctl.signal);
        addCost(run, done.costUsd);
        await saveRun();
        const backlog = h.board.tickets.filter((t) => t.state === "backlog").length;
        await status(`planner finished (${done.stopReason}); ${backlog} tickets in backlog await your approval`);
        const entry = { at: clock(), runId: run.id, kind: "plan" as const, text: request.slice(0, 20_000), reply: done.text.slice(0, 8000), stopReason: done.stopReason };
        await h.mutate((docs) => ({ next: { session: { ...docs.session, prompts: [...docs.session.prompts, entry].slice(-20) } } }));
        run.state = ctl.signal.aborted ? "stopped" : "finished";
      }

      let lastDenialCheck = clock();
      // With caps.resumeWorker, the implementers of this run share one agent conversation.
      const convo: { id?: string } = {};
      while (proceed && !ctl.isStop()) {
        if (ctl.isPause()) {
          run.state = "paused";
          run.pauseReason = "user";
          break;
        }
        const sizeMb = await workspaceSizeMb(h.paths).catch(() => 0);
        if (sizeMb > h.session.limits.workspaceMb) {
          run.state = "paused";
          run.pauseReason = `workspace is ${sizeMb} MB, over the ${h.session.limits.workspaceMb} MB limit`;
          break;
        }
        if (run.ticketsDone >= h.session.caps.runTickets) {
          run.state = "finished";
          await status(`run ticket cap of ${h.session.caps.runTickets} reached`);
          break;
        }
        if (d.healSandbox) {
          const healed = await d.healSandbox(h.id).catch((e: Error) => [`heal failed: ${e.message}`]);
          for (const line of healed) await status(line);
        }
        const ticket = nextReady(h.board);
        if (!ticket) {
          const open = h.inbox.requests.some((r) => r.state === "open");
          run.state = hasOpenWork(h.board) || open ? "paused" : "finished";
          const blockers = describeBlockers(h.board);
          run.pauseReason = open ? "requests" : hasOpenWork(h.board) ? blockers || "waiting on dependencies" : undefined;
          await status(open ? "nothing ready; waiting for your answers in the inbox" : run.state === "finished" ? "no ready tickets left" : `nothing can run: ${blockers}`);
          break;
        }

        // A ticket that names a repository this session does not have cannot be
        // worked, committed or exported; say so instead of spending a worker.
        if (ticket.repo && !h.session.repos.some((r) => r.name === ticket.repo)) {
          const have = h.session.repos.map((r) => r.name).join(", ") || "none";
          await h.mutate((docs) => ({
            next: {
              board: transition(docs.board, ticket.id, "in_progress", { by: "harness", text: "Checking the ticket's repository" }),
            },
          }));
          await h.mutate((docs) => ({
            next: {
              board: transition(docs.board, ticket.id, "blocked", {
                by: "harness",
                text: `Ticket names repo "${ticket.repo}" but this session has: ${have}. Fix the repo field (edit the ticket, or re-import the board with the right name) and move it back to ready.`,
              }),
            },
          }));
          await log({ kind: "ticket", t: clock(), ticket: ticket.id, from: "ready", to: "blocked", note: `unknown repo "${ticket.repo}" (session has ${have})` });
          continue;
        }

        const outcome = await this.workTicket(h, run, ticket, log, ctl.signal, convo);
        await saveRun();
        if (outcome === "rate_limited") {
          run.state = "paused";
          run.pauseReason = "rate_limit";
          const sleep = d.rateLimitSleepMs ?? 60 * 60_000;
          run.resumeAt = new Date(Date.now() + sleep).toISOString();
          await log({ kind: "run", t: clock(), state: "paused", reason: `rate limited; sleeping until ${run.resumeAt}` });
          await saveRun();
          await setSessionState("paused");
          await waitOrAbort(sleep, ctl.signal);
          if (ctl.isStop()) break;
          run.state = "running";
          run.pauseReason = undefined;
          run.resumeAt = undefined;
          await setSessionState("running");
          continue;
        }
        if (outcome === "halted") {
          run.state = "halted";
          break;
        }
        if (d.proxyDenials) {
          const denials = await d.proxyDenials(h.id, lastDenialCheck).catch(() => []);
          lastDenialCheck = clock();
          for (const den of denials) await log({ kind: "denied_network", t: clock(), host: den.host, port: den.port });
        }
      }
      if (ctl.isStop()) {
        run.state = "stopped";
        // A stopped worker leaves its ticket in progress; put it back.
        if (run.currentTicket) {
          await h.mutate((docs) => {
            const t = getTicket(docs.board, run.currentTicket!);
            return t.state === "in_progress" || t.state === "review"
              ? { next: { board: transition(docs.board, t.id, "ready", { by: "harness", text: "Run stopped by the user; requeued" }) } }
              : {};
          });
        }
      }
    } catch (e) {
      run.state = "failed";
      await log({ kind: "error", t: clock(), text: `run failed: ${(e as Error).message}` });
    } finally {
      run.endedAt = clock();
      run.currentTicket = undefined;
      d.tokens.revokeRun(h.id, run.id);
      await log({ kind: "run", t: clock(), state: run.state, reason: run.pauseReason });
      await saveRun();
      let sessionState: Session["state"] =
        run.state === "halted" ? "halted" : run.state === "finished" ? "finished" : run.pauseReason === "requests" ? "waiting" : "paused";
      // Not initialized: the session is still a plan, or its initialization needs you.
      if (!isInitialized(h.session) && sessionState !== "waiting") sessionState = "setup";
      await setSessionState(sessionState).catch(() => undefined);
    }
    return run;
  }

  /** One ticket, start to finish: the implementer, then the judge. Returns how it ended for the loop's bookkeeping. */
  private async workTicket(
    h: SessionHandle,
    run: Run,
    ticket: Ticket,
    log: (e: VerstasEvent) => Promise<void>,
    signal: AbortSignal,
    convo: { id?: string } = {},
  ): Promise<"done" | "requeued" | "waiting" | "blocked" | "rate_limited" | "halted"> {
    const d = this.deps;
    const clock = d.now ?? now;
    const caps = h.session.caps;

    const answer = latestAnswer(h, ticket.id);
    await h.mutate((docs) => ({ next: { board: transition(docs.board, ticket.id, "in_progress", { by: "harness", text: `Implementer started (judged attempts so far: ${ticket.attempts})` }) } }));
    await log({ kind: "ticket", t: clock(), ticket: ticket.id, from: "ready", to: "in_progress" });
    run.currentTicket = ticket.id;

    const agentSession = caps.resumeWorker ? (convo.id ? { id: convo.id, resume: true } : { id: randomUUID(), resume: false }) : undefined;
    const freshPrompt = () => this.withNotes(h, implementerPrompt(h.board, getTicket(h.board, ticket.id), answer));
    const promptText = agentSession?.resume ? implementerPrompt(h.board, getTicket(h.board, ticket.id), answer, true) : await freshPrompt();
    const impl = await this.runJob(h, run, { role: "implementer", ticket: ticket.id, agentSession, promptText, freshPrompt }, log, signal);
    if (impl.agentSession && impl.turns > 0) convo.id = impl.agentSession;
    addCost(run, impl.costUsd);
    await this.writeTicketReport(h, run, ticket.id, "implementer", impl);

    if (signal.aborted) return "requeued";
    if (impl.rateLimited) {
      // A rate limit is not the ticket's fault and gives no verdict, so it costs no attempt.
      await h.mutate((docs) => ({ next: { board: transition(docs.board, ticket.id, "ready", { by: "harness", text: "Rate limited; requeued" }) } }));
      run.currentTicket = undefined;
      return "rate_limited";
    }

    const parked = await this.parkOnRequests(h, ticket.id, log);
    if (parked) {
      run.currentTicket = undefined;
      return parked;
    }

    const outcome = await this.judge(h, run, ticket.id, impl, log, signal);
    // A stopped run requeues the ticket it was on; anything else is settled.
    if (!signal.aborted) run.currentTicket = undefined;
    return outcome;
  }

  /** A ticket with open requests waits for them (or halts the run); the work so far is committed. */
  private async parkOnRequests(h: SessionHandle, ticketId: string, log: (e: VerstasEvent) => Promise<void>): Promise<"waiting" | "halted" | undefined> {
    const openForTicket = h.inbox.requests.filter((r) => r.state === "open" && r.ticketId === ticketId);
    if (!openForTicket.length) return undefined;
    const halt = openForTicket.find((r) => r.halt);
    const t = getTicket(h.board, ticketId);
    await this.commitInContainer(h, `${t.id} (waiting): ${t.title}`);
    await this.move(h, ticketId, "waiting", halt ? `Halt requested: ${halt.halt?.reason ?? ""}` : `Waiting on ${openForTicket.map((r) => `${r.id} (${r.actions.map((a) => a.detail.kind).join(", ") || "question"})`).join(", ")}`, log);
    return halt ? "halted" : "waiting";
  }

  private async move(h: SessionHandle, ticketId: string, to: TicketState, note: string, log: (e: VerstasEvent) => Promise<void>): Promise<void> {
    const from = getTicket(h.board, ticketId).state;
    await h.mutate((docs) => ({ next: { board: transition(docs.board, ticketId, to, { by: "harness", text: note }) } }));
    await log({ kind: "ticket", t: (this.deps.now ?? now)(), ticket: ticketId, from, to, note });
  }

  /**
   * The verdict on a ticket whose work is finished: the harness's gates and
   * the diff, the reviewer (or the harness's own rule without one), one
   * judged attempt, the commit, and the move out of review to done, back to
   * ready, or to blocked. Only this moves a ticket to done. The work may
   * come from an implementer the loop started or from an agent that
   * submitted it; `impl` says how that worker ended.
   */
  async judge(
    h: SessionHandle,
    run: Run,
    ticketId: string,
    impl: { ok: boolean; stopReason: string; costUsd: number },
    log: (e: VerstasEvent) => Promise<void>,
    signal: AbortSignal,
  ): Promise<"done" | "requeued" | "blocked" | "rate_limited"> {
    const d = this.deps;
    const clock = d.now ?? now;
    const caps = h.session.caps;
    const ticket = getTicket(h.board, ticketId);
    const move = (to: TicketState, note: string) => this.move(h, ticketId, to, note, log);

    // Gates, diff, review.
    const repoDir = ticket.repo && h.session.repos.some((r) => r.name === ticket.repo) ? `/workspace/${ticket.repo}` : h.session.repos[0] ? `/workspace/${h.session.repos[0].name}` : "/workspace";
    const gates = await this.runGates(h.id, repoDir, log, ticketId);
    const { stat, numstat, diff } = await this.stageAndDiff(h.id, repoDir);
    const changed = numstat.files > 0;
    const summary = `Implementer ${impl.ok ? "finished" : `stopped (${impl.stopReason})`}; ${numstat.files} files, +${numstat.added} −${numstat.removed}`;
    if (getTicket(h.board, ticketId).state !== "review") await move("review", summary);
    else await h.mutate((docs) => ({ next: { board: addNote(docs.board, ticketId, "harness", summary) } }));

    // Who decides. With a reviewer: the reviewer, always, including when no
    // files changed (a report or an investigation can be the deliverable).
    // The harness's own gates are guesses (npm test may need a browser the
    // next ticket installs), so they are evidence for the reviewer, never a
    // verdict on their own. Without a reviewer the harness decides from what
    // it can see: the implementer finished, the gates pass, and there is a
    // change or at least a report.
    let verdict: "ok" | "fixable" | "blocked";
    let verdictNote = "";
    if (caps.reviewer) {
      const rev = await this.runJob(h, run, { role: "reviewer", ticket: ticketId, promptText: await this.withNotes(h, reviewerPrompt(getTicket(h.board, ticketId), stat, diff, gates, { ok: impl.ok, stopReason: impl.stopReason })) }, log, signal);
      addCost(run, rev.costUsd);
      await this.writeTicketReport(h, run, ticketId, "reviewer", rev);
      if (rev.rateLimited) {
        // Keep the work; the loop sleeps and the ticket goes back to ready for a fresh review next time.
        await this.commitInContainer(h, `${ticketId} (wip): ${ticket.title}`);
        await move("ready", "Reviewer was rate limited; requeued with the work kept");
        return "rate_limited";
      }
      if (signal.aborted) return "requeued";
      const parsed = parseVerdict(rev.text);
      verdict = parsed?.verdict ?? "fixable";
      verdictNote = parsed?.reason ?? `reviewer gave no verdict (${rev.stopReason})`;
    } else {
      const failed = gates.filter((g) => !g.ok).map((g) => g.name);
      const report = getTicket(h.board, ticketId).report;
      if (!impl.ok) verdictNote = `implementer stopped (${impl.stopReason})`;
      else if (failed.length) verdictNote = `failed: ${failed.join(", ")}`;
      else if (!changed && !report) verdictNote = "no files changed and no report was filed";
      verdict = verdictNote ? "fixable" : "ok";
    }

    // One judged attempt, whatever the verdict.
    const attempts = getTicket(h.board, ticketId).attempts + 1;
    await h.mutate((docs) => ({ next: { board: replaceTicket(docs.board, { ...getTicket(docs.board, ticketId), attempts }) } }));

    if (verdict === "ok") {
      const leaked = await this.commitInContainer(h, `${ticketId}: ${ticket.title}`);
      if (leaked.length) {
        const note = `The Claude token appears in the changes to ${leaked.join(", ")}; nothing was committed there. Remove it from the files (the changes are still in the working tree) and move the ticket back to ready.`;
        await log({ kind: "error", t: clock(), ticket: ticketId, text: note });
        await move("blocked", note);
        return "blocked";
      }
      await h.mutate((docs) => {
        const t = getTicket(docs.board, ticketId);
        return { next: { board: replaceTicket(docs.board, { ...t, diff: numstat, cost: { ...(t.cost ?? { inputTokens: 0, outputTokens: 0 }), usd: (t.cost?.usd ?? 0) + impl.costUsd } }) } };
      });
      await move("done", `${caps.reviewer ? "Reviewed ok" : "Accepted"}${changed ? "" : " (no files changed)"}${verdictNote ? `: ${verdictNote}` : ""}`);
      run.ticketsDone++;
      return "done";
    }
    if (verdict === "fixable" && attempts < caps.ticketAttempts) {
      await this.commitInContainer(h, `${ticketId} (wip attempt ${attempts}): ${ticket.title}`);
      await move("ready", `Not done yet (${verdictNote || "see reviewer notes"}); attempt ${attempts} of ${caps.ticketAttempts}`);
      return "requeued";
    }
    await this.commitInContainer(h, `${ticketId} (blocked): ${ticket.title}`);
    await move("blocked", verdict === "blocked" ? `Reviewer: blocked. ${verdictNote}` : `Gave up after ${attempts} attempts: ${verdictNote || "not accepted"}`);
    return "blocked";
  }

  /**
   * One worker, start to finish. Each job gets its own directory under
   * /workspace/.verstas/jobs (job file, prompt, rules, budget) and its own
   * run token, revoked when the worker ends, so two workers of one run (a
   * lead and the reviewer judging its ticket) never share either.
   */
  private async runJob(
    h: SessionHandle,
    run: Run,
    job: { role: Job["role"]; ticket?: string; promptText: string; agentSession?: Job["agentSession"]; /** The prompt for a fresh conversation when a resume fails. */ freshPrompt?: () => Promise<string> },
    log: (e: VerstasEvent) => Promise<void>,
    signal: AbortSignal,
  ): Promise<WorkerDone> {
    const name = `${run.id}-${++this.jobSeq}-${job.role}`;
    const rel = `${WORKSPACE_FILES}/jobs/${name}`;
    const dir = path.join(h.paths.workspace, rel);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "prompt.md"), job.promptText);
    await fs.writeFile(path.join(dir, "system.md"), systemMd(job.role));
    // The reviewer may be a different agent than the worker (session.agents); everything else about the job is the same.
    const agent = agentFor(h.session, job.role);
    const spec: Job = {
      role: job.role,
      ticket: job.ticket,
      driver: agent.driver,
      promptFile: `/workspace/${rel}/prompt.md`,
      systemPromptFile: `/workspace/${rel}/system.md`,
      caps: { minutes: h.session.caps.workerMinutes, turns: h.session.caps.workerTurns, budgetUsd: h.session.caps.budgetUsd },
      mcpConfigFile: `/workspace/${WORKSPACE_FILES}/mcp.json`,
      model: agent.model || undefined,
      budgetFile: `/workspace/${rel}/budget.json`,
    };
    if (job.agentSession && agent.driver === "claude") spec.agentSession = job.agentSession;
    if (DEBUG) spec.debug = true;
    const jobFile = `/workspace/${rel}/job.json`;
    await fs.writeFile(path.join(dir, "job.json"), JSON.stringify(spec, null, 2));
    const rawLog = DEBUG ? path.join(h.paths.runs, String(run.id), `worker-${name}-${job.ticket ?? "none"}.raw.jsonl`) : undefined;
    const token = this.deps.tokens.issue({ sessionId: h.id, runId: run.id, role: tokenRole(job.role), currentTicket: job.ticket });
    try {
      let done = await this.deps.worker(h.id).run(spec, (e) => void log(e), signal, { rawLog, runToken: token, jobFile });
      // A conversation that cannot be resumed (pruned, written by another CLI
      // version) fails before its first turn; start a fresh one under a new id.
      if (spec.agentSession?.resume && !done.ok && done.turns === 0 && !done.rateLimited && !signal.aborted) {
        await log(done);
        await log({ kind: "status", t: (this.deps.now ?? now)(), ticket: job.ticket, text: `could not resume the agent conversation (${done.stopReason}); starting a fresh one` });
        if (job.freshPrompt) await fs.writeFile(path.join(dir, "prompt.md"), await job.freshPrompt());
        const fresh: Job = { ...spec, agentSession: { id: randomUUID(), resume: false } };
        await fs.writeFile(path.join(dir, "job.json"), JSON.stringify(fresh, null, 2));
        done = await this.deps.worker(h.id).run(fresh, (e) => void log(e), signal, { rawLog, runToken: token, jobFile });
        done = { ...done, agentSession: fresh.agentSession!.id };
      } else if (spec.agentSession) done = { ...done, agentSession: spec.agentSession.id };
      await log(done);
      return done;
    } finally {
      this.deps.tokens.revoke(token);
    }
  }

  /** A file under notes/, capped so a runaway note cannot crowd out the ticket. */
  private async readNote(h: SessionHandle, name: string, cap: number): Promise<string | null> {
    const text = await fs.readFile(path.join(h.paths.notes, name), "utf8").catch(() => "");
    if (!text.trim()) return null;
    return text.length > cap ? text.slice(0, cap) + `\n\n(${name} truncated at ${cap} characters; shorten it)` : text;
  }

  /** The brief and the environment description in front of a worker's task. */
  private async withNotes(h: SessionHandle, prompt: string): Promise<string> {
    return withContext(await this.readNote(h, "brief.md", 16_000), await this.readNote(h, "env.md", 8_000), prompt);
  }

  private async writeWorkspaceFiles(h: SessionHandle): Promise<void> {
    const ws = h.paths.workspace;
    // Job directories of earlier runs; no worker of this session is running now.
    await fs.rm(path.join(ws, WORKSPACE_FILES, "jobs"), { recursive: true, force: true });
    await fs.writeFile(path.join(ws, "VERSTAS.md"), verstasMd(h.session, this.deps.agentApiUrl));
    await fs.writeFile(path.join(ws, "CLAUDE.md"), workspaceClaudeMd());
    // Codex and Cursor read AGENTS.md where Claude Code reads CLAUDE.md; same pointers.
    await fs.writeFile(path.join(ws, "AGENTS.md"), workspaceClaudeMd());
    await fs.mkdir(path.join(ws, WORKSPACE_FILES, "logs"), { recursive: true });
    await fs.writeFile(path.join(ws, WORKSPACE_FILES, "mcp.json"), JSON.stringify(mcpConfig(), null, 2));
    // No project-level .cursor/mcp.json: Cursor would demand an interactive approval for it and it would shadow the
    // user-level file the Cursor driver writes for the run (src/worker/driver-cursor.ts). Remove one left by earlier versions.
    await fs.rm(path.join(ws, ".cursor", "mcp.json"), { force: true });
    await fs.mkdir(h.paths.notes, { recursive: true });
    const index = path.join(h.paths.notes, "INDEX.md");
    await fs.access(index).catch(() => fs.writeFile(index, notesIndexMd()));
    const learnings = path.join(h.paths.notes, "learnings.md");
    await fs.access(learnings).catch(() => fs.writeFile(learnings, "# Learnings\n\n"));
  }

  private async writeTicketReport(h: SessionHandle, run: Run, ticketId: string, role: string, done: WorkerDone): Promise<void> {
    const file = path.join(h.paths.runs, String(run.id), "tickets", `${ticketId}.md`);
    const t = getTicket(h.board, ticketId);
    const block = `\n## ${role} · ${done.t} · ${done.stopReason} · ${done.turns} turns · ${done.seconds}s · $${done.costUsd.toFixed(2)}\n\n${role === "implementer" ? (t.report ?? "(no report)") : done.text}\n`;
    await fs.appendFile(file, block);
  }

  /** Gates are whatever the repository itself offers: npm scripts and pytest. */
  private async runGates(sessionId: string, repoDir: string, log: (e: VerstasEvent) => Promise<void>, ticketId: string): Promise<{ name: string; ok: boolean; summary: string }[]> {
    const clock = this.deps.now ?? now;
    const sh = this.deps.shell(sessionId);
    const results: { name: string; ok: boolean; summary: string }[] = [];
    const pkg = await sh.exec(["cat", "package.json"], { workdir: repoDir, timeoutMs: 10_000 });
    const scripts = pkg.code === 0 ? safeScripts(pkg.stdout) : {};
    const candidates: [string, string[]][] = [];
    if (Object.keys(scripts).length) {
      const installed = await sh.exec(["test", "-d", "node_modules"], { workdir: repoDir, timeoutMs: 10_000 });
      if (installed.code !== 0) {
        const summary = "skipped: node_modules is missing, the implementer did not install dependencies";
        results.push({ name: "npm scripts", ok: true, summary });
        await log({ kind: "gate", t: clock(), ticket: ticketId, name: "npm scripts", ok: true, summary });
      } else {
        for (const name of ["typecheck", "lint", "test"]) if (scripts[name]) candidates.push([`npm run ${name}`, ["npm", "run", "--silent", name]]);
      }
    }
    const py = await sh.exec(["sh", "-c", "test -f pyproject.toml -o -f pytest.ini -o -d tests && command -v pytest >/dev/null && echo yes"], { workdir: repoDir, timeoutMs: 10_000 });
    if (py.stdout.trim() === "yes" && !scripts.test) candidates.push(["pytest", ["python3", "-m", "pytest", "-q"]]);
    for (const [name, cmd] of candidates) {
      const r = await sh.exec(cmd, { workdir: repoDir, timeoutMs: 15 * 60_000 });
      const out = (r.stdout + "\n" + r.stderr).trim();
      // 127 is "command not found": the repository's tool is not installed in the box; that is a skip, not a failure.
      const missing = r.code === 127 || /: not found$/m.test(out);
      const ok = r.code === 0 || missing;
      const summary = (missing ? "skipped: tool not installed in the sandbox: " : "") + out.slice(-300).replace(/\s+/g, " ");
      results.push({ name, ok, summary });
      await log({ kind: "gate", t: clock(), ticket: ticketId, name, ok, summary });
    }
    return results;
  }

  private async stageAndDiff(sessionId: string, repoDir: string): Promise<{ stat: string; numstat: { added: number; removed: number; files: number }; diff: string }> {
    const sh = this.deps.shell(sessionId);
    await sh.exec(["git", "add", "-A"], { workdir: repoDir, timeoutMs: 60_000 });
    const stat = await sh.exec(["git", "diff", "--cached", "--stat"], { workdir: repoDir, timeoutMs: 60_000 });
    const num = await sh.exec(["git", "diff", "--cached", "--numstat"], { workdir: repoDir, timeoutMs: 60_000 });
    const diff = await sh.exec(["git", "diff", "--cached"], { workdir: repoDir, timeoutMs: 60_000 });
    let added = 0;
    let removed = 0;
    let files = 0;
    for (const line of num.stdout.split("\n")) {
      const [a, r] = line.split("\t");
      if (a === undefined || r === undefined) continue;
      files++;
      added += Number(a) || 0;
      removed += Number(r) || 0;
    }
    return { stat: stat.stdout.trim(), numstat: { added, removed, files }, diff: diff.stdout };
  }

  /**
   * Commits every change in every repo of the session, inside the container
   * (docs/SANDBOX.md Boundary 5). A repo whose staged diff contains a secret
   * is not committed: its changes are unstaged and stay in the working tree,
   * and the repo name is returned so the caller can refuse the ticket.
   */
  private async commitInContainer(h: SessionHandle, message: string): Promise<string[]> {
    const sh = this.deps.shell(h.id);
    const secrets = ((await this.deps.secrets?.().catch(() => [])) ?? []).filter((x) => x.length >= 16);
    const leaked: string[] = [];
    for (const repo of h.session.repos) {
      const dir = `/workspace/${repo.name}`;
      await sh.exec(["git", "add", "-A"], { workdir: dir, timeoutMs: 60_000 });
      const staged = await sh.exec(["git", "diff", "--cached", "--quiet"], { workdir: dir, timeoutMs: 60_000 });
      if (staged.code === 0) continue; // nothing to commit here
      if (secrets.length) {
        // Searched on the host: the secret never goes into a command line in the box.
        const diff = await sh.exec(["git", "diff", "--cached", "--no-color", "--text"], { workdir: dir, timeoutMs: 120_000 });
        if (secrets.some((sec) => diff.stdout.includes(sec) || diff.stdout.includes(sec.slice(0, 40)))) {
          await sh.exec(["git", "reset", "-q"], { workdir: dir, timeoutMs: 60_000 });
          leaked.push(repo.name);
          continue;
        }
      }
      await sh.exec(["git", "-c", "core.hooksPath=/dev/null", "commit", "-q", "--no-verify", "-m", message], { workdir: dir, timeoutMs: 60_000 });
    }
    return leaked;
  }
}

// --- helpers -----------------------------------------------------------------

const addCost = (run: Run, usd: number) => {
  run.cost = { ...run.cost, usd: (run.cost.usd ?? 0) + usd };
};

const lastRunFile = async (runsDir: string): Promise<{ file: string; run: Run } | null> => {
  const id = ((await nextRunId(runsDir)) ?? 1) - 1;
  if (id < 1) return null;
  const file = path.join(runsDir, String(id), "run.json");
  try {
    return { file, run: runSchema.parse(JSON.parse(await fs.readFile(file, "utf8"))) };
  } catch {
    return null;
  }
};

const nextRunId = async (runsDir: string): Promise<number | undefined> => {
  try {
    const entries = await fs.readdir(runsDir);
    const max = entries.map(Number).filter((n) => Number.isInteger(n) && n > 0).reduce((m, n) => Math.max(m, n), 0);
    return max + 1;
  } catch {
    return undefined;
  }
};

/** "T-2, T-3 and 7 more wait on T-1 (blocked)" — why nothing is ready. */
export const describeBlockers = (board: Board): string => {
  const waiting = board.tickets.filter((t) => t.state === "ready" && t.deps.some((d) => !board.tickets.some((x) => x.id === d && x.state === "done")));
  if (!waiting.length) return "";
  const byDep = new Map<string, string[]>();
  for (const t of waiting) {
    for (const d of t.deps) {
      const dep = board.tickets.find((x) => x.id === d);
      if (dep?.state === "done") continue;
      const key = dep ? `${dep.id} (${dep.state})` : `${d} (missing)`;
      byDep.set(key, [...(byDep.get(key) ?? []), t.id]);
    }
  }
  return [...byDep.entries()]
    .map(([dep, ids]) => `${ids.length > 3 ? `${ids.slice(0, 3).join(", ")} and ${ids.length - 3} more` : ids.join(", ")} wait on ${dep}`)
    .join("; ");
};

/** The most recent resolved request on this ticket, as the outcome block for the next worker. */
const latestAnswer = (h: SessionHandle, ticketId: string): string | undefined => {
  const decided = h.inbox.requests.filter((r) => r.ticketId === ticketId && r.state !== "open").sort((a, b) => (b.decidedAt ?? "").localeCompare(a.decidedAt ?? ""));
  const r = decided[0];
  return r ? requestOutcome(r) : undefined;
};

/** "SETUP: ready|needs", then "- [x] requirement (how)" lines, then a summary. */
export const parseSetup = (text: string): { ready: boolean; checks: { text: string; ok: boolean }[]; summary: string } | null => {
  const m = /SETUP:\s*(ready|needs)\b/i.exec(text);
  if (!m) return null;
  const rest = text.slice((m.index ?? 0) + m[0].length).split("\n").map((l) => l.trim()).filter(Boolean);
  const checks: { text: string; ok: boolean }[] = [];
  const other: string[] = [];
  for (const l of rest) {
    const c = /^[-*]\s*\[([ xX])\]\s*(.+)$/.exec(l);
    if (c) checks.push({ ok: c[1] !== " ", text: c[2]!.slice(0, 1000) });
    else other.push(l);
  }
  return { ready: m[1]!.toLowerCase() === "ready", checks: checks.slice(0, 60), summary: other.slice(0, 12).join(" ").slice(0, 2000) };
};

export const parseVerdict = (text: string): { verdict: "ok" | "fixable" | "blocked"; reason: string } | null => {
  const m = /VERDICT:\s*(ok|fixable|blocked)\b/i.exec(text);
  if (!m) return null;
  const reason = text.slice((m.index ?? 0) + m[0].length).trim().split("\n").filter(Boolean).slice(0, 6).join(" ").slice(0, 1000);
  return { verdict: m[1]!.toLowerCase() as "ok" | "fixable" | "blocked", reason };
};

const safeScripts = (pkgJson: string): Record<string, string> => {
  try {
    const s = (JSON.parse(pkgJson) as { scripts?: Record<string, string> }).scripts;
    return s && typeof s === "object" ? s : {};
  } catch {
    return {};
  }
};

const waitOrAbort = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });

/** Parses a worker's stdout stream (JSON lines) into events; used by the Docker runner and tests. */
export const parseWorkerLine = (line: string): VerstasEvent | null => {
  if (!line.trim()) return null;
  try {
    const parsed = eventSchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/** A driver handing back a credential its agent rotated (Codex's auth file). Never an event: it is stored, not logged. */
export type CredentialLine = { kind: "credential"; driver: DriverName; value: string };

export const parseCredentialLine = (line: string): CredentialLine | null => {
  if (!line.includes('"credential"')) return null;
  try {
    const j = JSON.parse(line) as Partial<CredentialLine>;
    if (j.kind === "credential" && typeof j.value === "string" && j.value && typeof j.driver === "string" && (DRIVER_NAMES as readonly string[]).includes(j.driver)) return j as CredentialLine;
  } catch {
    // not JSON
  }
  return null;
};

export const readWorkerStream = async (
  stdout: NodeJS.ReadableStream,
  onEvent: (e: VerstasEvent) => void,
  opts: { onCredential?: (c: CredentialLine) => Promise<void> | void; /** Every other line, for the raw debug log; credential lines never reach it. */ onRaw?: (line: string) => void } = {},
): Promise<WorkerDone | undefined> => {
  let done: WorkerDone | undefined;
  const rl = readline.createInterface({ input: stdout, crlfDelay: Infinity });
  for await (const line of rl) {
    const cred = parseCredentialLine(line);
    if (cred) {
      await opts.onCredential?.(cred);
      continue;
    }
    // A malformed credential line is dropped without a trace: it may still hold a secret.
    if (/"kind"\s*:\s*"credential"/.test(line)) continue;
    opts.onRaw?.(line);
    const e = parseWorkerLine(line);
    if (!e) continue;
    if (e.kind === "worker_done") done = e;
    else onEvent(e);
  }
  return done;
};

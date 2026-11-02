import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { agentFor, DRIVER_NAMES, eventSchema, isInitialized, now, requestOutcome, runSchema, type TouchedRepo, type Board, type DriverName, type Run, type Session, type TicketState, type VerstasEvent } from "../core/types.js";
import { addNote, getTicket, hasOpenWork, replaceTicket, transition } from "../board/board.js";
import { classifyCommits, plannedVsTouched, reviewLevel, type RepoChange } from "./judging.js";
import { writeJsonAtomic } from "../board/store.js";
import type { SessionHandle, SessionHub } from "../sessions/hub.js";
import type { AgentRunHooks, RunToken, RunTokens } from "../agent-api/agent-api.js";
import { workspaceSizeMb } from "../sessions/sessions.js";
import { addArtifact, ARTIFACT_MAX_BYTES, type Artifact } from "../sessions/artifacts.js";
import { allowlistFor } from "../network/packs.js";
import { leadContinuePrompt, leadPrompt, mcpConfig, readLeadRules, reviewerPrompt, systemMd, terminalMd, userPrompt, verstasMd, workspaceClaudeMd, type LeadPromptOptions } from "./prompts.js";
import { driverInfo, missingCredentialError } from "./drivers.js";
import { LiveTerminal, type TerminalRunner } from "./terminal.js";
import type { Job } from "../worker/worker.js";
import type { TerminalJob } from "../worker/terminal.js";

/**
 * The loop. Deterministic TypeScript that keeps one lead alive: starts it,
 * resumes or replaces it, judges the tickets it submits, commits what it
 * leaves, and stops when it says it is done. Models only ever run as
 * workers, and the harness runs no checks of its own: the reviewer runs
 * the repositories' checks (docs/BOARD.md, "Judging"). Everything that
 * touches Docker is behind two small interfaces so the loop is unit-tested
 * with fakes.
 */

export type WorkerDone = Extract<VerstasEvent, { kind: "worker_done" }>;

export type ShellResult = { code: number; stdout: string; stderr: string };

/** Runs commands inside the session container as the agent user. */
export interface Shell {
  exec(cmd: readonly string[], opts?: { workdir?: string; timeoutMs?: number; input?: string }): Promise<ShellResult>;
}

/** Runs one worker job inside the container; streams events; resolves with the final line. */
/** A running worker, as far as the harness can reach it: a message from the user down its stdin. */
export type WorkerHandle = {
  driver: DriverName;
  /** Writes the message (from the user unless said otherwise); false when the worker is gone. */
  send(text: string, from?: "user" | "verstas"): boolean;
};

export interface WorkerRunner {
  run(
    job: Job,
    onEvent: (e: VerstasEvent) => void,
    signal: AbortSignal,
    opts?: { rawLog?: string; runToken?: string; /** The job file inside the container; it also tells this worker's processes from others'. */ jobFile?: string; /** Called once the worker runs, with the handle to reach it. */ attach?: (h: WorkerHandle) => void },
  ): Promise<WorkerDone>;
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
  /** Agent terminals (src/harness/terminal.ts); without it they are refused. */
  terminal?: (sessionId: string) => TerminalRunner;
  /** Copies a file out of the session container to a new host file (as the agent; the path resolves in the box); resolves with its size. Artifacts need it. */
  copyOut?: (sessionId: string, boxPath: string, hostFile: string, maxBytes: number) => Promise<number>;
  /** Whether a driver has a credential, so a terminal on one without fails before anything starts. */
  hasCredential?: (driver: DriverName) => Promise<boolean>;
  /** For tests: a fixed clock. */
  now?: () => string;
  /** For tests: how long to sleep on a rate limit (ms). */
  rateLimitSleepMs?: number;
  /** How long a lead that asked to hand off may take to stop before it is stopped (ms). */
  handoffGraceMs?: number;
  /** For tests: how long one minute of `caps.progressMinutes` is (ms). */
  progressMinuteMs?: number;
};

/** What the hooks a lead calls through the agent API share with the run that started it. */
type LeadContext = {
  runId: number;
  h: SessionHandle;
  run: Run;
  log: (e: VerstasEvent) => Promise<void>;
  signal: AbortSignal;
  isPause: () => boolean;
  /** Judging and parking, one at a time, in the order the lead asked. */
  queue: Promise<void>;
  handoff?: string;
  /** The lead's assessment that the goal is met and the board finished (the `done` hook). */
  done?: string;
  rateLimited: boolean;
  halted: boolean;
  /** Stops the current lead only (a handoff it does not follow), not the run. */
  leadAbort?: AbortController;
};

export type RunOptions = {
  /** Initialize the environment; see `RunManager.start`. */
  init?: boolean;
  /** With init: go on to the lead once initialization succeeds. */
  start?: boolean;
  /** Ask the box: one worker with your text, no ticket. */
  prompt?: string;
  /** An agent terminal on this driver, at this size: you type to the agent until it exits or the run is stopped. */
  terminal?: { driver: DriverName; cols?: number; rows?: number };
};

export type RunControl = {
  run: Run;
  pauseAfterTicket: () => void;
  stopNow: () => void;
  done: Promise<Run>;
};

const WORKSPACE_FILES = ".verstas";
/** What the lead is told when you press pause while it runs. */
const PAUSE_NUDGE = "The user asked the run to pause. Reach a sensible point (start no new ticket), bring notes/state.md up to date, then reply with one line and stop. The harness commits what you leave.";
/** What the lead is told every `caps.progressMinutes`: the user wants to know where the work stands. */
const PROGRESS_NUDGE = "Progress check. Post a short update for the user with the `message` tool, 2 to 8 sentences: how far the work is, what is done since your last update, what you are on now, and what comes next. Then carry on; this does not end your turn.";
/** Commits per repository in a fresh lead's prompt. */
const LOG_LINES = 15;

/** What a worker of this role may do through the agent API (src/agent-api/agent-api.ts). */
const tokenRole = (role: Job["role"]): "worker" | "lead" => (role === "lead" ? "lead" : "worker");

export class RunManager implements AgentRunHooks {
  private active = new Map<string, RunControl>();
  private leads = new Map<string, LeadContext>();
  /** The worker running in each session right now, for messages from the user. */
  private workers = new Map<string, WorkerHandle & { role: Job["role"]; ticket?: string; log: (e: VerstasEvent) => Promise<void> }>();
  /** The agent terminal of a session whose active run is one. */
  private terminals = new Map<string, LiveTerminal>();
  /** Numbers each worker's job directory. */
  private jobSeq = 0;
  constructor(private readonly deps: RunDeps) {}

  status(sessionId: string): Run | undefined {
    return this.active.get(sessionId)?.run;
  }

  /**
   * A message from the user to the worker running now: it arrives as a
   * user message in the agent's conversation, prefixed so the agent knows
   * who speaks, and starts a turn if the agent was waiting. Logged as a
   * status event of the run; nothing on the board changes. Only a driver
   * with streaming input (Claude Code) can take one.
   */
  async message(sessionId: string, text: string): Promise<{ ok: true; to: string } | { ok: false; error: string }> {
    if (!this.active.has(sessionId)) return { ok: false, error: "No run is active" };
    const w = this.workers.get(sessionId);
    if (!w) return { ok: false, error: "No worker is running right now (the run is between workers); try again in a moment" };
    if (w.driver !== "claude") return { ok: false, error: `The ${w.role} runs on ${w.driver}, which cannot take a message mid-run` };
    const to = `${w.role}${w.ticket ? ` on ${w.ticket}` : ""}`;
    if (!w.send(text.trim())) return { ok: false, error: `The ${to} just ended; the next worker will not see this` };
    await w.log({ kind: "status", t: (this.deps.now ?? now)(), ticket: w.ticket, text: `message from the user to the ${to}: ${text.trim().slice(0, 500)}` });
    return { ok: true, to };
  }

  /** The session's agent terminal while its run is active; pages attach to it (src/server.ts). */
  terminal(sessionId: string): LiveTerminal | undefined {
    return this.terminals.get(sessionId);
  }

  /**
   * Starting anything else ends an agent terminal: stop its run and wait
   * until its changes are committed. A no-op when the active run is not a
   * terminal; false when it did not end in time.
   */
  async endTerminal(sessionId: string, timeoutMs = 30_000): Promise<boolean> {
    const c = this.active.get(sessionId);
    if (!c?.run.terminal) return true;
    c.stopNow();
    return Promise.race([c.done.then(() => true, () => true), new Promise<boolean>((r) => setTimeout(() => r(false), timeoutMs).unref())]);
  }

  /**
   * init: initialize the environment (the clones, the container and the
   * recipes); with `start`, go on to the lead when it succeeds. prompt: run
   * one worker with your text, no ticket, and stop. Without either this is
   * a work run: one lead on the goal and the board, which needs one of them
   * to exist. Everything but init is refused while the session is not
   * initialized: there is no environment to run in.
   */
  async start(sessionId: string, opts: RunOptions = {}): Promise<RunControl> {
    if (this.active.has(sessionId)) throw new Error("A run is already active for this session");
    const h = await this.deps.hub.get(sessionId);
    if (opts.prompt !== undefined && !opts.prompt.trim()) throw new Error("The prompt is empty");
    if (!opts.init && !isInitialized(h.session)) throw new Error("This session is not initialized: press Initialize on the session page first.");
    // A work run has nothing to do without a goal or tickets.
    const works = (opts.init && opts.start) || (!opts.init && opts.prompt === undefined && !opts.terminal);
    if (works && !h.session.goal.trim() && !h.board.tickets.length) throw new Error("Nothing to work on: write a goal or add tickets to the board first.");
    if (opts.terminal) {
      if (!this.deps.terminal) throw new Error("Agent terminals need the Docker sandbox");
      if (opts.terminal.driver === "cursor") throw new Error("Agent terminals run Claude Code or Codex");
      if (this.deps.hasCredential && !(await this.deps.hasCredential(opts.terminal.driver))) throw missingCredentialError(opts.terminal.driver, "the agent terminal runs on it");
      // The terminal's agent needs its backend on the allowlist, like a session agent does.
      const pack = driverInfo(opts.terminal.driver).pack;
      if (!h.session.packs.includes(pack)) {
        await h.mutate((docs) => {
          const packs = [...docs.session.packs, pack];
          return { next: { session: { ...docs.session, packs, allowlist: [...new Set([...docs.session.allowlist, ...allowlistFor(packs)])] } } };
        });
      }
    }
    const id = (await nextRunId(h.paths.runs)) ?? 1;
    const run: Run = runSchema.parse({ id, sessionId, startedAt: (this.deps.now ?? now)(), state: "running", terminal: opts.terminal ? { driver: opts.terminal.driver } : undefined });
    // Exists before the box is up, so the page can attach and watch it start.
    if (opts.terminal) {
      const live = new LiveTerminal(id, opts.terminal.driver, opts.terminal);
      live.status(`Starting the box for ${driverInfo(opts.terminal.driver).title}…`);
      this.terminals.set(sessionId, live);
    }
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
    control.done = this.loop(h, run, opts, { isPause: () => pauseRequested, isStop: () => stopRequested, signal: abort.signal }).finally(() => {
      this.active.delete(sessionId);
      const t = this.terminals.get(sessionId);
      if (t?.runId === id) {
        // A terminal that never got going (the box failed to start, say) still tells its page it is over.
        t.end(null, run.state === "stopped");
        this.terminals.delete(sessionId);
      }
    });
    this.active.set(sessionId, control);
    return control;
  }

  pauseAfterTicket(sessionId: string): boolean {
    const c = this.active.get(sessionId);
    if (!c) return false;
    c.pauseAfterTicket();
    // The lead is told now, when it can take a message; a move into in_progress is refused from here on too.
    const w = this.workers.get(sessionId);
    if (w?.role === "lead" && w.driver === "claude" && w.send(PAUSE_NUDGE, "verstas")) void w.log({ kind: "status", t: (this.deps.now ?? now)(), text: "pause: the lead was asked to reach a sensible point, update its note and stop" }).catch(() => undefined);
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

  // --- What a lead's agent API calls do (AgentRunHooks) ----------------------

  private leadFor(r: RunToken): LeadContext | undefined {
    const c = this.leads.get(r.sessionId);
    return c && c.runId === r.runId ? c : undefined;
  }

  /** Judge the submitted ticket while the lead waits for the verdict. */
  submitted(r: RunToken, ticketId: string): void {
    const c = this.leadFor(r);
    if (!c) {
      // The lead's run ended while the submit was in flight: nothing will judge it, so put it back.
      void this.deps.hub
        .get(r.sessionId)
        .then((h) => h.mutate((docs) => (getTicket(docs.board, ticketId).state === "review" ? { next: { board: transition(docs.board, ticketId, "ready", { by: "harness", text: "Submitted after the run ended; requeued with the work kept" }) } } : {})))
        .catch(() => undefined);
      return;
    }
    c.queue = c.queue.then(async () => {
      c.run.currentTicket = ticketId;
      try {
        const out = await this.judge(c.h, c.run, ticketId, c.log, c.signal);
        if (out === "rate_limited") c.rateLimited = true;
      } catch (e) {
        await c.log({ kind: "error", t: (this.deps.now ?? now)(), ticket: ticketId, text: `judging failed: ${(e as Error).message}` });
        // Never leave it in review: the lead waits on that.
        await c.h.mutate((docs) => (getTicket(docs.board, ticketId).state === "review" ? { next: { board: transition(docs.board, ticketId, "ready", { by: "harness", text: `Judging failed (${(e as Error).message.slice(0, 200)}); requeued with the work kept` }) } } : {})).catch(() => undefined);
      } finally {
        if (!c.signal.aborted) c.run.currentTicket = undefined;
      }
    }).catch(() => undefined);
  }

  /** Park the held ticket on its request so the lead can move on. */
  requested(r: RunToken, ticketId: string): void {
    const c = this.leadFor(r);
    if (!c) return;
    c.queue = c.queue.then(async () => {
      if (getTicket(c.h.board, ticketId).state !== "in_progress") return;
      const parked = await this.parkOnRequests(c.h, ticketId, c.log);
      if (parked === "halted") c.halted = true;
    })
      .catch((e: Error) => c.log({ kind: "error", t: (this.deps.now ?? now)(), ticket: ticketId, text: `parking failed: ${e.message}` }))
      .catch(() => undefined);
  }

  /** The lead says the goal is met and the board is finished. Its life ends (after a grace period, by force) and the loop records the claim. */
  done(r: RunToken, note: string): void {
    const c = this.leadFor(r);
    if (!c) return;
    c.done = note;
    const worker = c.leadAbort;
    setTimeout(() => worker?.abort(), this.deps.handoffGraceMs ?? 120_000).unref();
  }

  /** End this lead; the loop starts a fresh one with the note. */
  handoff(r: RunToken, note: string): void {
    const c = this.leadFor(r);
    if (!c) return;
    c.handoff = note;
    const lead = c.leadAbort;
    setTimeout(() => lead?.abort(), this.deps.handoffGraceMs ?? 120_000).unref();
  }

  /** Why the lead may not start another ticket now. */
  moveRefusal(r: RunToken): string | undefined {
    const c = this.leadFor(r);
    if (!c) return "This run has ended; stop.";
    if (c.handoff) return "You handed off; stop now and reply with one line.";
    if (c.halted) return "The run halts after you finish; stop now and reply with what you found.";
    if (c.rateLimited) return "The reviewer is rate limited: stop now and reply with one line. The run sleeps and a lead continues afterwards.";
    if (c.isPause()) return "The user asked the run to pause: start no new ticket. Reach a sensible point, bring notes/state.md up to date, then reply with one line and stop.";
    return undefined;
  }

  /** Each repository's HEAD now: the baseline a ticket's review reads from (docs/BOARD.md, Judging). */
  async baseline(sessionId: string): Promise<Record<string, string>> {
    const h = await this.deps.hub.get(sessionId);
    const sh = this.deps.shell(sessionId);
    const out: Record<string, string> = {};
    for (const repo of h.session.repos) {
      const r = await sh.exec(["git", "rev-parse", "HEAD"], { workdir: `/workspace/${repo.name}`, timeoutMs: 30_000 }).catch(() => null);
      const sha = r?.code === 0 ? r.stdout.trim() : "";
      if (/^[0-9a-f]{7,64}$/.test(sha)) out[repo.name] = sha;
    }
    return out;
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
    const busy = h.session.state === "running";
    const last = await lastRunFile(h.paths.runs);
    const runLeftOpen = last?.run.state === "running";
    if (!held.length && !busy && !runLeftOpen) return [];
    const did: string[] = [];
    const killed = await d.shell(sessionId).exec(["pkill", "-TERM", "-f", "/opt/verstas/worker.js"], { timeoutMs: 15_000 }).catch(() => null);
    if (killed?.code === 0) did.push("stopped a worker left running in the container");
    // An agent terminal nobody can type to any more (its page connection lived in the dead process).
    const hungUp = await d.shell(sessionId).exec(["pkill", "-HUP", "-f", "/opt/verstas/terminal.js"], { timeoutMs: 15_000 }).catch(() => null);
    if (hungUp?.code === 0) did.push("ended an agent terminal left running in the container");
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
    // An agent terminal moves no ticket: when it ends, the session reads as it did before it.
    const stateBefore = h.session.state;

    try {
      await log({ kind: "run", t: clock(), state: "running" });
      await setSessionState("running");
      await saveRun();

      // One env file per session: the container is created once and keeps its
      // environment, so only session-stable values go in it. Each worker's
      // run token is passed on its exec instead (see docker-worker.ts).
      const envFile = path.join(h.paths.dir, "sandbox.env");
      // A terminal needs only its own agent's credential, checked when it started.
      await d.ensureSandbox(h.session, envFile, !opts.terminal);
      await this.writeWorkspaceFiles(h);

      let proceed = true;

      // An agent terminal: you type to the agent until it exits or the run is stopped; then its changes are committed.
      if (opts.terminal) {
        proceed = false;
        await this.runTerminal(h, run, opts.terminal, log, ctl.signal);
      }

      // Initialization: the clones were made by the caller, the container and
      // the recipes are up (ensureSandbox above). That is the environment; the
      // lead installs what it needs as it goes. With `start`, the lead follows.
      if (opts.init) {
        proceed = false;
        await h.mutate((docs) => ({ next: { session: { ...docs.session, initializedAt: docs.session.initializedAt ?? clock() } } }));
        await status("init: container up; the session is initialized");
        await this.snapshot(h, status);
        run.state = "finished";
        if (opts.start) {
          proceed = true;
          await setSessionState("running");
        }
      }

      // Your prompt: one worker, your text, no ticket. Any repository change
      // becomes one commit; the reply is kept on the session.
      if (opts.prompt !== undefined) {
        proceed = false;
        const text = opts.prompt;
        await status(`prompt: ${text.trim().split("\n")[0]!.slice(0, 120)}`);
        const done = await this.runJob(h, run, { role: "prompt", promptText: userPrompt(text) }, log, ctl.signal);
        addCost(run, done.costUsd);
        const leaked = await this.commitInContainer(h, `Prompt: ${text.trim().split("\n")[0]!.slice(0, 72)}`);
        if (leaked.length) await log({ kind: "error", t: clock(), text: `The Claude token appears in the changes to ${leaked.join(", ")}; nothing was committed there. Remove it from the files.` });
        const entry = { at: clock(), runId: run.id, kind: "prompt" as const, text: text.slice(0, 20_000), reply: done.text.slice(0, 8000), stopReason: done.stopReason };
        await h.mutate((docs) => ({ next: { session: { ...docs.session, prompts: [...docs.session.prompts, entry].slice(-20) } } }));
        run.state = ctl.signal.aborted ? "stopped" : "finished";
      }

      // The work run: one lead on the goal and the board. The box is
      // committed to an image afterwards: the record of what the lead installed.
      if (proceed) {
        await this.leadLoop(h, run, ctl, log, saveRun, setSessionState);
        await this.snapshot(h, status);
      }
      if (ctl.isStop()) {
        run.state = "stopped";
        // A stopped lead leaves its tickets in progress; put every one back, with the work kept.
        const held = h.board.tickets.filter((t) => t.state === "in_progress" || t.state === "review").map((t) => t.id);
        for (const id of held) {
          await h.mutate((docs) => {
            const t = getTicket(docs.board, id);
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
      // Not initialized: the session is still a plan.
      if (!isInitialized(h.session) && sessionState !== "waiting") sessionState = "setup";
      if (opts.terminal && run.state !== "failed" && stateBefore !== "running") sessionState = stateBefore;
      await setSessionState(sessionState).catch(() => undefined);
    }
    return run;
  }

  /**
   * The one loop: keep one lead working the session (the goal, the board,
   * or both) until nothing it can start is left. The lead moves tickets
   * through the agent API; the hooks above judge a ticket it moves to
   * review and park one it files a request on. When a lead life ends, the
   * harness commits whatever is left uncommitted, then the next life
   * continues the conversation, or starts fresh from the handoff note (or
   * from the last words when the lead hit a cap). The run ends when the
   * lead says `done` and no ticket is ready, when you pause, when a request
   * waits on you and nothing else can go on, when two lives in a row change
   * nothing, or at the session's cap on lives per run. The goal text is
   * read again every life, so an edit lands in the next one (a running
   * Claude lead is told in its conversation).
   */
  private async leadLoop(
    h: SessionHandle,
    run: Run,
    ctl: { isPause: () => boolean; isStop: () => boolean; signal: AbortSignal },
    log: (e: VerstasEvent) => Promise<void>,
    saveRun: () => Promise<void>,
    setSessionState: (state: Session["state"]) => Promise<unknown>,
  ): Promise<void> {
    const d = this.deps;
    const clock = d.now ?? now;
    const status = (text: string, ticket?: string) => log({ kind: "status", t: clock(), ticket, text });
    const firstLine = (text: string) => (text.trim().split("\n").find((l) => l.trim()) ?? "").trim();
    const ctx: LeadContext = { runId: run.id, h, run, log, signal: ctl.signal, isPause: ctl.isPause, queue: Promise.resolve(), rateLimited: false, halted: false };
    this.leads.set(h.id, ctx);
    let convoId: string | undefined;
    let handoffNote = (await this.readNote(h, "state.md", 16_000)) ?? undefined;
    /** A lead stopped at a cap before it could update its note: its last words go into the next fresh prompt. */
    let lastWords: string | undefined;
    let round = 0;
    let idle = 0;
    let lastCommitted: string[] = [];
    /** The goal the previous life was given; a different text now means it was revised meanwhile. */
    let lastGoal: string | undefined;
    let lastDenialCheck = clock();
    const inProgress = () => h.board.tickets.filter((t) => t.state === "in_progress");
    const ready = () => h.board.tickets.filter((t) => t.state === "ready");
    const fingerprint = () => JSON.stringify([h.board.tickets.map((t) => [t.id, t.state]), h.inbox.requests.length, h.inbox.messages.length]);
    // A continuing conversation hears only outcomes decided since its last life; a fresh lead, which remembers nothing, gets the recent ones.
    const answersSeen = new Set(h.inbox.requests.filter((r) => r.state !== "open").map((r) => r.id));
    const newAnswers = (): string[] => {
      const fresh = h.inbox.requests.filter((r) => r.state !== "open" && !answersSeen.has(r.id));
      for (const r of fresh) answersSeen.add(r.id);
      return fresh.map(requestOutcome);
    };
    const recentAnswers = (): string[] => h.inbox.requests.filter((r) => r.state !== "open").slice(-5).map(requestOutcome);
    const progressTimer = this.progressChecks(h, ctl.signal, log);
    try {
      while (!ctl.isStop()) {
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
        if (d.healSandbox) {
          const healed = await d.healSandbox(h.id).catch((e: Error) => [`heal failed: ${e.message}`]);
          for (const line of healed) await status(line);
        }
        const goal = h.session.goal.trim();
        const holds = inProgress();
        const startable = ready();
        const openRequests = h.inbox.requests.filter((r) => r.state === "open");
        if (!goal && !holds.length && !startable.length) {
          run.state = hasOpenWork(h.board) || openRequests.length ? "paused" : "finished";
          run.pauseReason = openRequests.length ? "requests" : hasOpenWork(h.board) ? "waiting on the reviewer" : undefined;
          await status(openRequests.length ? "nothing to work on; waiting for your answers in the inbox" : run.state === "finished" ? "no ready tickets left" : "nothing can run");
          break;
        }
        // A request about the work itself (not a ticket) waits on you; the lead goes on only while tickets can.
        if (openRequests.some((r) => !r.ticketId) && !holds.length && !startable.length) {
          run.state = "paused";
          run.pauseReason = "requests";
          await status("the lead needs you; waiting for your answers in the inbox");
          break;
        }

        round++;
        run.rounds = round;
        const before = fingerprint();
        const noteBefore = await this.readNote(h, "state.md", 16_000);
        const agent = agentFor(h.session, "lead");
        const resume = Boolean(convoId) && agent.driver === "claude";
        const agentSession = agent.driver === "claude" ? (resume ? { id: convoId!, resume: true } : { id: randomUUID(), resume: false }) : undefined;
        const revised = lastGoal !== undefined && lastGoal !== goal;
        const sinceLastLife = newAnswers();
        const freshPrompt = async () => leadPrompt(h.board, await this.leadPromptOptions(h, { round, goal, holds, handoff: handoffNote, lastWords, answers: recentAnswers() }));
        const promptText = resume ? leadContinuePrompt(h.board, { round, committed: lastCommitted, holds, goal: revised ? goal : undefined, goalChangedAt: h.session.goalSince, answers: sinceLastLife }) : await freshPrompt();
        lastGoal = goal;
        const leadAbort = new AbortController();
        const onStop = () => leadAbort.abort();
        ctl.signal.addEventListener("abort", onStop, { once: true });
        if (ctl.signal.aborted) break;
        ctx.leadAbort = leadAbort;
        ctx.handoff = undefined;
        ctx.done = undefined;
        run.currentTicket = holds[0]?.id;
        await status(resume ? `life ${round}: the lead continues its conversation` : handoffNote || lastWords ? `life ${round}: a fresh lead starts from the note` : `life ${round}: the lead starts`);
        const lead = await this.runJob(h, run, { role: "lead", holds: holds[0]?.id, agentSession, promptText, freshPrompt }, log, leadAbort.signal);
        ctl.signal.removeEventListener("abort", onStop);
        await ctx.queue;
        addCost(run, lead.costUsd);

        // Whatever the life left uncommitted is committed, labelled with the tickets in progress; the lead's own commits carry their ids already.
        const summary = firstLine(lead.text) || "work in progress";
        const { committed, leaked } = await this.commitAll(h, `Lead ${run.id}.${round}: ${summary.slice(0, 72)}`, inProgress().map((t) => t.id));
        if (leaked.length) await log({ kind: "error", t: clock(), text: `An agent credential appears in the changes to ${leaked.join(", ")}; nothing was committed there. Remove it from the files.` });
        lastCommitted = committed;
        await saveRun();
        await status(`life ${round} ended (${lead.stopReason}): ${committed.length ? `committed ${committed.join(", ")}` : "nothing to commit"}`);
        if (ctl.isStop()) break;
        if (ctx.halted || h.inbox.requests.some((r) => r.state === "open" && r.halt)) {
          run.state = "halted";
          const halt = h.inbox.requests.find((r) => r.state === "open" && r.halt);
          if (halt) await status(`halted by the lead: ${halt.halt!.reason.slice(0, 300)}`);
          break;
        }
        if (lead.rateLimited || ctx.rateLimited) {
          ctx.rateLimited = false;
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
          if (lead.agentSession && lead.turns > 0) convoId = lead.agentSession;
          continue;
        }

        // Set by the done hook while the lead ran (read through a cast: the assignment above narrowed the field).
        const claimed = ctx.done as string | undefined;
        if (claimed) {
          const note = claimed.trim().slice(0, 8000);
          const at = clock();
          if (goal) await h.mutate((docs) => ({ next: { session: { ...docs.session, goalMet: { at, runId: run.id, note } } } }));
          const left = ready().length + inProgress().length;
          if (!left) {
            run.state = "finished";
            run.pauseReason = `done: ${firstLine(note).slice(0, 200)}`;
            await status(`the lead says the work is done: ${note.slice(0, 300)}`);
            break;
          }
          await status(`the lead says the goal is met, but ${left} ticket${left === 1 ? " is" : "s are"} still ready or in progress; the next lead works them`);
        }

        const noteAfter = await this.readNote(h, "state.md", 16_000);
        // Set by the handoff hook while the lead ran.
        const handedOff = ctx.handoff as string | undefined;
        if (handedOff) {
          handoffNote = handedOff;
          lastWords = undefined;
          convoId = undefined;
          await fs.writeFile(path.join(h.paths.notes, "state.md"), `# Handoff note\n\nWritten by the lead at ${clock()}, for the next lead.\n\n${handoffNote.trim()}\n`);
          await status(`the lead handed off: ${firstLine(handoffNote).slice(0, 160)}`);
        } else if (lead.stopReason === "time_cap" || lead.stopReason === "turn_cap" || leadAbort.signal.aborted) {
          lastWords = `(stopped at ${lead.stopReason}) ${lead.text.trim().slice(0, 3000) || "(no last message)"}`;
          handoffNote = (await this.readNote(h, "state.md", 16_000)) ?? undefined;
          convoId = undefined;
          await status(`the lead stopped at ${lead.stopReason}; a fresh lead takes over from the note`);
        } else {
          lastWords = undefined;
          convoId = lead.agentSession && lead.turns > 0 ? lead.agentSession : undefined;
        }

        const moved = committed.length > 0 || fingerprint() !== before || noteAfter !== noteBefore || Boolean(handedOff);
        idle = moved ? 0 : idle + 1;
        if (idle >= 2) {
          run.state = "paused";
          run.pauseReason = "the lead ended twice without a commit, a board change or a change to notes/state.md";
          await status(`${run.pauseReason}; its last message: ${lead.text.trim().slice(0, 300)}`);
          break;
        }
        if (d.proxyDenials) {
          const denials = await d.proxyDenials(h.id, lastDenialCheck).catch(() => []);
          lastDenialCheck = clock();
          for (const den of denials) await log({ kind: "denied_network", t: clock(), host: den.host, port: den.port });
        }
      }
    } finally {
      clearInterval(progressTimer);
      await ctx.queue;
      this.leads.delete(h.id);
      // A pause, a halt or an idle lead can end the run while tickets are in
      // progress. Put them back so the next run's lead takes them up again;
      // their changes and baselines stay. A stop requeues in the caller.
      if (!ctl.isStop()) {
        for (const t of h.board.tickets.filter((x) => x.state === "in_progress")) {
          await h.mutate((docs) => (getTicket(docs.board, t.id).state === "in_progress" ? { next: { board: transition(docs.board, t.id, "ready", { by: "harness", text: "The lead's run ended while it worked this ticket; requeued with the work kept" }) } } : {})).catch(() => undefined);
        }
      }
    }
  }

  /** The box as it is now, committed to an image: a recreated container starts from it, with what the lead installed. Best effort. */
  private async snapshot(h: SessionHandle, status: (text: string) => Promise<void>): Promise<void> {
    if (!this.deps.snapshotSandbox) return;
    const clock = this.deps.now ?? now;
    const snap = await this.deps.snapshotSandbox(h.session).catch((e: Error) => {
      void status(`snapshot skipped: ${e.message.slice(0, 200)}`);
      return undefined;
    });
    if (snap) await h.mutate((docs) => ({ next: { session: { ...docs.session, snapshot: { ...snap, at: clock() } } } }));
  }

  /**
   * The progress checks of a run: every `caps.progressMinutes` of the run,
   * the lead running then is asked for a short update, which it posts as a
   * `message` to the inbox. A check that falls between lives, or on a
   * driver that cannot take a message, goes to the next lead that can; a
   * lead is not asked twice within one interval. Nothing is enforced: the
   * lead's facts tell it to answer. The returned timer is cleared when the
   * run ends.
   */
  private progressChecks(h: SessionHandle, signal: AbortSignal, log: (e: VerstasEvent) => Promise<void>): ReturnType<typeof setInterval> | undefined {
    const minutes = h.session.caps.progressMinutes;
    if (!minutes) return undefined;
    const minuteMs = this.deps.progressMinuteMs ?? 60_000;
    const interval = minutes * minuteMs;
    let due = Date.now() + interval;
    const tick = () => {
      if (signal.aborted || Date.now() < due) return;
      const w = this.workers.get(h.id);
      if (!w || w.role !== "lead" || w.driver !== "claude") return;
      if (!w.send(PROGRESS_NUDGE, "verstas")) return;
      due = Date.now() + interval;
      void log({ kind: "status", t: (this.deps.now ?? now)(), text: `progress check: the lead was asked for a short update (every ${minutes} min, to the inbox)` }).catch(() => undefined);
    };
    const timer = setInterval(tick, Math.min(minuteMs, interval));
    timer.unref?.();
    return timer;
  }

  /** What a fresh lead is told besides the board: the note it inherits, what changed since the note was written, and the recent commits. */
  private async leadPromptOptions(h: SessionHandle, base: Omit<LeadPromptOptions, "stateNote" | "history" | "goalChange" | "metBefore">): Promise<LeadPromptOptions> {
    const sh = this.deps.shell(h.id);
    const history: { repo: string; log: string }[] = [];
    for (const repo of h.session.repos) {
      const r = await sh.exec(["git", "log", "--oneline", "-n", String(LOG_LINES)], { workdir: `/workspace/${repo.name}`, timeoutMs: 30_000 }).catch(() => null);
      history.push({ repo: repo.name, log: r?.code === 0 ? r.stdout : "" });
    }
    const s = h.session;
    const stateNote = await this.readNote(h, "state.md", 16_000);
    // The note was written for an earlier goal when it predates the current text (or does not exist yet and an earlier goal ended).
    const last = s.goals.at(-1);
    let goalChange: LeadPromptOptions["goalChange"];
    if (base.goal && last && s.goalSince) {
      const noteAt = await fs.stat(path.join(h.paths.notes, "state.md")).then((st) => st.mtime.toISOString()).catch(() => null);
      if (!noteAt || noteAt < s.goalSince) goalChange = { kind: last.outcome === "met" ? "next" : "revised", at: last.until, previous: last.text, note: last.note };
    }
    return { ...base, stateNote, goalChange, metBefore: base.goal && s.goalMet ? { at: s.goalMet.at, note: s.goalMet.note } : undefined, history };
  }

  /** A ticket with open requests waits for them (or halts the run); its changes stay in the working tree and in the lead's commits. */
  private async parkOnRequests(h: SessionHandle, ticketId: string, log: (e: VerstasEvent) => Promise<void>): Promise<"waiting" | "halted" | undefined> {
    const openForTicket = h.inbox.requests.filter((r) => r.state === "open" && r.ticketId === ticketId);
    if (!openForTicket.length) return undefined;
    const halt = openForTicket.find((r) => r.halt);
    await this.move(h, ticketId, "waiting", halt ? `Halt requested: ${halt.halt?.reason ?? ""}` : `Waiting on ${openForTicket.map((r) => `${r.id} (${r.actions.map((a) => a.detail.kind).join(", ") || "question"})`).join(", ")}`, log);
    return halt ? "halted" : "waiting";
  }

  private async move(h: SessionHandle, ticketId: string, to: TicketState, note: string, log: (e: VerstasEvent) => Promise<void>): Promise<void> {
    const from = getTicket(h.board, ticketId).state;
    await h.mutate((docs) => ({ next: { board: transition(docs.board, ticketId, to, { by: "harness", text: note }) } }));
    await log({ kind: "ticket", t: (this.deps.now ?? now)(), ticket: ticketId, from, to, note });
  }

  /**
   * The verdict on a ticket the lead moved to review: the change since the
   * ticket's baseline (docs/BOARD.md, "Judging"), the reviewer (who runs the
   * repositories' checks; without one the lead's word is the verdict), and
   * the move out of review to done, back to ready with the notes, or to
   * blocked. Only this moves a ticket to done while the session has a
   * reviewer.
   */
  async judge(
    h: SessionHandle,
    run: Run,
    ticketId: string,
    log: (e: VerstasEvent) => Promise<void>,
    signal: AbortSignal,
  ): Promise<"done" | "requeued" | "blocked" | "rate_limited"> {
    const d = this.deps;
    const clock = d.now ?? now;
    const caps = h.session.caps;
    const ticket = getTicket(h.board, ticketId);
    const move = (to: TicketState, note: string) => this.move(h, ticketId, to, note, log);

    if (signal.aborted) return "requeued";
    // What changed, in every repository: the ticket's expected list is a
    // hint, the change decides what is judged (docs/BOARD.md, "Judging").
    const changes = await this.collectChanges(h, ticketId);
    const names = changes.map((c) => c.repo);
    const numstat = { added: sum(changes, "added"), removed: sum(changes, "removed"), files: sum(changes, "files") };
    const changed = numstat.files > 0;
    const level = reviewLevel(ticket, caps);
    const mode = level.mode;
    const touched: TouchedRepo[] = changes.map((c) => ({ repo: c.repo, added: c.added, removed: c.removed, files: c.files }));
    const planned = plannedVsTouched(ticket.repos, names);
    const perRepo = changes.length ? changes.map((c) => `${c.repo} ${c.files} files, +${c.added} −${c.removed}${c.commits.mine.length ? `, ${c.commits.mine.length} commit${c.commits.mine.length === 1 ? "" : "s"}` : ""}`).join("; ") : "0 files, +0 −0";
    const summary = `Submitted by the lead; ${perRepo}${planned ? ` (${planned})` : ""}; judged: ${mode} (${level.why})`;
    if (getTicket(h.board, ticketId).state !== "review") await move("review", summary);
    else await h.mutate((docs) => ({ next: { board: addNote(docs.board, ticketId, "harness", summary) } }));

    // Who decides. With a reviewer: the reviewer, always, including when no
    // files changed (a report or an investigation can be the deliverable);
    // it runs the repositories' checks itself. Without one the lead's word
    // is the verdict.
    let verdict: "ok" | "fixable" | "blocked";
    let verdictNote = "";
    if (mode === "none") {
      verdict = "ok";
    } else {
      if (signal.aborted) return "requeued";
      const rev = await this.runJob(h, run, { role: "reviewer", ticket: ticketId, promptText: reviewerPrompt(getTicket(h.board, ticketId), changes, { why: level.why, planned }) }, log, signal);
      addCost(run, rev.costUsd);
      await this.writeTicketReport(h, run, ticketId, "reviewer", rev);
      if (rev.rateLimited) {
        // Mark the lead's run first: the move below wakes a lead waiting on the verdict, and its next move into progress must already be refused.
        const lead = this.leads.get(h.id);
        if (lead && lead.runId === run.id) lead.rateLimited = true;
        await move("ready", "Reviewer was rate limited; requeued with the work kept");
        return "rate_limited";
      }
      if (signal.aborted) return "requeued";
      const parsed = parseVerdict(rev.text);
      verdict = parsed?.verdict ?? "fixable";
      verdictNote = parsed?.reason ?? `reviewer gave no verdict (${rev.stopReason})`;
    }

    await h.mutate((docs) => ({ next: { board: replaceTicket(docs.board, { ...getTicket(docs.board, ticketId), touched }) } }));

    if (verdict === "ok") {
      // The lead's commits carry the ticket; what is still uncommitted is
      // committed under the ticket when no other ticket is in flight (its
      // edits could be in the working tree too; the backup commit at the end
      // of the life takes those, labelled with every ticket in progress).
      const others = h.board.tickets.filter((t) => t.id !== ticketId && (t.state === "in_progress" || t.state === "review"));
      if (!others.length) {
        const leaked = await this.commitInContainer(h, `${ticketId}: ${ticket.title}`, [ticketId]);
        if (leaked.length) {
          const note = `The Claude token appears in the changes to ${leaked.join(", ")}; nothing was committed in any repository. Remove it from the files (the changes are still in the working tree) and move the ticket back to ready.`;
          await log({ kind: "error", t: clock(), ticket: ticketId, text: note });
          await move("blocked", note);
          return "blocked";
        }
      }
      await h.mutate((docs) => {
        const { baseline: _b, ...t } = getTicket(docs.board, ticketId);
        return { next: { board: replaceTicket(docs.board, { ...t, diff: numstat, touched }) } };
      });
      await move("done", `${mode === "full" ? "Reviewed ok" : "Accepted on the lead's word"}${changed ? "" : " (no files changed)"}${verdictNote ? `: ${verdictNote}` : ""}`);
      run.ticketsDone++;
      return "done";
    }
    if (verdict === "fixable") {
      await move("ready", `Not done yet (${verdictNote || "see reviewer notes"}); the reviewer's notes are on the ticket`);
      return "requeued";
    }
    await move("blocked", `Reviewer: blocked. ${verdictNote}`);
    return "blocked";
  }

  /** board_changes: what the judge would see now, without the diffs. */
  /** A file an agent published: copied out of the box now, so later changes to it in the box do not reach it. */
  async publishArtifact(run: RunToken, boxPath: string, name?: string): Promise<Artifact> {
    if (!this.deps.copyOut) throw new Error("Artifacts need the Docker sandbox");
    if (this.active.get(run.sessionId)?.run.id !== run.runId) throw new Error("This run has ended");
    const h = await this.deps.hub.get(run.sessionId);
    const at = path.posix.isAbsolute(boxPath) ? boxPath : path.posix.join("/workspace", boxPath);
    const a = await addArtifact(h.paths.artifacts, { name: name ?? at, runId: run.runId, now: (this.deps.now ?? now)() }, (file) => this.deps.copyOut!(run.sessionId, at, file, ARTIFACT_MAX_BYTES));
    this.deps.hub.emitRunEvent({ sessionId: run.sessionId, runId: run.runId, event: { kind: "status", t: (this.deps.now ?? now)(), text: `artifact published: ${a.name} (${a.bytes} bytes)` } });
    return a;
  }

  async previewJudging(sessionId: string, ticketId?: string): Promise<unknown> {
    const h = await this.deps.hub.get(sessionId);
    const ticket = ticketId ? h.board.tickets.find((t) => t.id === ticketId) : undefined;
    const changes = await this.collectChanges(h, ticket?.id);
    const level = ticket ? reviewLevel(ticket, h.session.caps) : { mode: h.session.caps.reviewer ? ("full" as const) : ("none" as const), why: "the session's setting" };
    return {
      ticket: ticket?.id,
      touched: changes.map((c) => ({ repo: c.repo, files: c.files, added: c.added, removed: c.removed, paths: c.paths.slice(0, 50), commits: c.commits })),
      planned: ticket?.repos ?? [],
      plannedVsTouched: ticket ? plannedVsTouched(ticket.repos, changes.map((c) => c.repo)) : undefined,
      review: level,
    };
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
    job: {
      role: Job["role"];
      ticket?: string;
      promptText: string;
      agentSession?: Job["agentSession"];
      /** The prompt for a fresh conversation when a resume fails. */
      freshPrompt?: () => Promise<string>;
      /** A ticket the lead already has in progress; its token starts with it. */
      holds?: string;
    },
    log: (e: VerstasEvent) => Promise<void>,
    signal: AbortSignal,
  ): Promise<WorkerDone> {
    // A stop that came while the loop was between workers: start nothing,
    // since a listener added to an already aborted signal never fires.
    if (signal.aborted) {
      const done: WorkerDone = { kind: "worker_done", t: (this.deps.now ?? now)(), ticket: job.ticket, role: job.role, ok: false, stopReason: "aborted", rateLimited: false, costUsd: 0, turns: 0, seconds: 0, text: "", stderr: "" };
      await log(done);
      return done;
    }
    const name = `${run.id}-${++this.jobSeq}-${job.role}`;
    const rel = `${WORKSPACE_FILES}/jobs/${name}`;
    const dir = path.join(h.paths.workspace, rel);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "prompt.md"), job.promptText);
    await fs.writeFile(path.join(dir, "system.md"), systemMd(job.role, job.role === "lead" ? await readLeadRules() : undefined));
    // The reviewer may be a different agent than the worker (session.agents); everything else about the job is the same.
    const agent = agentFor(h.session, job.role);
    const spec: Job = {
      role: job.role,
      ticket: job.ticket,
      driver: agent.driver,
      promptFile: `/workspace/${rel}/prompt.md`,
      systemPromptFile: `/workspace/${rel}/system.md`,
      // The lead's caps are optional liveness limits; nobody else has any.
      caps: job.role === "lead" ? { minutes: h.session.caps.leadMinutes, turns: h.session.caps.leadTurns } : {},
      mcpConfigFile: `/workspace/${WORKSPACE_FILES}/mcp.json`,
      model: agent.model || undefined,
      budgetFile: `/workspace/${rel}/budget.json`,
    };
    if (job.agentSession && agent.driver === "claude") spec.agentSession = job.agentSession;
    if (DEBUG) spec.debug = true;
    const jobFile = `/workspace/${rel}/job.json`;
    await fs.writeFile(path.join(dir, "job.json"), JSON.stringify(spec, null, 2));
    const rawLog = DEBUG ? path.join(h.paths.runs, String(run.id), `worker-${name}-${job.ticket ?? "none"}.raw.jsonl`) : undefined;
    const token = this.deps.tokens.issue({ sessionId: h.id, runId: run.id, role: tokenRole(job.role), job: job.role, currentTicket: job.holds ?? job.ticket });
    const attach = (w: WorkerHandle) => this.workers.set(h.id, { ...w, role: job.role, ticket: job.ticket, log });
    try {
      let done = await this.deps.worker(h.id).run(spec, (e) => void log(e), signal, { rawLog, runToken: token, jobFile, attach });
      // A conversation that cannot be resumed (pruned, written by another CLI
      // version) fails before its first turn; start a fresh one under a new id.
      if (spec.agentSession?.resume && !done.ok && done.turns === 0 && !done.rateLimited && !signal.aborted) {
        await log(done);
        await log({ kind: "status", t: (this.deps.now ?? now)(), ticket: job.ticket, text: `could not resume the agent conversation (${done.stopReason}); starting a fresh one` });
        if (job.freshPrompt) await fs.writeFile(path.join(dir, "prompt.md"), await job.freshPrompt());
        const fresh: Job = { ...spec, agentSession: { id: randomUUID(), resume: false } };
        await fs.writeFile(path.join(dir, "job.json"), JSON.stringify(fresh, null, 2));
        done = await this.deps.worker(h.id).run(fresh, (e) => void log(e), signal, { rawLog, runToken: token, jobFile, attach });
        done = { ...done, agentSession: fresh.agentSession!.id };
      } else if (spec.agentSession) done = { ...done, agentSession: spec.agentSession.id };
      await log(done);
      await this.addAgentSeconds(h, done);
      return done;
    } finally {
      this.workers.delete(h.id);
      this.deps.tokens.revoke(token);
    }
  }

  /**
   * An agent terminal, start to end: the rules and job file in a job
   * directory, a run token with the terminal's permissions (it plans with
   * you and asks you directly), the agent's own
   * interface on a TTY the page attaches to, and when it exits or the run
   * is stopped, one commit of whatever changed in the repositories.
   */
  private async runTerminal(h: SessionHandle, run: Run, spec: NonNullable<RunOptions["terminal"]>, log: (e: VerstasEvent) => Promise<void>, signal: AbortSignal): Promise<void> {
    const clock = this.deps.now ?? now;
    const live = this.terminals.get(h.id);
    if (!live || live.runId !== run.id || !this.deps.terminal) throw new Error("the agent terminal was not set up for this run");
    const title = driverInfo(spec.driver).title;
    const name = `${run.id}-${++this.jobSeq}-terminal`;
    const rel = `${WORKSPACE_FILES}/jobs/${name}`;
    const dir = path.join(h.paths.workspace, rel);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "rules.md"), terminalMd(spec.driver));
    // The session's worker model when the worker runs on the same driver; else the CLI's default.
    const worker = agentFor(h.session, "lead");
    const job: TerminalJob = {
      driver: spec.driver === "codex" ? "codex" : "claude",
      model: worker.driver === spec.driver ? worker.model || undefined : undefined,
      mcpConfigFile: `/workspace/${WORKSPACE_FILES}/mcp.json`,
      rulesFile: `/workspace/${rel}/rules.md`,
      credentialOut: `/workspace/${rel}/credential.out`,
    };
    await fs.writeFile(path.join(dir, "job.json"), JSON.stringify(job, null, 2));
    const token = this.deps.tokens.issue({ sessionId: h.id, runId: run.id, role: "terminal" });
    let stopped = false;
    try {
      if (signal.aborted) {
        stopped = true;
        return;
      }
      const proc = await this.deps.terminal(h.id).open({ driver: spec.driver, jobFile: `/workspace/${rel}/job.json`, credentialFile: path.join(dir, "credential.out"), runToken: token, ...live.size });
      live.bind(proc);
      await log({ kind: "status", t: clock(), text: `agent terminal: ${title} is running; type to it on the session page` });
      const onAbort = () => {
        stopped = true;
        void proc.kill();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      const code = await proc.exited;
      signal.removeEventListener("abort", onAbort);
      live.end(code, stopped);
      await log({ kind: "status", t: clock(), text: stopped ? `agent terminal: ${title} was ended` : `agent terminal: ${title} exited${code === null ? "" : ` (exit ${code})`}` });
    } finally {
      this.deps.tokens.revoke(token);
      // Whatever the agent changed in the repositories becomes one commit, as after your prompt.
      const leaked = await this.commitInContainer(h, `Terminal: ${title} (run ${run.id})`);
      if (leaked.length) await log({ kind: "error", t: clock(), text: `An agent credential appears in the changes to ${leaked.join(", ")}; nothing was committed there. Remove it from the files.` });
      run.state = stopped || signal.aborted ? "stopped" : "finished";
    }
  }

  /** A ticket's worker (implementer or reviewer, never the lead, which spans tickets) adds its time to the ticket's agentSeconds. */
  private async addAgentSeconds(h: SessionHandle, done: WorkerDone): Promise<void> {
    if (!done.ticket || done.role === "lead" || !(done.seconds > 0)) return;
    const id = done.ticket;
    await h.mutate((docs) => {
      const t = docs.board.tickets.find((x) => x.id === id);
      return t ? { next: { board: replaceTicket(docs.board, { ...t, agentSeconds: (t.agentSeconds ?? 0) + done.seconds }) } } : {};
    });
  }

  /** A file under notes/, capped so a runaway note cannot crowd out the ticket. */
  private async readNote(h: SessionHandle, name: string, cap: number): Promise<string | null> {
    const text = await fs.readFile(path.join(h.paths.notes, name), "utf8").catch(() => "");
    if (!text.trim()) return null;
    return text.length > cap ? text.slice(0, cap) + `\n\n(${name} truncated at ${cap} characters; shorten it)` : text;
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
  }

  private async writeTicketReport(h: SessionHandle, run: Run, ticketId: string, role: string, done: WorkerDone): Promise<void> {
    const file = path.join(h.paths.runs, String(run.id), "tickets", `${ticketId}.md`);
    const t = getTicket(h.board, ticketId);
    const block = `\n## lead's report\n\n${t.report ?? "(no report)"}\n\n## ${role} · ${done.t} · ${done.stopReason} · ${done.turns} turns · ${done.seconds}s · $${done.costUsd.toFixed(2)}\n\n${done.text}\n`;
    await fs.appendFile(file, block);
  }

  /**
   * Stages everything and reads what changed in every repository for a
   * ticket, as the review boundary defines it (docs/BOARD.md, "Judging"):
   * since the ticket's baseline, the commits that carry its id (subject or
   * Verstas-Ticket trailer) plus the working tree; commits of other tickets
   * in the range are left out, unlabelled ones are listed. Without a
   * baseline (a ticket from before baselines, or no ticket at all) it is
   * the working tree against HEAD. Only repositories with a change are
   * returned.
   */
  private async collectChanges(h: SessionHandle, ticketId?: string): Promise<RepoChange[]> {
    const sh = this.deps.shell(h.id);
    const ticket = ticketId ? h.board.tickets.find((t) => t.id === ticketId) : undefined;
    const out: RepoChange[] = [];
    for (const repo of h.session.repos) {
      const workdir = `/workspace/${repo.name}`;
      const git = (args: string[], timeoutMs = 60_000) => sh.exec(["git", ...args], { workdir, timeoutMs });
      await git(["add", "-A"]);
      const base = ticket?.baseline?.[repo.name];
      let commits: RepoChange["commits"] = { mine: [], others: [], unlabelled: [] };
      let ref: string[] = [];
      if (base && ticketId) {
        const lg = await git(["log", "--format=%H%x09%s%x09%(trailers:key=Verstas-Ticket,valueonly,separator=%x2C)", `${base}..HEAD`]);
        if (lg.code === 0) commits = classifyCommits(lg.stdout, ticketId);
        // Nothing else in the range: one diff from the baseline covers the commits and the working tree.
        if (lg.code === 0 && !commits.others.length) ref = [base];
      }
      let added = 0;
      let removed = 0;
      let files = 0;
      const paths: string[] = [];
      const take = (numstat: string) => {
        for (const line of numstat.split("\n")) {
          const [a, r, ...rest] = line.split("\t");
          if (a === undefined || r === undefined) continue;
          files++;
          added += Number(a) || 0;
          removed += Number(r) || 0;
          // A rename shows as "old => new" or "{a => b}/file"; the new name is what the rules apply to.
          const p = rest.join("\t").trim().replace(/\{[^}]* => ([^}]*)\}/g, "$1").replace(/^.* => /, "");
          if (p) paths.push(p);
        }
      };
      let stat = "";
      let diff = "";
      if (commits.others.length) {
        // Other tickets' commits sit in the range: this ticket's commits are shown one by one, then the working tree against HEAD.
        for (const c of commits.mine) {
          const sha = c.split(" ")[0]!;
          const num = await git(["show", "--numstat", "--format=", sha]);
          take(num.stdout);
          const patch = await git(["show", "--format=## %h %s", sha]);
          diff += `${patch.stdout}\n`;
        }
        const num = await git(["diff", "--cached", "--numstat"]);
        take(num.stdout);
        const wt = await git(["diff", "--cached"]);
        if (wt.stdout.trim()) diff += `## working tree (uncommitted)\n${wt.stdout}\n`;
        stat = (await git(["diff", "--cached", "--stat"])).stdout.trim();
      } else {
        let num = await git(["diff", "--cached", "--numstat", ...ref]);
        if (num.code !== 0 && ref.length) {
          // The baseline is gone (a reclone, a rewritten history): fall back to the working tree.
          ref = [];
          num = await git(["diff", "--cached", "--numstat"]);
        }
        take(num.stdout);
        if (files) {
          stat = (await git(["diff", "--cached", "--stat", ...ref])).stdout.trim();
          diff = (await git(["diff", "--cached", ...ref])).stdout;
        }
      }
      if (!files && !commits.mine.length) continue;
      out.push({ repo: repo.name, added, removed, files, stat, diff, paths, commits });
    }
    return out;
  }

  /**
   * Commits every change in every repo of the session, inside the container
   * (docs/SANDBOX.md Boundary 5), all or nothing: every repository's staged
   * diff is searched for secrets first, and if one has a secret nothing is
   * committed anywhere (the changes are unstaged and stay in the working
   * tree) and the names are returned so the caller can refuse. The commit
   * carries a `Verstas-Ticket` trailer per ticket it belongs to and a
   * `Verstas-Repos` trailer when it spans repositories, so the commits of
   * one change can be found together.
   */
  private async commitInContainer(h: SessionHandle, message: string, ticketIds: readonly string[] = []): Promise<string[]> {
    return (await this.commitAll(h, message, ticketIds)).leaked;
  }

  /** Every repository with staged changes is committed with the message, or none when a secret is in any of them: the committed names and the leaking ones. */
  private async commitAll(h: SessionHandle, message: string, ticketIds: readonly string[] = []): Promise<{ committed: string[]; leaked: string[] }> {
    const sh = this.deps.shell(h.id);
    const secrets = ((await this.deps.secrets?.().catch(() => [])) ?? []).filter((x) => x.length >= 16);
    const leaked: string[] = [];
    const staged: string[] = [];
    for (const repo of h.session.repos) {
      const dir = `/workspace/${repo.name}`;
      await sh.exec(["git", "add", "-A"], { workdir: dir, timeoutMs: 60_000 });
      const quiet = await sh.exec(["git", "diff", "--cached", "--quiet"], { workdir: dir, timeoutMs: 60_000 });
      if (quiet.code === 0) continue; // nothing to commit here
      staged.push(repo.name);
      if (secrets.length) {
        // Searched on the host: the secret never goes into a command line in the box.
        const diff = await sh.exec(["git", "diff", "--cached", "--no-color", "--text"], { workdir: dir, timeoutMs: 120_000 });
        if (secrets.some((sec) => diff.stdout.includes(sec) || diff.stdout.includes(sec.slice(0, 40)))) leaked.push(repo.name);
      }
    }
    if (leaked.length) {
      for (const name of staged) await sh.exec(["git", "reset", "-q"], { workdir: `/workspace/${name}`, timeoutMs: 60_000 });
      return { committed: [], leaked };
    }
    const trailers = [...ticketIds.flatMap((id) => ["--trailer", `Verstas-Ticket: ${id}`]), ...(ticketIds.length && staged.length > 1 ? ["--trailer", `Verstas-Repos: ${staged.join(", ")}`] : [])];
    for (const name of staged) await sh.exec(["git", "-c", "core.hooksPath=/dev/null", "commit", "-q", "--no-verify", ...trailers, "-m", message], { workdir: `/workspace/${name}`, timeoutMs: 60_000 });
    return { committed: staged, leaked };
  }
}

// --- helpers -----------------------------------------------------------------

const sum = <K extends "added" | "removed" | "files">(xs: readonly Record<K, number>[], k: K): number => xs.reduce((n, x) => n + x[k], 0);



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

export const parseVerdict = (text: string): { verdict: "ok" | "fixable" | "blocked"; reason: string } | null => {
  const m = /VERDICT:\s*(ok|fixable|blocked)\b/i.exec(text);
  if (!m) return null;
  const reason = text.slice((m.index ?? 0) + m[0].length).trim().split("\n").filter(Boolean).slice(0, 6).join(" ").slice(0, 1000);
  return { verdict: m[1]!.toLowerCase() as "ok" | "fixable" | "blocked", reason };
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

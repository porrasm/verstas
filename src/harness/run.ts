import { promises as fs } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { eventSchema, now, runSchema, type Board, type Run, type Session, type Ticket, type TicketState, type VerstasEvent } from "../core/types.js";
import { addNote, getTicket, hasOpenWork, nextReady, replaceTicket, transition } from "../board/board.js";
import { writeJsonAtomic } from "../board/store.js";
import type { SessionHandle, SessionHub } from "../sessions/hub.js";
import type { RunTokens } from "../agent-api/agent-api.js";
import { workspaceSizeMb } from "../sessions/sessions.js";
import { implementerPrompt, mcpConfig, notesIndexMd, plannerPrompt, reviewerPrompt, systemMd, verstasMd } from "./prompts.js";
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
  run(job: Job, onEvent: (e: VerstasEvent) => void, signal: AbortSignal, opts?: { rawLog?: string }): Promise<WorkerDone>;
}

export const DEBUG = Boolean(process.env.VERSTAS_DEBUG);

export type RunDeps = {
  hub: SessionHub;
  tokens: RunTokens;
  /** Per session, so two sessions can run at once. */
  shell: (sessionId: string) => Shell;
  worker: (sessionId: string) => WorkerRunner;
  /** Called once before the loop; brings the sandbox up with the env file at the given path. */
  ensureSandbox: (session: Session, envFile: string, token: string) => Promise<void>;
  agentApiUrl: string;
  /** Proxy "denied" lines since a timestamp, for the log. */
  proxyDenials?: (sessionId: string, since: string) => Promise<{ host: string; port: number }[]>;
  /** For tests: a fixed clock. */
  now?: () => string;
  /** For tests: how long to sleep on a rate limit (ms). */
  rateLimitSleepMs?: number;
};

export type RunControl = {
  run: Run;
  pauseAfterTicket: () => void;
  stopNow: () => void;
  done: Promise<Run>;
};

const WORKSPACE_FILES = ".verstas";

export class RunManager {
  private active = new Map<string, RunControl>();
  constructor(private readonly deps: RunDeps) {}

  status(sessionId: string): Run | undefined {
    return this.active.get(sessionId)?.run;
  }

  async start(sessionId: string, opts: { plan?: boolean } = {}): Promise<RunControl> {
    if (this.active.has(sessionId)) throw new Error("A run is already active for this session");
    const h = await this.deps.hub.get(sessionId);
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

  private async loop(
    h: SessionHandle,
    run: Run,
    opts: { plan?: boolean },
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

    const token = d.tokens.issue({ sessionId: h.id, runId: run.id, role: "worker" });
    try {
      await log({ kind: "run", t: clock(), state: "running" });
      await setSessionState("running");
      await saveRun();

      const envFile = path.join(runDir, "env");
      await d.ensureSandbox(h.session, envFile, token);
      await this.writeWorkspaceFiles(h, token);

      // Plan when asked, or when the board is empty.
      if (opts.plan || h.board.tickets.length === 0) {
        await setSessionState("planning");
        d.tokens.update(token, { role: "planner", currentTicket: undefined });
        await status("planner: turning the goal into tickets");
        const done = await this.runJob(h, run, { role: "planner", promptText: plannerPrompt(h.session, h.board) }, log, ctl.signal);
        addCost(run, done.costUsd);
        await saveRun();
        d.tokens.update(token, { role: "worker" });
        await status(`planner finished (${done.stopReason}); ${h.board.tickets.filter((t) => t.state === "backlog").length} tickets in backlog await your approval`);
        await setSessionState("running");
      }

      let lastDenialCheck = clock();
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
        if (run.ticketsDone >= h.session.caps.runTickets) {
          run.state = "finished";
          await status(`run ticket cap of ${h.session.caps.runTickets} reached`);
          break;
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

        const outcome = await this.workTicket(h, run, ticket, token, log, ctl.signal);
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
      const sessionState: Session["state"] =
        run.state === "halted" ? "halted" : run.state === "finished" ? "finished" : run.pauseReason === "requests" ? "waiting" : "paused";
      await setSessionState(sessionState).catch(() => undefined);
    }
    return run;
  }

  /** One ticket, start to finish. Returns how it ended for the loop's bookkeeping. */
  private async workTicket(
    h: SessionHandle,
    run: Run,
    ticket: Ticket,
    token: string,
    log: (e: VerstasEvent) => Promise<void>,
    signal: AbortSignal,
  ): Promise<"done" | "requeued" | "waiting" | "blocked" | "rate_limited" | "halted"> {
    const d = this.deps;
    const clock = d.now ?? now;
    const caps = h.session.caps;
    const move = async (to: TicketState, note: string) => {
      await h.mutate((docs) => ({ next: { board: transition(docs.board, ticket.id, to, { by: "harness", text: note }) } }));
      await log({ kind: "ticket", t: clock(), ticket: ticket.id, from: getTicket(h.board, ticket.id).state, to, note });
    };

    const answer = latestAnswer(h, ticket.id);
    await h.mutate((docs) => ({ next: { board: transition(docs.board, ticket.id, "in_progress", { by: "harness", text: `Implementer attempt ${ticket.attempts + 1} started` }) } }));
    await log({ kind: "ticket", t: clock(), ticket: ticket.id, from: "ready", to: "in_progress" });
    run.currentTicket = ticket.id;
    d.tokens.update(token, { currentTicket: ticket.id, role: "worker" });

    const impl = await this.runJob(h, run, { role: "implementer", ticket: ticket.id, promptText: implementerPrompt(h.board, getTicket(h.board, ticket.id), answer) }, log, signal);
    addCost(run, impl.costUsd);
    await this.writeTicketReport(h, run, ticket.id, "implementer", impl);

    if (signal.aborted) return "requeued";
    if (impl.rateLimited) {
      await h.mutate((docs) => {
        const t = getTicket(docs.board, ticket.id);
        // A rate limit is not the ticket's fault: give the attempt back.
        return { next: { board: transition(replaceTicket(docs.board, { ...t, attempts: Math.max(0, t.attempts - 1) }), ticket.id, "ready", { by: "harness", text: "Rate limited; requeued" }) } };
      });
      run.currentTicket = undefined;
      return "rate_limited";
    }

    const openForTicket = h.inbox.requests.filter((r) => r.state === "open" && r.ticketId === ticket.id);
    const halt = openForTicket.find((r) => r.detail.kind === "halt");
    if (openForTicket.length) {
      await this.commitInContainer(h, ticket, `${ticket.id} (waiting): ${ticket.title}`);
      await move("waiting", halt ? `Halt requested: ${halt.detail.kind === "halt" ? halt.detail.reason : ""}` : `Waiting on ${openForTicket.map((r) => `${r.id} (${r.detail.kind})`).join(", ")}`);
      run.currentTicket = undefined;
      return halt ? "halted" : "waiting";
    }

    // Gates, diff, review.
    const current = getTicket(h.board, ticket.id);
    const repoDir = current.repo && h.session.repos.some((r) => r.name === current.repo) ? `/workspace/${current.repo}` : h.session.repos[0] ? `/workspace/${h.session.repos[0].name}` : "/workspace";
    const gates = await this.runGates(h.id, repoDir, log, ticket.id);
    const { stat, numstat, diff } = await this.stageAndDiff(h.id, repoDir);
    const changed = numstat.files > 0;
    await move("review", `Implementer ${impl.ok ? "finished" : `stopped (${impl.stopReason})`}; ${numstat.files} files, +${numstat.added} −${numstat.removed}`);

    let verdict: "ok" | "fixable" | "blocked" = impl.ok && gates.every((g) => g.ok) && changed ? "ok" : "fixable";
    let verdictNote = "";
    if (!current.report) verdictNote = "no report was filed";
    if (!changed) verdictNote = "no files changed";
    if (caps.reviewer && changed) {
      d.tokens.update(token, { role: "worker", currentTicket: ticket.id });
      const rev = await this.runJob(h, run, { role: "reviewer", ticket: ticket.id, promptText: reviewerPrompt(getTicket(h.board, ticket.id), stat, diff, gates) }, log, signal);
      addCost(run, rev.costUsd);
      await this.writeTicketReport(h, run, ticket.id, "reviewer", rev);
      if (rev.rateLimited) {
        // Keep the work; the loop sleeps and the ticket goes back to ready for a fresh review next time.
        await this.commitInContainer(h, ticket, `${ticket.id} (wip): ${ticket.title}`);
        await move("ready", "Reviewer was rate limited; requeued with the work kept");
        return "rate_limited";
      }
      const parsed = parseVerdict(rev.text);
      if (parsed) {
        verdict = verdict === "ok" ? parsed.verdict : parsed.verdict === "ok" ? "fixable" : parsed.verdict;
        verdictNote = parsed.reason;
      } else {
        verdict = "fixable";
        verdictNote = `reviewer gave no verdict (${rev.stopReason})`;
      }
    }

    if (verdict === "ok") {
      await this.commitInContainer(h, ticket, `${ticket.id}: ${ticket.title}`);
      await h.mutate((docs) => {
        const t = getTicket(docs.board, ticket.id);
        return { next: { board: replaceTicket(docs.board, { ...t, diff: numstat, cost: { ...(t.cost ?? { inputTokens: 0, outputTokens: 0 }), usd: (t.cost?.usd ?? 0) + impl.costUsd } }) } };
      });
      await move("done", `Reviewed ok${verdictNote ? `: ${verdictNote}` : ""}`);
      run.ticketsDone++;
      run.currentTicket = undefined;
      return "done";
    }
    const attempts = getTicket(h.board, ticket.id).attempts;
    if (verdict === "fixable" && attempts < caps.ticketAttempts) {
      await this.commitInContainer(h, ticket, `${ticket.id} (wip attempt ${attempts}): ${ticket.title}`);
      await move("ready", `Not done yet (${verdictNote || "see reviewer notes"}); attempt ${attempts} of ${caps.ticketAttempts}`);
      run.currentTicket = undefined;
      return "requeued";
    }
    await this.commitInContainer(h, ticket, `${ticket.id} (blocked): ${ticket.title}`);
    await move("blocked", verdict === "blocked" ? `Reviewer: blocked. ${verdictNote}` : `Gave up after ${attempts} attempts: ${verdictNote || "not accepted"}`);
    run.currentTicket = undefined;
    return "blocked";
  }

  private async runJob(
    h: SessionHandle,
    run: Run,
    job: { role: Job["role"]; ticket?: string; promptText: string },
    log: (e: VerstasEvent) => Promise<void>,
    signal: AbortSignal,
  ): Promise<WorkerDone> {
    const dir = path.join(h.paths.workspace, WORKSPACE_FILES);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "prompt.md"), job.promptText);
    await fs.writeFile(path.join(dir, "system.md"), systemMd(job.role));
    const spec: Job = {
      role: job.role,
      ticket: job.ticket,
      promptFile: `/workspace/${WORKSPACE_FILES}/prompt.md`,
      systemPromptFile: `/workspace/${WORKSPACE_FILES}/system.md`,
      caps: { minutes: h.session.caps.workerMinutes, turns: h.session.caps.workerTurns, budgetUsd: h.session.caps.budgetUsd },
      mcpConfigFile: `/workspace/${WORKSPACE_FILES}/mcp.json`,
    };
    if (DEBUG) spec.debug = true;
    await fs.writeFile(path.join(dir, "job.json"), JSON.stringify(spec, null, 2));
    const rawLog = DEBUG ? path.join(h.paths.runs, String(run.id), `worker-${job.ticket ?? "planner"}-${job.role}-${Date.now()}.raw.jsonl`) : undefined;
    const done = await this.deps.worker(h.id).run(spec, (e) => void log(e), signal, { rawLog });
    await log(done);
    return done;
  }

  private async writeWorkspaceFiles(h: SessionHandle, _token: string): Promise<void> {
    const ws = h.paths.workspace;
    await fs.writeFile(path.join(ws, "VERSTAS.md"), verstasMd(h.session, this.deps.agentApiUrl));
    await fs.mkdir(path.join(ws, WORKSPACE_FILES), { recursive: true });
    await fs.writeFile(path.join(ws, WORKSPACE_FILES, "mcp.json"), JSON.stringify(mcpConfig(), null, 2));
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

  /** Commits everything staged in every repo of the session, inside the container (docs/SANDBOX.md Boundary 5). */
  private async commitInContainer(h: SessionHandle, _ticket: Ticket, message: string): Promise<void> {
    const sh = this.deps.shell(h.id);
    for (const repo of h.session.repos) {
      const dir = `/workspace/${repo.name}`;
      await sh.exec(["git", "add", "-A"], { workdir: dir, timeoutMs: 60_000 });
      const staged = await sh.exec(["git", "diff", "--cached", "--quiet"], { workdir: dir, timeoutMs: 60_000 });
      if (staged.code === 0) continue; // nothing to commit here
      await sh.exec(["git", "-c", "core.hooksPath=/dev/null", "commit", "-q", "--no-verify", "-m", message], { workdir: dir, timeoutMs: 60_000 });
    }
  }
}

// --- helpers -----------------------------------------------------------------

const addCost = (run: Run, usd: number) => {
  run.cost = { ...run.cost, usd: (run.cost.usd ?? 0) + usd };
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

/** The most recent decided request on this ticket, as text for the next worker. */
const latestAnswer = (h: SessionHandle, ticketId: string): string | undefined => {
  const decided = h.inbox.requests.filter((r) => r.ticketId === ticketId && r.state !== "open").sort((a, b) => (b.decidedAt ?? "").localeCompare(a.decidedAt ?? ""));
  const r = decided[0];
  if (!r) return undefined;
  return `${r.id} (${r.detail.kind}) was ${r.state}${r.answer ? `: ${r.answer}` : ""}.`;
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

export const readWorkerStream = async (
  stdout: NodeJS.ReadableStream,
  onEvent: (e: VerstasEvent) => void,
): Promise<WorkerDone | undefined> => {
  let done: WorkerDone | undefined;
  const rl = readline.createInterface({ input: stdout, crlfDelay: Infinity });
  for await (const line of rl) {
    const e = parseWorkerLine(line);
    if (!e) continue;
    if (e.kind === "worker_done") done = e;
    else onEvent(e);
  }
  return done;
};

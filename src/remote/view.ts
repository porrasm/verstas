import type { Run, Session, Board, Inbox, VerstasEvent } from "../core/types.js";
import { isInitialized } from "../core/types.js";
import { packHosts } from "../network/packs.js";

/**
 * What a shared session looks like on the remote dashboard: the board, the
 * inbox, the run's state and a short activity log, every text capped. Tool
 * results, file contents, diffs and costs per call never leave; tool calls
 * show as one line ("Bash: npm test"). The shape is the dashboard's
 * VerstasRemoteSession (apps monorepo, common/src/apps/verstas.ts).
 */

export const REMOTE_PROTOCOL = 1;

/** Events kept per session for the activity tab. */
export const REMOTE_EVENTS = 80;

const cap = (s: string | undefined, n: number): string => {
  if (!s) return "";
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

export type RemoteEvent = { t: string; kind: string; ticket?: string; text: string; ok?: boolean };

/** One line per event worth showing; null for what never leaves (tool results, cost ticks). */
export const flattenEvent = (e: VerstasEvent): RemoteEvent | null => {
  const ticket = "ticket" in e ? e.ticket : undefined;
  const base = { t: e.t, kind: e.kind, ...(ticket ? { ticket } : {}) };
  switch (e.kind) {
    case "tool_result":
    case "cost":
      return null;
    case "text":
      return { ...base, text: cap(e.text, 300) };
    case "tool_use":
      return { ...base, text: cap(`${e.tool}: ${e.summary}`, 160) };
    case "status":
    case "error":
      return { ...base, text: cap(e.text, 400) };
    case "gate":
      return { ...base, text: cap(`${e.name}: ${e.summary}`, 300), ok: e.ok };
    case "ticket":
      return { ...base, text: cap(`${e.from} → ${e.to}${e.note ? `: ${e.note}` : ""}`, 300) };
    case "request":
      return { ...base, text: cap(`${e.requestId}: ${e.summary}`, 300) };
    case "run":
      return { ...base, text: `${e.state}${e.reason ? ` (${cap(e.reason, 200)})` : ""}` };
    case "denied_network":
      return { ...base, text: `blocked ${e.host}:${e.port}` };
    case "worker_done":
      return { ...base, text: `${e.role} finished: ${e.stopReason} · ${e.turns} turns · ${e.seconds} s`, ok: e.ok };
  }
};

export type RemoteSessionInput = {
  session: Session;
  board: Board;
  inbox: Inbox;
  /** The live run, or the last one. */
  run: Run | undefined;
  active: boolean;
  totals: { usd: number; runs: number; lastActivityAt: string };
  events: RemoteEvent[];
};

export const remoteSession = (x: RemoteSessionInput) => {
  const { session: s, board, inbox, run } = x;
  const open = inbox.requests.filter((r) => r.state === "open");
  const resolved = inbox.requests.filter((r) => r.state === "resolved").slice(-10);
  return {
    id: s.id,
    name: s.name,
    state: s.state,
    goal: cap(s.goal, 2000),
    createdAt: s.createdAt,
    ...(s.model ? { model: s.model } : {}),
    repos: s.repos.map((r) => r.name),
    requirements: cap(s.requirements, 4000),
    needsSetup: !isInitialized(s),
    initialized: isInitialized(s),
    ...(s.readiness
      ? {
          readiness: {
            verdict: s.readiness.verdict,
            at: s.readiness.at,
            summary: cap(s.readiness.summary, 2000),
            checks: s.readiness.checks.map((c) => ({ text: cap(c.text, 300), ok: c.ok })),
            ...(s.readiness.confirmedAt ? { confirmedAt: s.readiness.confirmedAt } : {}),
          },
        }
      : {}),
    active: x.active,
    ...(run
      ? {
          run: {
            id: run.id,
            state: run.state,
            startedAt: run.startedAt,
            ...(run.endedAt ? { endedAt: run.endedAt } : {}),
            ...(run.currentTicket ? { currentTicket: run.currentTicket } : {}),
            ticketsDone: run.ticketsDone,
            ...(run.pauseReason ? { pauseReason: run.pauseReason } : {}),
            ...(run.resumeAt ? { resumeAt: run.resumeAt } : {}),
            ...(run.cost.usd !== undefined ? { usd: run.cost.usd } : {}),
          },
        }
      : {}),
    totals: x.totals,
    caps: { budgetUsd: s.caps.budgetUsd, runTickets: s.caps.runTickets, reviewer: s.caps.reviewer },
    tickets: board.tickets.map((t) => ({
      id: t.id,
      title: t.title,
      kind: t.kind,
      state: t.state,
      priority: t.priority,
      size: t.size,
      ...(t.repo ? { repo: t.repo } : {}),
      deps: t.deps,
      attempts: t.attempts,
      spec: cap(t.spec, 4000),
      acceptance: t.acceptance.slice(0, 20).map((a) => cap(a, 500)),
      ...(t.report ? { report: cap(t.report, 4000) } : {}),
      ...(t.diff ? { diff: t.diff } : {}),
      ...(t.cost?.usd !== undefined ? { usd: t.cost.usd } : {}),
      notes: t.notes.slice(-8).map((n) => ({ at: n.at, by: n.by, text: cap(n.text, 600) })),
      updatedAt: t.updatedAt,
    })),
    requests: [...resolved, ...open].map((r) => ({
      id: r.id,
      ...(r.ticketId ? { ticketId: r.ticketId } : {}),
      summary: cap(r.summary, 2000),
      state: r.state,
      ...(r.halt ? { halt: { reason: cap(r.halt.reason, 2000), severity: r.halt.severity } } : {}),
      ...(r.answer ? { answer: cap(r.answer, 2000) } : {}),
      createdAt: r.createdAt,
      ...(r.decidedAt ? { decidedAt: r.decidedAt } : {}),
      actions: r.actions.map((a) => ({
        id: a.id,
        detail: a.detail.kind === "pack" ? { ...a.detail, hosts: packHosts([a.detail.pack]) } : a.detail,
        state: a.state,
        ...(a.outcome ? { outcome: cap(a.outcome, 500) } : {}),
      })),
    })),
    messages: inbox.messages.slice(-20).map((m) => ({ id: m.id, ...(m.ticketId ? { ticketId: m.ticketId } : {}), text: cap(m.text, 2000), createdAt: m.createdAt, read: m.read })),
    prompts: s.prompts.slice(-5).map((p) => ({ at: p.at, text: cap(p.text, 2000), reply: cap(p.reply, 4000), stopReason: p.stopReason })),
    events: x.events.slice(-REMOTE_EVENTS),
  };
};

export type RemoteSession = ReturnType<typeof remoteSession>;

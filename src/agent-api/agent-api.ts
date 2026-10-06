import crypto from "node:crypto";
import express, { type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import {
  actionDetailSchema,
  choreIdSchema,
  choreStateSchema,
  describeAgent,
  ideaSchema,
  messageSchema,
  now,
  requestOutcome,
  requestSchema,
  sweepResultSchema,
  ticketIdSchema,
  ticketImportSchema,
  type AgentRequest,
  type Inbox,
  type SweepResult,
  type Ticket,
} from "../core/types.js";
import { addChore, addNote, agentAddDep, agentSetPriority, beginSweep, BoardError, canStart, getTicket, importBoard, replaceTicket, sweepInFlight, sweepToJudging, transition, validateRepos, type AgentRole } from "../board/board.js";
import type { SessionHub } from "../sessions/hub.js";

/**
 * The agent API: what a worker inside the box may do to its session,
 * reachable only through the proxy under /agent/ with a run token. See
 * docs/SANDBOX.md Boundary 4. No route here touches sessions, Docker,
 * other runs, or the inbox's decisions.
 */

export type RunToken = { sessionId: string; runId: number; role: AgentRole; currentTicket?: string };

/**
 * What the run behind a lead's token does when the lead drives the board
 * (src/harness/run.ts implements it). Without it, claim, submit and
 * handoff are refused: there is no run to judge or hand over.
 */
export type AgentRunHooks = {
  /** The lead submitted the ticket it holds; the run judges it (gates, reviewer, commit, the move out of review). */
  submitted(run: RunToken, ticketId: string): void;
  /** The lead asked to end its worker and hand over to a fresh one with this note. */
  handoff(run: RunToken, note: string): void;
  /** Why the lead may not claim now (the run is pausing, the ticket cap is reached), or undefined. */
  claimRefusal?(run: RunToken): string | undefined;
  /** The lead filed a request or a halt on the ticket it holds; the run parks the ticket so the lead can move on. */
  requested?(run: RunToken, ticketId: string): void;
  /** The lead handed a ticket that names its own agent to the harness: a fresh implementer on that agent works it, then the judge. */
  delegated?(run: RunToken, ticketId: string): void;
  /** The lead took a batch of chores (board.sweep is now `working`). */
  sweepStarted?(run: RunToken, ids: string[]): void;
  /** The lead submitted its sweep with one result per chore; the run judges it (checks, size, commit) and settles the chores. */
  sweepSubmitted?(run: RunToken, results: SweepResult[]): void;
};

/** States in which a ticket still belongs to the lead that claimed it. */
const HELD = new Set(["in_progress", "review"]);

export class RunTokens {
  private tokens = new Map<string, RunToken>();
  issue(info: RunToken): string {
    const token = crypto.randomBytes(24).toString("base64url");
    this.tokens.set(token, info);
    return token;
  }
  update(token: string, patch: Partial<RunToken>): void {
    const cur = this.tokens.get(token);
    if (cur) this.tokens.set(token, { ...cur, ...patch });
  }
  revoke(token: string): void {
    this.tokens.delete(token);
  }
  revokeRun(sessionId: string, runId: number): void {
    for (const [t, info] of this.tokens) if (info.sessionId === sessionId && info.runId === runId) this.tokens.delete(t);
  }
  lookup(token: string): RunToken | undefined {
    return this.tokens.get(token);
  }
}

type AgentRequestWithRun = Request & { run: RunToken };

const nextId = (prefix: string, items: { id: string }[]): string =>
  `${prefix}-${items.reduce((m, i) => Math.max(m, Number(i.id.split("-")[1]) || 0), 0) + 1}`;

const summary = (t: Ticket) => ({
  id: t.id,
  title: t.title,
  state: t.state,
  kind: t.kind,
  size: t.size,
  priority: t.priority,
  deps: t.deps,
  repo: t.repo,
  pinned: t.pinned,
  agent: t.agent,
});

export const createAgentApi = (hub: SessionHub, tokens: RunTokens, hooks?: AgentRunHooks): express.Express => {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));

  const auth = (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const run = token && tokens.lookup(token);
    if (!run) {
      res.status(401).json({ error: "Missing or unknown run token" });
      return;
    }
    if (run.role !== "lead" || !run.currentTicket) {
      (req as AgentRequestWithRun).run = run;
      next();
      return;
    }
    // A lead's token keeps the last ticket it claimed. Once that ticket is
    // settled (done, back to ready, parked, blocked) the lead holds nothing,
    // and what it files next must not be attached to that ticket.
    hub
      .get(run.sessionId)
      .then((h) => {
        const t = h.board.tickets.find((x) => x.id === run.currentTicket);
        (req as AgentRequestWithRun).run = t && HELD.has(t.state) ? run : { ...run, currentTicket: undefined };
        next();
      })
      .catch(next);
  };

  const r = express.Router();
  r.use(auth);

  /** Claim, submit, handoff and sweeps are a lead's: a worker's ticket is chosen and judged by the loop. */
  const leadOnly = (req: AgentRequestWithRun, res: Response): boolean => {
    if (req.run.role !== "lead") {
      res.status(403).json({ error: "Only a lead claims, submits, sweeps and hands off; the harness moves your ticket for you" });
      return false;
    }
    if (!hooks) {
      res.status(409).json({ error: "No run is attached to this API; nothing can judge or hand over" });
      return false;
    }
    return true;
  };

  const wrap =
    (fn: (req: AgentRequestWithRun, res: Response) => Promise<void>) =>
    (req: Request, res: Response) => {
      fn(req as AgentRequestWithRun, res).catch((e: unknown) => {
        if (e instanceof z.ZodError) res.status(400).json({ error: `Invalid input: ${e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` });
        else if (e instanceof BoardError) res.status(e.code === "unknown_ticket" || e.code === "unknown_chore" ? 404 : e.code === "unknown_repo" ? 400 : e.code === "sweep_in_flight" || e.code === "no_sweep" ? 409 : 403).json({ error: e.message });
        else {
          console.error(`[agent] 500 ${req.method} ${req.originalUrl}:`, e);
          res.status(500).json({ error: (e as Error).message });
        }
      });
    };

  r.get(
    "/board",
    wrap(async (req, res) => {
      const h = await hub.get(req.run.sessionId);
      const state = typeof req.query.state === "string" ? req.query.state : undefined;
      const tickets = h.board.tickets.filter((t) => !state || t.state === state).map(summary);
      res.json({ goal: h.board.goal, currentTicket: req.run.currentTicket, tickets });
    }),
  );

  r.get(
    "/tickets/:id",
    wrap(async (req, res) => {
      const h = await hub.get(req.run.sessionId);
      const t = getTicket(h.board, ticketIdSchema.parse(req.params.id));
      res.json(t);
    }),
  );

  r.post(
    "/tickets",
    wrap(async (req, res) => {
      const input = ticketImportSchema.omit({ id: true, state: true, pinned: true }).parse(req.body);
      const h = await hub.get(req.run.sessionId);
      const result = await h.mutate((d) => {
        const r = importBoard(d.board, { tickets: [input] }, { by: "agent", role: req.run.role, defaultState: "backlog" });
        if (r.skipped.length) throw new BoardError(r.skipped[0]!.reason, "forbidden_kind");
        validateRepos(r.board.tickets, d.session.repos.map((x) => x.name), { ignoreDone: true });
        let board = r.board;
        const id = r.created[0]!;
        board = addNote(board, id, "harness", `Created by the ${req.run.role}${req.run.currentTicket ? ` while on ${req.run.currentTicket}` : ""}`);
        return { next: { board }, result: id };
      });
      res.status(201).json({ ok: true, id: result, state: "backlog" });
    }),
  );

  r.post(
    "/tickets/:id/notes",
    wrap(async (req, res) => {
      const { text } = z.object({ text: z.string().min(1).max(20_000) }).parse(req.body);
      const id = ticketIdSchema.parse(req.params.id);
      const h = await hub.get(req.run.sessionId);
      await h.mutate((d) => ({ next: { board: addNote(d.board, id, "agent", text) } }));
      res.json({ ok: true });
    }),
  );

  r.post(
    "/tickets/:id/report",
    wrap(async (req, res) => {
      const { report } = z.object({ report: z.string().min(1).max(20_000) }).parse(req.body);
      const id = ticketIdSchema.parse(req.params.id);
      const h = await hub.get(req.run.sessionId);
      await h.mutate((d) => {
        const t = getTicket(d.board, id);
        return { next: { board: replaceTicket(d.board, { ...t, report, updatedAt: now() }) } };
      });
      res.json({ ok: true });
    }),
  );

  r.post(
    "/tickets/:id/priority",
    wrap(async (req, res) => {
      const { priority, reason } = z.object({ priority: z.number().int().min(0).max(1000), reason: z.string().min(1).max(2000) }).parse(req.body);
      const id = ticketIdSchema.parse(req.params.id);
      const h = await hub.get(req.run.sessionId);
      await h.mutate((d) => ({ next: { board: agentSetPriority(d.board, id, priority, reason) } }));
      res.json({ ok: true });
    }),
  );

  r.post(
    "/tickets/:id/deps",
    wrap(async (req, res) => {
      const { dep, reason } = z.object({ dep: ticketIdSchema, reason: z.string().min(1).max(2000) }).parse(req.body);
      const id = ticketIdSchema.parse(req.params.id);
      const h = await hub.get(req.run.sessionId);
      await h.mutate((d) => ({ next: { board: agentAddDep(d.board, id, dep, reason) } }));
      res.json({ ok: true });
    }),
  );

  r.post(
    "/requests",
    wrap(async (req, res) => {
      const raw = req.body as { actions?: { kind?: unknown }[] } | undefined;
      if (Array.isArray(raw?.actions) && raw.actions.some((a) => a?.kind === "root_script")) {
        res.status(400).json({ error: "root_script is retired: you have passwordless sudo. Run the install yourself, append it to /workspace/notes/setup.sh, and note it in /workspace/notes/env.md." });
        return;
      }
      const { summary, actions } = z.object({ summary: z.string().min(1).max(8000), actions: z.array(actionDetailSchema).max(20).default([]) }).parse(req.body);
      const h = await hub.get(req.run.sessionId);
      const created = await h.mutate((d) => {
        const request: AgentRequest = requestSchema.parse({
          id: nextId("R", d.inbox.requests),
          ticketId: req.run.currentTicket,
          summary,
          actions: actions.map((detail, i) => ({ id: `a${i + 1}`, detail, state: "open" })),
          state: "open",
          createdAt: now(),
        });
        const inbox: Inbox = { ...d.inbox, requests: [...d.inbox.requests, request] };
        let board = d.board;
        if (req.run.currentTicket) {
          board = addNote(board, req.run.currentTicket, "agent", `Request ${request.id} (${request.actions.map((a) => a.detail.kind).join(", ") || "question"}): ${summary.slice(0, 500)}`);
        }
        return { next: { inbox, board }, result: request };
      });
      res.status(201).json({
        ok: true,
        id: created.id,
        actions: created.actions.map((a) => a.id),
        next:
          req.run.role === "lead"
            ? "The ticket parks until the user has decided every action; claiming it again later gives you the outcomes. Leave it and claim another ticket."
            : "Stop working on this ticket now and reply with a short status. The ticket resumes when the user has decided every action; the next worker gets the outcomes.",
      });
      if (req.run.role === "lead" && req.run.currentTicket) hooks?.requested?.(req.run, req.run.currentTicket);
    }),
  );

  r.post(
    "/halt",
    wrap(async (req, res) => {
      const { reason, severity } = z.object({ reason: z.string().min(1).max(5000), severity: z.enum(["major", "critical"]) }).parse(req.body);
      const h = await hub.get(req.run.sessionId);
      const created = await h.mutate((d) => {
        const request: AgentRequest = requestSchema.parse({
          id: nextId("R", d.inbox.requests),
          ticketId: req.run.currentTicket,
          summary: `Halt (${severity}): ${reason}`,
          actions: [],
          halt: { reason, severity },
          state: "open",
          createdAt: now(),
        });
        let board = d.board;
        if (req.run.currentTicket) board = addNote(board, req.run.currentTicket, "agent", `Halt requested (${severity}): ${reason.slice(0, 500)}`);
        return { next: { inbox: { ...d.inbox, requests: [...d.inbox.requests, request] }, board }, result: request };
      });
      res.status(201).json({ ok: true, id: created.id, next: "The run pauses after you finish. Stop now and reply with what you found." });
      if (req.run.role === "lead" && req.run.currentTicket) hooks?.requested?.(req.run, req.run.currentTicket);
    }),
  );

  r.post(
    "/messages",
    wrap(async (req, res) => {
      const { text } = z.object({ text: z.string().min(1).max(10_000) }).parse(req.body);
      const h = await hub.get(req.run.sessionId);
      const id = await h.mutate((d) => {
        const m = messageSchema.parse({ id: nextId("M", d.inbox.messages), ticketId: req.run.currentTicket, text, createdAt: now(), read: false });
        return { next: { inbox: { ...d.inbox, messages: [...d.inbox.messages, m] } }, result: m.id };
      });
      res.status(201).json({ ok: true, id });
    }),
  );

  r.post(
    "/ideas",
    wrap(async (req, res) => {
      const { title, pitch } = z.object({ title: z.string().min(1).max(200), pitch: z.string().min(1).max(10_000) }).parse(req.body);
      const h = await hub.get(req.run.sessionId);
      const id = await h.mutate((d) => {
        const i = ideaSchema.parse({ id: nextId("I", d.inbox.ideas), ticketId: req.run.currentTicket, title, pitch, createdAt: now() });
        return { next: { inbox: { ...d.inbox, ideas: [...d.inbox.ideas, i] } }, result: i.id };
      });
      res.status(201).json({ ok: true, id, note: "Kept in the ideas list for the user. Do not implement it." });
    }),
  );

  // --- Chores: small fixes outside the ticket flow ---------------------------

  r.get(
    "/chores",
    wrap(async (req, res) => {
      const h = await hub.get(req.run.sessionId);
      const state = typeof req.query.state === "string" ? choreStateSchema.parse(req.query.state) : undefined;
      const chores = h.board.chores.filter((c) => !state || c.state === state).map(({ id, text, where, repo, state: st, by, fromTicket, outcome, promotedTo }) => ({ id, text, where, repo, state: st, by, fromTicket, outcome, promotedTo }));
      res.json({ chores, sweep: h.board.sweep ?? null, approvalRequired: h.session.caps.choreApproval });
    }),
  );

  r.post(
    "/chores",
    wrap(async (req, res) => {
      const input = z.object({ text: z.string().min(1).max(2000), where: z.string().max(500).optional(), repo: z.string().min(1).max(100).optional() }).parse(req.body);
      const h = await hub.get(req.run.sessionId);
      const out = await h.mutate((d) => {
        if (input.repo && !d.session.repos.some((x) => x.name === input.repo)) throw new BoardError(`No repository ${input.repo} in this session (${d.session.repos.map((x) => x.name).join(", ") || "none"})`, "unknown_repo");
        const r = addChore(d.board, input, "agent", { fromTicket: req.run.currentTicket, state: d.session.caps.choreApproval ? "proposed" : "open" });
        return { next: { board: r.board }, result: { id: r.id, state: d.session.caps.choreApproval ? "proposed" : "open" } };
      });
      res.status(201).json({ ok: true, ...out, note: out.state === "proposed" ? "Kept for the user's approval; a sweep takes it once approved." : "On the chore list; a lead sweeps it in a batch." });
    }),
  );

  r.get(
    "/chores/sweep",
    wrap(async (req, res) => {
      const h = await hub.get(req.run.sessionId);
      const sw = h.board.sweep;
      if (!sw) {
        res.json({ state: "none" });
        return;
      }
      const chores = h.board.chores.filter((c) => sw.ids.includes(c.id)).map(({ id, state, outcome, promotedTo }) => ({ id, state, outcome, promotedTo }));
      res.json({ ...sw, chores });
    }),
  );

  r.post(
    "/chores/sweep",
    wrap(async (req, res) => {
      if (!leadOnly(req, res)) return;
      const { ids, max } = z.object({ ids: z.array(choreIdSchema).max(50).optional(), max: z.number().int().min(1).max(50).optional() }).parse(req.body ?? {});
      const refusal = hooks!.claimRefusal?.(req.run);
      if (refusal) {
        res.status(409).json({ error: refusal });
        return;
      }
      const h = await hub.get(req.run.sessionId);
      const out = await h.mutate((d) => {
        const held = req.run.currentTicket ? d.board.tickets.find((t) => t.id === req.run.currentTicket && HELD.has(t.state)) : undefined;
        if (held) throw new BoardError(`You hold ${held.id} (${held.state}); a sweep is its own commit, so submit the ticket first`, "forbidden_move");
        const r = beginSweep(d.board, { ids, max });
        return { next: { board: r.board }, result: r };
      });
      hooks!.sweepStarted?.(req.run, out.sweep.ids);
      res.json({
        ok: true,
        sweep: out.sweep.n,
        chores: out.chores.map(({ id, text, where, repo, fromTicket, by }) => ({ id, text, where, repo, fromTicket, by })),
        limits: { maxLines: h.session.caps.sweepMaxLines, maxFiles: h.session.caps.sweepMaxFiles },
        next: "Do each chore (or decide to drop or promote it), run the repository's own checks, then chores_submit with one line per chore. The batch becomes one commit; keep it under the limits or it is refused.",
      });
    }),
  );

  r.post(
    "/chores/sweep/submit",
    wrap(async (req, res) => {
      if (!leadOnly(req, res)) return;
      const { results } = z.object({ results: z.array(sweepResultSchema).max(50).default([]) }).parse(req.body ?? {});
      const h = await hub.get(req.run.sessionId);
      await h.mutate((d) => {
        const live = sweepInFlight(d.board);
        if (!live) throw new BoardError("No sweep is in flight; start one with chores_sweep", "no_sweep");
        const unknown = results.map((r) => r.id).filter((id) => !live.ids.includes(id));
        if (unknown.length) throw new BoardError(`${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not in this sweep (${live.ids.join(", ")})`, "chore_state");
        return { next: { board: sweepToJudging(d.board) } };
      });
      hooks!.sweepSubmitted?.(req.run, results);
      res.json({ ok: true, state: "judging", next: "The harness runs the checks and the size check, then commits or refuses. Poll chores_sweep status, or wait with chores_submit." });
    }),
  );

  // --- A lead drives the board: claim, submit, hand off ----------------------
  // Only a lead's token may; a worker's ticket is chosen and judged by the loop.


  r.post(
    "/tickets/:id/claim",
    wrap(async (req, res) => {
      if (!leadOnly(req, res)) return;
      const id = ticketIdSchema.parse(req.params.id);
      const token = (req.headers.authorization ?? "").slice(7);
      const refusal = hooks!.claimRefusal?.(req.run);
      if (refusal) {
        res.status(409).json({ error: refusal });
        return;
      }
      const h = await hub.get(req.run.sessionId);
      await h.mutate((d) => {
        const held = req.run.currentTicket ? d.board.tickets.find((t) => t.id === req.run.currentTicket && HELD.has(t.state)) : undefined;
        if (held && held.id !== id) throw new BoardError(`You hold ${held.id} (${held.state}); submit it, or note why it is stuck, before claiming another`, "forbidden_move");
        const sweeping = sweepInFlight(d.board);
        if (sweeping) throw new BoardError(`Sweep ${sweeping.n} is ${sweeping.state}; finish it with chores_submit before claiming a ticket`, "forbidden_move");
        const t = getTicket(d.board, id);
        if (t.state !== "ready") throw new BoardError(`${id} is ${t.state}, not ready`, "illegal_transition");
        if (!canStart(d.board, t)) {
          const open = t.deps.filter((dep) => !d.board.tickets.some((x) => x.id === dep && x.state === "done"));
          throw new BoardError(`${id} waits on ${open.join(", ")}, not done yet`, "illegal_transition");
        }
        if (t.agent) throw new BoardError(`${id} runs on its own agent (${describeAgent(t.agent)}): hand it over with board_run when you hold nothing, instead of claiming it`, "forbidden_move");
        return { next: { board: transition(d.board, id, "in_progress", { by: "agent", text: `Claimed by the lead (judged attempts so far: ${t.attempts})` }) } };
      });
      tokens.update(token, { currentTicket: id });
      // A ticket that waited on the user comes back with the outcome.
      const answered = h.inbox.requests.filter((x) => x.ticketId === id && x.state !== "open").at(-1);
      res.json({ ok: true, id, state: "in_progress", ...(answered ? { answer: requestOutcome(answered) } : {}) });
    }),
  );

  /** A ticket with its own agent: the lead does not work it; the harness runs a fresh implementer on that agent, then the judge, while the lead waits. */
  r.post(
    "/tickets/:id/run",
    wrap(async (req, res) => {
      if (!leadOnly(req, res)) return;
      const id = ticketIdSchema.parse(req.params.id);
      const refusal = hooks!.claimRefusal?.(req.run);
      if (refusal) {
        res.status(409).json({ error: refusal });
        return;
      }
      if (!hooks!.delegated) {
        res.status(409).json({ error: "This run cannot hand tickets to another agent" });
        return;
      }
      const h = await hub.get(req.run.sessionId);
      const agent = await h.mutate((d) => {
        const held = req.run.currentTicket ? d.board.tickets.find((t) => t.id === req.run.currentTicket && HELD.has(t.state)) : undefined;
        if (held) throw new BoardError(`You hold ${held.id} (${held.state}); the other agent needs the working tree to itself, so submit first`, "forbidden_move");
        const sweeping = sweepInFlight(d.board);
        if (sweeping) throw new BoardError(`Sweep ${sweeping.n} is ${sweeping.state}; finish it with chores_submit first`, "forbidden_move");
        const t = getTicket(d.board, id);
        if (!t.agent) throw new BoardError(`${id} names no agent of its own; claim it and do it yourself`, "forbidden_move");
        if (t.state !== "ready") throw new BoardError(`${id} is ${t.state}, not ready`, "illegal_transition");
        if (!canStart(d.board, t)) {
          const open = t.deps.filter((dep) => !d.board.tickets.some((x) => x.id === dep && x.state === "done"));
          throw new BoardError(`${id} waits on ${open.join(", ")}, not done yet`, "illegal_transition");
        }
        return { next: { board: transition(d.board, id, "in_progress", { by: "agent", text: `Handed to its own agent (${describeAgent(t.agent)}) by the lead` }) }, result: t.agent };
      });
      hooks!.delegated(req.run, id);
      res.json({ ok: true, id, state: "in_progress", agent, next: "A fresh worker on that agent does the ticket and the reviewer judges it. Wait for the verdict (board_run waits for you); claim nothing meanwhile." });
    }),
  );

  r.post(
    "/tickets/:id/submit",
    wrap(async (req, res) => {
      if (!leadOnly(req, res)) return;
      const id = ticketIdSchema.parse(req.params.id);
      if (req.run.currentTicket !== id) throw new BoardError(`You do not hold ${id}; claim it first`, "forbidden_move");
      const h = await hub.get(req.run.sessionId);
      await h.mutate((d) => {
        const t = getTicket(d.board, id);
        if (t.state !== "in_progress") throw new BoardError(`${id} is ${t.state}, not in progress`, "illegal_transition");
        if (!t.report?.trim()) throw new BoardError(`File your report for ${id} with board_report before submitting`, "forbidden_move");
        return { next: { board: transition(d.board, id, "review", { by: "agent", text: "Submitted for review by the lead" }) } };
      });
      hooks!.submitted(req.run, id);
      res.json({ ok: true, id, state: "review" });
    }),
  );

  r.post(
    "/handoff",
    wrap(async (req, res) => {
      if (!leadOnly(req, res)) return;
      const { note } = z.object({ note: z.string().min(1).max(20_000) }).parse(req.body);
      hooks!.handoff(req.run, note);
      res.json({ ok: true, next: "Stop now: end your turn with one line. A fresh lead starts with your note and the board." });
    }),
  );

  app.use("/agent", r);
  app.use((_req, res) => res.status(404).json({ error: "Not found" }));
  return app;
};

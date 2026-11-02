import crypto from "node:crypto";
import express, { type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import {
  actionDetailSchema,
  choreIdSchema,
  choreStateSchema,
  ideaSchema,
  messageSchema,
  now,
  requestOutcome,
  requestSchema,
  sweepResultSchema,
  ticketIdSchema,
  ticketImportSchema,
  ticketKindSchema,
  ticketSizeSchema,
  ticketStateSchema,
  importRepos,
  type AgentRequest,
  type Board,
  type Inbox,
  type SweepResult,
  type Ticket,
} from "../core/types.js";
import { addChore, addNote, agentAddDep, agentSetPriority, beginSweep, BoardError, deleteTicket, editTicket, getTicket, importBoard, openChores, replaceTicket, setChoreState, sweepInFlight, sweepToJudging, transition, validateRepos, type AgentRole } from "../board/board.js";
import type { SessionHub } from "../sessions/hub.js";
import type { Artifact } from "../sessions/artifacts.js";

/**
 * The agent API: what a worker inside the box may do to its session,
 * reachable only through the proxy under /agent/ with a run token. See
 * docs/SANDBOX.md Boundary 4. No route here touches sessions, Docker,
 * other runs, or the inbox's decisions.
 */

export type RunToken = {
  sessionId: string;
  runId: number;
  role: AgentRole;
  currentTicket?: string;
  /** The worker's job (setup, implementer, reviewer…); `role` is coarser. */
  job?: string;
};

/**
 * What the run behind the lead's token does when the lead drives the board
 * (src/harness/run.ts implements it). Without it, moves, `done` and
 * handoff are refused: there is no run to judge or hand over.
 */
export type AgentRunHooks = {
  /** The lead moved a ticket to review; the run judges it (the reviewer, the move out of review). */
  submitted(run: RunToken, ticketId: string): void;
  /** The lead asked to end its life and hand over to a fresh lead with this note. */
  handoff(run: RunToken, note: string): void;
  /** The lead says the goal is met (or the board is finished), with its assessment; the run ends after this life when nothing is left to start. */
  done?(run: RunToken, note: string): void;
  /** Why the lead may not start another ticket now (the run is pausing, it handed off), or undefined. */
  moveRefusal?(run: RunToken): string | undefined;
  /** The lead filed a request or a halt on a ticket in progress; the run parks that ticket so the lead can move on. */
  requested?(run: RunToken, ticketId: string): void;
  /** Each repository's HEAD now: the baseline of a ticket entering in_progress, which the review reads from. */
  baseline?(sessionId: string): Promise<Record<string, string>>;
  /** The lead took a batch of chores (board.sweep is now `working`). */
  sweepStarted?(run: RunToken, ids: string[]): void;
  /** The lead submitted its sweep with one result per chore; the run judges it (size, the reviewer, commit) and settles the chores. */
  sweepSubmitted?(run: RunToken, results: SweepResult[]): void;
  /** What the judge would see if the change were submitted now: touched repositories and the review level. */
  previewJudging?(sessionId: string, ticketId?: string): Promise<unknown>;
  /** An agent published a file from the box for the user (src/sessions/artifacts.ts). */
  publishArtifact?(run: RunToken, boxPath: string, name?: string): Promise<Artifact>;
};

/** States in which a ticket is the lead's current one: what it files attaches to it. */
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
  repos: t.repos,
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
    // The lead's token keeps the last ticket it moved into progress. Once
    // that ticket is settled (done, back to ready, parked, blocked) what the
    // lead files next must not be attached to it.
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

  /** Moving tickets, handoff, done and sweeps are the lead's: nobody else works the board. */
  const leadOnly = (req: AgentRequestWithRun, res: Response): boolean => {
    if (req.run.role !== "lead") {
      res.status(403).json({ error: "Only the lead moves tickets, sweeps and hands off" });
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
      const input = ticketImportSchema.omit({ id: true, state: true, pinned: true, review: true }).parse(req.body);
      // The lead owns the board and may start a ticket at once; the agent in your terminal makes one ready when you ask; other workers file into the backlog.
      const asked = z.object({ state: z.enum(["backlog", "ready", "in_progress"]).optional() }).parse(req.body).state;
      const state = req.run.role === "lead" ? (asked ?? "backlog") : req.run.role === "terminal" && asked !== "in_progress" ? (asked ?? "backlog") : "backlog";
      const h = await hub.get(req.run.sessionId);
      const baseline = state === "in_progress" ? await hooks?.baseline?.(req.run.sessionId).catch(() => undefined) : undefined;
      const result = await h.mutate((d) => {
        const r = importBoard(d.board, { tickets: [input] }, { by: "agent", role: req.run.role, defaultState: state === "in_progress" ? "ready" : state });
        validateRepos(r.board.tickets, d.session.repos.map((x) => x.name), { ignoreDone: true });
        let board = r.board;
        const id = r.created[0]!;
        board = addNote(board, id, "harness", `Created by the ${req.run.role === "terminal" ? "agent in your terminal" : req.run.role}${req.run.currentTicket ? ` while on ${req.run.currentTicket}` : ""}`);
        if (state === "in_progress") {
          board = transition(board, id, "in_progress", { by: "agent", text: "Started by the lead as it was created" });
          if (baseline) board = replaceTicket(board, { ...getTicket(board, id), baseline });
        }
        return { next: { board }, result: id };
      });
      if (state === "in_progress") tokens.update((req.headers.authorization ?? "").slice(7), { currentTicket: result });
      res.status(201).json({ ok: true, id: result, state });
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

  /** The agent in your terminal has you at the keyboard: it asks you there instead of parking anything. */
  const notFromTerminal = (req: AgentRequestWithRun, res: Response): boolean => {
    if (req.run.role !== "terminal") return true;
    res.status(403).json({ error: "You are in a terminal with the user at the keyboard: ask them directly instead" });
    return false;
  };

  /** Editing and deleting tickets is the lead's (it owns the board) and the terminal agent's (you are at the keyboard with it). */
  const mayEdit = (req: AgentRequestWithRun, res: Response): boolean => {
    if (req.run.role === "terminal" || req.run.role === "lead") return true;
    res.status(403).json({ error: "Only the lead and the agent in the user's terminal edit or delete tickets; file a note or a ticket instead" });
    return false;
  };

  r.patch(
    "/tickets/:id",
    wrap(async (req, res) => {
      if (!mayEdit(req, res)) return;
      const body = z
        .object({
          title: z.string().min(1).max(200).optional(),
          kind: ticketKindSchema.optional(),
          spec: z.string().max(50_000).optional(),
          acceptance: z.array(z.string().min(1).max(2000)).optional(),
          size: ticketSizeSchema.optional(),
          repos: z.array(z.string().min(1).max(100)).max(20).optional(),
          /** The older single-repository form. */
          repo: z.string().min(1).max(100).optional(),
          deps: z.array(ticketIdSchema).optional(),
          priority: z.number().int().min(0).max(1000).optional(),
          state: z.enum(["backlog", "ready"]).optional(),
          reason: z.string().min(1).max(2000),
        })
        .parse(req.body);
      const { reason, repo, ...rest } = body;
      const patch = { ...rest, repos: importRepos({ repos: rest.repos, repo }) };
      const id = ticketIdSchema.parse(req.params.id);
      const h = await hub.get(req.run.sessionId);
      const t = await h.mutate((d) => {
        const board = editTicket(d.board, id, patch, reason);
        validateRepos(board.tickets.filter((x) => x.id === id), d.session.repos.map((x) => x.name));
        return { next: { board }, result: getTicket(board, id) };
      });
      res.json({ ok: true, id, state: t.state });
    }),
  );

  r.delete(
    "/tickets/:id",
    wrap(async (req, res) => {
      if (!mayEdit(req, res)) return;
      const { reason, replacedBy } = z.object({ reason: z.string().min(1).max(2000), replacedBy: ticketIdSchema.optional() }).parse(req.body ?? {});
      const id = ticketIdSchema.parse(req.params.id);
      const h = await hub.get(req.run.sessionId);
      await h.mutate((d) => ({ next: { board: deleteTicket(d.board, id, reason, replacedBy) } }));
      res.json({ ok: true, deleted: id, replacedBy });
    }),
  );

  r.post(
    "/requests",
    wrap(async (req, res) => {
      if (!notFromTerminal(req, res)) return;
      const raw = req.body as { actions?: { kind?: unknown }[] } | undefined;
      if (Array.isArray(raw?.actions) && raw.actions.some((a) => a?.kind === "root_script")) {
        res.status(400).json({ error: "root_script is retired: you have passwordless sudo. Run the install yourself, append it to /workspace/notes/setup.sh, and note it in /workspace/notes/env.md." });
        return;
      }
      const { summary, actions, ticket: named } = z.object({ summary: z.string().min(1).max(8000), actions: z.array(actionDetailSchema).max(20).default([]), ticket: ticketIdSchema.optional() }).parse(req.body);
      const h = await hub.get(req.run.sessionId);
      // The lead names the ticket the request is about when it has several in progress; else the one it last started.
      const ticketId = named && h.board.tickets.some((t) => t.id === named && HELD.has(t.state)) ? named : req.run.currentTicket;
      const created = await h.mutate((d) => {
        const request: AgentRequest = requestSchema.parse({
          id: nextId("R", d.inbox.requests),
          ticketId,
          summary,
          actions: actions.map((detail, i) => ({ id: `a${i + 1}`, detail, state: "open" })),
          state: "open",
          createdAt: now(),
        });
        const inbox: Inbox = { ...d.inbox, requests: [...d.inbox.requests, request] };
        let board = d.board;
        if (ticketId) {
          board = addNote(board, ticketId, "agent", `Request ${request.id} (${request.actions.map((a) => a.detail.kind).join(", ") || "question"}): ${summary.slice(0, 500)}`);
        }
        return { next: { inbox, board }, result: request };
      });
      res.status(201).json({
        ok: true,
        id: created.id,
        actions: created.actions.map((a) => a.id),
        next:
          req.run.role === "lead"
            ? ticketId
              ? `${ticketId} parks until the user has decided every action; moving it to in_progress again later gives you the outcomes. Carry on with other work, or stop if nothing else can be done.`
              : "Bring notes/state.md up to date, then carry on with other work, or stop and reply with one line if nothing else can be done; the run pauses until the user has decided every action, and the outcomes are in your next prompt."
            : "Stop working now and reply with a short status. The run continues when the user has decided every action.",
      });
      if (req.run.role === "lead" && ticketId) hooks?.requested?.(req.run, ticketId);
    }),
  );

  r.post(
    "/halt",
    wrap(async (req, res) => {
      if (!notFromTerminal(req, res)) return;
      const { reason, severity, ticket: named } = z.object({ reason: z.string().min(1).max(5000), severity: z.enum(["major", "critical"]), ticket: ticketIdSchema.optional() }).parse(req.body);
      const h = await hub.get(req.run.sessionId);
      const ticketId = named && h.board.tickets.some((t) => t.id === named && HELD.has(t.state)) ? named : req.run.currentTicket;
      const created = await h.mutate((d) => {
        const request: AgentRequest = requestSchema.parse({
          id: nextId("R", d.inbox.requests),
          ticketId,
          summary: `Halt (${severity}): ${reason}`,
          actions: [],
          halt: { reason, severity },
          state: "open",
          createdAt: now(),
        });
        let board = d.board;
        if (ticketId) board = addNote(board, ticketId, "agent", `Halt requested (${severity}): ${reason.slice(0, 500)}`);
        return { next: { inbox: { ...d.inbox, requests: [...d.inbox.requests, request] }, board }, result: request };
      });
      res.status(201).json({ ok: true, id: created.id, next: "The run pauses after you finish. Stop now and reply with what you found." });
      if (req.run.role === "lead" && ticketId) hooks?.requested?.(req.run, ticketId);
    }),
  );

  r.get(
    "/changes",
    wrap(async (req, res) => {
      if (!hooks?.previewJudging) {
        res.status(409).json({ error: "No run is attached to look at the working tree" });
        return;
      }
      const asked = typeof req.query.ticket === "string" ? ticketIdSchema.parse(req.query.ticket) : undefined;
      res.json(await hooks.previewJudging(req.run.sessionId, asked ?? req.run.currentTicket));
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

  /** A file from the box for the user to view or download, when the user asked for one. Any role. */
  r.post(
    "/artifacts",
    wrap(async (req, res) => {
      if (!hooks?.publishArtifact) {
        res.status(409).json({ error: "No run is attached to this API; nothing can copy the file" });
        return;
      }
      const { path: boxPath, name } = z.object({ path: z.string().min(1).max(4096), name: z.string().min(1).max(200).optional() }).parse(req.body);
      try {
        const a = await hooks.publishArtifact(req.run, boxPath, name);
        res.status(201).json({ ok: true, name: a.name, bytes: a.bytes, kind: a.kind, note: a.kind === "file" ? "Shown to the user on the session page as a download (no preview for this kind of file)." : "Shown to the user on the session page, with a preview." });
      } catch (e) {
        res.status(400).json({ error: (e as Error).message });
      }
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
      res.json({ chores, sweep: h.board.sweep ?? null, approvalRequired: h.session.caps.choreApproval, sweepAt: h.session.caps.choreSweepAt || null, open: openChores(h.board).length });
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

  /** Anyone may drop an open chore that is moot or not worth doing; the reason stays with it. A chore in a sweep is settled by chores_submit. */
  r.post(
    "/chores/:id/drop",
    wrap(async (req, res) => {
      const id = choreIdSchema.parse(req.params.id);
      const { reason } = z.object({ reason: z.string().min(1).max(2000) }).parse(req.body);
      const h = await hub.get(req.run.sessionId);
      await h.mutate((d) => ({ next: { board: setChoreState(d.board, id, "dropped", `Dropped by the ${req.run.role}${req.run.currentTicket ? ` on ${req.run.currentTicket}` : ""}: ${reason.trim()}`) } }));
      res.json({ ok: true, id, state: "dropped" });
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
      const refusal = hooks!.moveRefusal?.(req.run);
      if (refusal) {
        res.status(409).json({ error: refusal });
        return;
      }
      const h = await hub.get(req.run.sessionId);
      const out = await h.mutate((d) => {
        const held = d.board.tickets.filter((t) => HELD.has(t.state));
        if (held.length) throw new BoardError(`${held.map((t) => `${t.id} (${t.state})`).join(", ")} ${held.length === 1 ? "is" : "are"} in progress; a sweep is its own commit, so finish those first`, "forbidden_move");
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
      res.json({ ok: true, state: "judging", next: "The harness runs the size check and the session's reviewer, then commits or refuses. Poll chores_sweep status, or wait with chores_submit." });
    }),
  );

  // --- The lead drives the board: move, hand off, done -----------------------
  // Only the lead's token may; the harness moves a ticket only out of review
  // (the verdict) and into waiting (a request).

  /**
   * A move the lead makes itself. Any transition the board allows, except:
   * out of review (the reviewer is reading it), into waiting (that is what a
   * request does), and into done while the session has a reviewer (done
   * comes from the verdict). Into in_progress records the baseline the
   * review reads from; into review hands the ticket to the judge.
   */
  r.post(
    "/tickets/:id/move",
    wrap(async (req, res) => {
      if (!leadOnly(req, res)) return;
      const id = ticketIdSchema.parse(req.params.id);
      const { to, note } = z.object({ to: ticketStateSchema, note: z.string().max(2000).optional() }).parse(req.body ?? {});
      const token = (req.headers.authorization ?? "").slice(7);
      if (to === "in_progress") {
        const refusal = hooks!.moveRefusal?.(req.run);
        if (refusal) {
          res.status(409).json({ error: refusal });
          return;
        }
      }
      const h = await hub.get(req.run.sessionId);
      const current = getTicket(h.board, id);
      if (current.state === to) {
        res.json({ ok: true, id, state: to, note: `${id} is already ${to}` });
        return;
      }
      const reviewerOn = h.session.caps.reviewer;
      // Read before the mutate (it asks the box); kept when the ticket already has one, so a requeued ticket's earlier commits stay in its review.
      const baseline = to === "in_progress" && !current.baseline ? await hooks!.baseline?.(req.run.sessionId).catch(() => undefined) : undefined;
      await h.mutate((d) => {
        const t = getTicket(d.board, id);
        if (t.state === "review") throw new BoardError(`${id} is in review: the reviewer is reading it; wait for the verdict`, "forbidden_move");
        if (to === "waiting") throw new BoardError("A ticket goes to waiting when you file a request on it; file the request instead", "forbidden_move");
        if (to === "done" && reviewerOn) throw new BoardError(`${id} reaches done through review: move it to review, and the reviewer's verdict moves it on`, "forbidden_move");
        let board = transition(d.board, id, to, { by: "agent", text: `Moved to ${to} by the lead${note?.trim() ? `: ${note.trim()}` : ""}` });
        if (baseline) board = replaceTicket(board, { ...getTicket(board, id), baseline });
        return { next: { board } };
      });
      if (to === "in_progress") tokens.update(token, { currentTicket: id });
      if (to === "review") hooks!.submitted(req.run, id);
      // A ticket that waited on the user comes back with the outcome.
      const answered = to === "in_progress" ? h.inbox.requests.filter((x) => x.ticketId === id && x.state !== "open").at(-1) : undefined;
      res.json({ ok: true, id, state: to, ...(answered ? { answer: requestOutcome(answered) } : {}), ...(to === "review" ? { next: "The reviewer reads the change; the ticket leaves review when the verdict is in." } : {}) });
    }),
  );

  r.post(
    "/handoff",
    wrap(async (req, res) => {
      if (!leadOnly(req, res)) return;
      const { note } = z.object({ note: z.string().min(1).max(20_000) }).parse(req.body);
      hooks!.handoff(req.run, note);
      res.json({ ok: true, next: "Stop now: end your turn with one line. A fresh lead starts with your note (now notes/state.md), the notes directory, the goal and the board." });
    }),
  );

  /** The lead's claim that the goal is met and the board is finished. Recorded by the run; the run ends after this life when nothing is left to start. */
  r.post(
    "/done",
    wrap(async (req, res) => {
      if (!leadOnly(req, res)) return;
      if (!hooks!.done) {
        res.status(409).json({ error: "This run cannot record the goal as met" });
        return;
      }
      const { note } = z.object({ note: z.string().min(1).max(8000) }).parse(req.body);
      hooks!.done(req.run, note);
      res.json({ ok: true, next: "Stop now: end your turn with one line. The run ends after this life (unless tickets are still ready, in which case the next lead works them) and the user reads your assessment." });
    }),
  );

  app.use("/agent", r);
  app.use((_req, res) => res.status(404).json({ error: "Not found" }));
  return app;
};

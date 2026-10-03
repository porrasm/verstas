import crypto from "node:crypto";
import express, { type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import {
  ideaSchema,
  messageSchema,
  now,
  requestDetailSchema,
  requestSchema,
  ticketIdSchema,
  ticketImportSchema,
  type AgentRequest,
  type Inbox,
  type Ticket,
} from "../core/types.js";
import { addNote, agentAddDep, agentSetPriority, BoardError, getTicket, importBoard, replaceTicket, validateRepos } from "../board/board.js";
import type { SessionHub } from "../sessions/hub.js";

/**
 * The agent API: what a worker inside the box may do to its session,
 * reachable only through the proxy under /agent/ with a run token. See
 * docs/SANDBOX.md Boundary 4. No route here touches sessions, Docker,
 * other runs, or the inbox's decisions.
 */

export type RunToken = { sessionId: string; runId: number; role: "worker" | "planner"; currentTicket?: string };

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
});

export const createAgentApi = (hub: SessionHub, tokens: RunTokens): express.Express => {
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
    (req as AgentRequestWithRun).run = run;
    next();
  };

  const r = express.Router();
  r.use(auth);

  const wrap =
    (fn: (req: AgentRequestWithRun, res: Response) => Promise<void>) =>
    (req: Request, res: Response) => {
      fn(req as AgentRequestWithRun, res).catch((e: unknown) => {
        if (e instanceof z.ZodError) res.status(400).json({ error: `Invalid input: ${e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` });
        else if (e instanceof BoardError) res.status(e.code === "unknown_ticket" ? 404 : e.code === "unknown_repo" ? 400 : 403).json({ error: e.message });
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
      const { detail, why } = z.object({ detail: requestDetailSchema, why: z.string().min(1).max(5000) }).parse(req.body);
      const h = await hub.get(req.run.sessionId);
      const created = await h.mutate((d) => {
        const request: AgentRequest = requestSchema.parse({
          id: nextId("R", d.inbox.requests),
          ticketId: req.run.currentTicket,
          detail,
          why,
          state: "open",
          createdAt: now(),
        });
        const inbox: Inbox = { ...d.inbox, requests: [...d.inbox.requests, request] };
        let board = d.board;
        if (req.run.currentTicket) {
          board = addNote(board, req.run.currentTicket, "agent", `Request ${request.id} (${detail.kind}): ${why}`);
        }
        return { next: { inbox, board }, result: request };
      });
      res.status(201).json({
        ok: true,
        id: created.id,
        next: detail.kind === "halt" ? "The run will pause after you finish. Stop now and reply with what you found." : "Stop working on this ticket now and reply with a short status; it will resume when the user answers.",
      });
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

  app.use("/agent", r);
  app.use((_req, res) => res.status(404).json({ error: "Not found" }));
  return app;
};

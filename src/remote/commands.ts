import { z } from "zod";
import { SESSION_ID_PATTERN, ticketIdSchema, ticketKindSchema } from "../core/types.js";

/**
 * What the remote dashboard may ask for, and the UI API call each one
 * becomes. The dashboard and its relay are untrusted for this purpose: a
 * command is checked here, refused for a session you did not share, and
 * then goes through the same handler (and validation) as a click in the
 * local UI. Nothing here deletes a session, edits settings, the allowlist,
 * caps or secrets, applies work to a repository, or reads files.
 *
 * Kept to one round of work, start to finish (docs/REMOTE.md): new work in
 * the same box, paste a board, set the goal, start, pause and stop, message
 * the lead or ask the box, answer requests, read and clear the inbox, stop
 * the container and publish draft pull requests. Managing a session (its
 * repositories, agents, recipes, settings) and editing tickets stay in the
 * app.
 */

const sessionId = z.string().regex(SESSION_ID_PATTERN);
const short = (n: number) => z.string().max(n);

export const remoteCommandSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("run"),
    payload: z.object({ sessionId, action: z.enum(["start", "pause", "stop", "prompt"]), prompt: short(20_000).optional() }),
  }),
  z.object({
    kind: z.literal("decide"),
    payload: z.object({
      sessionId,
      requestId: z.string().regex(/^R-\d+$/),
      answer: short(8000).optional(),
      actions: z.array(z.object({ id: z.string().regex(/^a\d+$/), decision: z.enum(["approve", "decline"]), note: short(8000).optional() })).max(20).default([]),
      declineAll: z.boolean().optional(),
    }),
  }),
  z.object({
    kind: z.literal("ticket.create"),
    payload: z.object({
      sessionId,
      title: z.string().min(1).max(200),
      spec: short(50_000).optional(),
      kind: ticketKindSchema.optional(),
      state: z.enum(["backlog", "ready"]).optional(),
      priority: z.number().int().min(0).max(1000).optional(),
    }),
  }),
  z.object({ kind: z.literal("ticket.approve"), payload: z.object({ sessionId, ticketId: ticketIdSchema }) }),
  z.object({ kind: z.literal("tickets.approveAll"), payload: z.object({ sessionId }) }),
  z.object({ kind: z.literal("goal.set"), payload: z.object({ sessionId, goal: short(20_000) }) }),
  z.object({ kind: z.literal("board.import"), payload: z.object({ sessionId, text: z.string().min(1).max(2_000_000), state: z.enum(["backlog", "ready"]).optional(), setGoal: z.boolean().optional() }) }),
  z.object({ kind: z.literal("board.clear"), payload: z.object({ sessionId }) }),
  z.object({ kind: z.literal("message"), payload: z.object({ sessionId, text: z.string().trim().min(1).max(10_000) }) }),
  z.object({ kind: z.literal("message.read"), payload: z.object({ sessionId, messageId: z.string().regex(/^M-\d+$/) }) }),
  z.object({ kind: z.literal("inbox.clear"), payload: z.object({ sessionId }) }),
  z.object({ kind: z.literal("work.new"), payload: z.object({ sessionId, goal: short(20_000).optional(), board: z.string().max(2_000_000).optional(), start: z.boolean().optional() }) }),
  z.object({ kind: z.literal("publish"), payload: z.object({ sessionId, acknowledgeFlagged: z.boolean().optional() }) }),
  z.object({ kind: z.literal("container.stop"), payload: z.object({ sessionId }) }),
]);
export type RemoteCommand = z.infer<typeof remoteCommandSchema>;

/** `timeoutMs` for the calls that bring a container up or talk to GitHub. */
export type ApiCall = { method: "GET" | "POST" | "PUT"; path: string; body: unknown; timeoutMs?: number };

const SLOW_MS = 10 * 60_000;

const e = encodeURIComponent;

/** The local UI API call a command becomes (path relative to /api). */
export const toApiCall = (c: RemoteCommand): ApiCall => {
  const s = `/sessions/${e(c.payload.sessionId)}`;
  switch (c.kind) {
    case "run":
      return { method: "POST", path: `${s}/run`, body: { action: c.payload.action, prompt: c.payload.prompt } };
    case "decide":
      return { method: "POST", path: `${s}/requests/${e(c.payload.requestId)}`, body: { answer: c.payload.answer, actions: c.payload.actions, declineAll: c.payload.declineAll ?? false } };
    case "ticket.create": {
      const { sessionId: _, ...t } = c.payload;
      return { method: "POST", path: `${s}/tickets`, body: t };
    }
    case "ticket.approve":
      return { method: "POST", path: `${s}/tickets/${e(c.payload.ticketId)}/state`, body: { state: "ready" } };
    case "tickets.approveAll":
      return { method: "POST", path: `${s}/tickets/approve-all`, body: {} };
    case "goal.set":
      return { method: "PUT", path: `${s}/goal`, body: { goal: c.payload.goal } };
    case "board.import":
      return { method: "POST", path: `${s}/board/import`, body: { text: c.payload.text, state: c.payload.state ?? "ready", mode: "add", setGoal: c.payload.setGoal ?? false } };
    case "board.clear":
      return { method: "POST", path: `${s}/board/clear`, body: {} };
    case "message":
      return { method: "POST", path: `${s}/run/message`, body: { text: c.payload.text } };
    case "message.read":
      return { method: "POST", path: `${s}/messages/${e(c.payload.messageId)}/read`, body: {} };
    case "inbox.clear":
      return { method: "POST", path: `${s}/inbox/clear`, body: {} };
    case "work.new":
      // Never stops a run on its way: an active run refuses, and the template stays the session's.
      return { method: "POST", path: `${s}/new-work`, body: { goal: c.payload.goal ?? "", board: c.payload.board ?? "", start: c.payload.start ?? false, stopRun: false }, timeoutMs: SLOW_MS };
    case "publish":
      return { method: "POST", path: `${s}/publish-all`, body: { acknowledgeFlagged: c.payload.acknowledgeFlagged ?? false }, timeoutMs: SLOW_MS };
    case "container.stop":
      return { method: "POST", path: `${s}/sandbox`, body: { action: "stop" }, timeoutMs: SLOW_MS };
  }
};

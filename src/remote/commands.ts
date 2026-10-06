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
 * Kept to what a phone needs overnight (docs/REMOTE.md): start, pause and
 * stop, ask the box, answer requests, add tickets and approve them. Setup,
 * planning and ticket editing stay in the app.
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
]);
export type RemoteCommand = z.infer<typeof remoteCommandSchema>;

export type ApiCall = { method: "POST" | "PUT"; path: string; body: unknown };

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
  }
};

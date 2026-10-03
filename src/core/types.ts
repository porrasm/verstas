import { z } from "zod";

/**
 * Verstas data model. Everything here is plain JSON on disk: a session is a
 * directory, its board is `board.json`, its runs are `runs/<n>/`. The agent
 * never sees these files directly; it reads and moves tickets through the
 * agent API, which validates against the same schemas.
 */

// --- Tickets ---------------------------------------------------------------

export const ticketStateSchema = z.enum([
  "backlog", // exists, not yet approved to run
  "ready", // the loop may pick it
  "in_progress", // a worker holds it
  "review", // implementer finished, reviewer or gates running
  "waiting", // a request is open; returns to ready when answered
  "blocked", // gave up (attempts exhausted, cap hit, reviewer said no)
  "done",
]);
export type TicketState = z.infer<typeof ticketStateSchema>;

/**
 * Who may create which kind: workers file bug/followup/chore; only the
 * planner creates feature tickets, and only from the goal. Enforced by the
 * agent API, not just the prompt.
 */
export const ticketKindSchema = z.enum(["feature", "bug", "followup", "chore"]);
export type TicketKind = z.infer<typeof ticketKindSchema>;

export const ticketSizeSchema = z.enum(["S", "M", "L"]);

export const TICKET_ID_PATTERN = /^T-\d+$/;
export const ticketIdSchema = z.string().regex(TICKET_ID_PATTERN, "Ticket ids look like T-12");

export const noteAuthorSchema = z.enum(["user", "agent", "harness"]);

export const noteSchema = z.object({
  at: z.string(), // ISO timestamp
  by: noteAuthorSchema,
  text: z.string().min(1).max(20_000),
});
export type Note = z.infer<typeof noteSchema>;

export const diffStatSchema = z.object({
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  files: z.number().int().nonnegative(),
});

export const costSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  usd: z.number().nonnegative().optional(),
});

export const ticketSchema = z.object({
  id: ticketIdSchema,
  title: z.string().min(1).max(200),
  kind: ticketKindSchema.default("feature"),
  /** Which clone under /workspace the ticket touches; free text, matched to session repos by name. */
  repo: z.string().min(1).max(100).optional(),
  size: ticketSizeSchema.default("M"),
  /** Lower runs first. Ties break on creation order. */
  priority: z.number().int().min(0).max(1000).default(100),
  deps: z.array(ticketIdSchema).default([]),
  state: ticketStateSchema.default("backlog"),
  spec: z.string().max(50_000).default(""),
  acceptance: z.array(z.string().min(1).max(2000)).default([]),
  notes: z.array(noteSchema).default([]),
  attempts: z.number().int().nonnegative().default(0),
  /** The agent may not reprioritize or re-dep a pinned ticket. */
  pinned: z.boolean().default(false),
  report: z.string().max(20_000).optional(),
  diff: diffStatSchema.optional(),
  cost: costSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Ticket = z.infer<typeof ticketSchema>;

export const BOARD_FORMAT_VERSION = 1;

export const boardSchema = z.object({
  verstas: z.literal(BOARD_FORMAT_VERSION),
  goal: z.string().max(20_000).default(""),
  tickets: z.array(ticketSchema).default([]),
});
export type Board = z.infer<typeof boardSchema>;

/**
 * What a paste or a planner may import: a subset of a ticket with loose
 * requirements. Ids are optional (assigned on import); the only states
 * accepted are backlog and ready, since the others describe a run in flight.
 */
export const ticketImportSchema = z.object({
  id: ticketIdSchema.optional(),
  title: z.string().min(1).max(200),
  kind: ticketKindSchema.optional(),
  repo: z.string().min(1).max(100).optional(),
  size: ticketSizeSchema.optional(),
  priority: z.number().int().min(0).max(1000).optional(),
  deps: z.array(ticketIdSchema).optional(),
  state: z.enum(["backlog", "ready"]).optional(),
  spec: z.string().max(50_000).optional(),
  acceptance: z.array(z.string().min(1).max(2000)).optional(),
  notes: z.array(z.string().min(1).max(20_000)).optional(),
  pinned: z.boolean().optional(),
});
export type TicketImport = z.infer<typeof ticketImportSchema>;

export const boardImportSchema = z.object({
  verstas: z.literal(BOARD_FORMAT_VERSION).optional(),
  goal: z.string().max(20_000).optional(),
  tickets: z.array(ticketImportSchema).min(1),
});
export type BoardImport = z.infer<typeof boardImportSchema>;

// --- Inbox: requests, messages, ideas ---------------------------------------

export const PACKAGE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+@/-]{0,99}$/;
export const HOSTNAME_PATTERN = /^(\*\.)?([a-z0-9-]+\.)+[a-z0-9-]+$/i;

export const requestDetailSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("network"),
    host: z.string().regex(HOSTNAME_PATTERN, "A hostname or *.suffix"),
    port: z.number().int().min(1).max(65535).optional(),
  }),
  z.object({
    kind: z.literal("install"),
    manager: z.enum(["apt", "npm", "pip"]),
    packages: z.array(z.string().regex(PACKAGE_NAME_PATTERN)).min(1).max(20),
  }),
  z.object({
    kind: z.literal("resources"),
    workerMinutes: z.number().int().min(1).max(600).optional(),
    workerTurns: z.number().int().min(1).max(500).optional(),
    memoryMb: z.number().int().min(256).max(65536).optional(),
  }),
  z.object({
    kind: z.literal("decision"),
    question: z.string().min(1).max(5000),
  }),
  z.object({
    kind: z.literal("secret"),
    name: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/, "An environment variable name"),
    purpose: z.string().min(1).max(2000),
  }),
  z.object({
    kind: z.literal("halt"),
    reason: z.string().min(1).max(5000),
    severity: z.enum(["major", "critical"]),
  }),
]);
export type RequestDetail = z.infer<typeof requestDetailSchema>;
export type RequestKind = RequestDetail["kind"];

export const requestStateSchema = z.enum(["open", "approved", "denied"]);

export const requestSchema = z.object({
  id: z.string(), // R-<n>
  ticketId: ticketIdSchema.optional(),
  detail: requestDetailSchema,
  why: z.string().min(1).max(5000),
  state: requestStateSchema.default("open"),
  answer: z.string().max(5000).optional(),
  createdAt: z.string(),
  decidedAt: z.string().optional(),
});
export type AgentRequest = z.infer<typeof requestSchema>;

export const messageSchema = z.object({
  id: z.string(), // M-<n>
  ticketId: ticketIdSchema.optional(),
  text: z.string().min(1).max(10_000),
  createdAt: z.string(),
  read: z.boolean().default(false),
});
export type AgentMessage = z.infer<typeof messageSchema>;

export const ideaSchema = z.object({
  id: z.string(), // I-<n>
  ticketId: ticketIdSchema.optional(),
  title: z.string().min(1).max(200),
  pitch: z.string().min(1).max(10_000),
  createdAt: z.string(),
  /** Set when the user turned it into a ticket. */
  promotedTo: ticketIdSchema.optional(),
});
export type Idea = z.infer<typeof ideaSchema>;

export const inboxSchema = z.object({
  requests: z.array(requestSchema).default([]),
  messages: z.array(messageSchema).default([]),
  ideas: z.array(ideaSchema).default([]),
});
export type Inbox = z.infer<typeof inboxSchema>;

// --- Sessions and runs -----------------------------------------------------

export const SESSION_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,80}$/;
export const sessionIdSchema = z.string().regex(SESSION_ID_PATTERN);

export const repoSpecSchema = z.object({
  /** Directory name under /workspace. */
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  /** Absolute path of the work target on the host at clone time (kept for the record). */
  sourcePath: z.string().min(1),
  branch: z.string().min(1).max(200),
  /** Branch the harness commits to inside the clone. */
  runBranch: z.string().min(1).max(200),
});
export type RepoSpec = z.infer<typeof repoSpecSchema>;

export const attachmentSchema = z.object({
  name: z.string().min(1).max(200),
  /** Directory under workspace/attachments the zip was extracted to. */
  dir: z.string().min(1).max(200),
  bytes: z.number().int().nonnegative(),
  skipped: z.array(z.string()).default([]),
});

export const capsSchema = z.object({
  workerMinutes: z.number().int().min(1).max(600).default(25),
  workerTurns: z.number().int().min(1).max(500).default(60),
  runTickets: z.number().int().min(1).max(1000).default(40),
  budgetUsd: z.number().min(0).max(10_000).default(50),
  ticketAttempts: z.number().int().min(1).max(5).default(2),
  reviewer: z.boolean().default(true),
});
export type Caps = z.infer<typeof capsSchema>;

export const limitsSchema = z.object({
  memory: z.string().regex(/^\d+[mg]$/).default("4g"),
  cpus: z.number().min(0.5).max(64).default(2),
  pids: z.number().int().min(64).max(100_000).default(2048),
  /** Pause the run when workspace/ exceeds this many MB (checked between tickets). */
  workspaceMb: z.number().int().min(100).default(20_000),
});
export type Limits = z.infer<typeof limitsSchema>;

export const installRecordSchema = z.object({
  manager: z.enum(["apt", "npm", "pip"]),
  packages: z.array(z.string().regex(PACKAGE_NAME_PATTERN)),
  at: z.string(),
});

export const sessionStateSchema = z.enum([
  "created", // workspace built, no run yet
  "planning", // planner worker running
  "running",
  "paused", // by you, or by a rate limit / size check
  "halted", // by the agent (request kind halt)
  "waiting", // nothing ready, open requests
  "finished", // board has no ready tickets and no open requests
]);
export type SessionState = z.infer<typeof sessionStateSchema>;

export const sessionSchema = z.object({
  id: sessionIdSchema,
  name: z.string().min(1).max(200),
  goal: z.string().max(20_000),
  createdAt: z.string(),
  image: z.string().min(1).default("verstas-devbox:local"),
  repos: z.array(repoSpecSchema).default([]),
  attachments: z.array(attachmentSchema).default([]),
  allowlist: z.array(z.string()).default([]),
  caps: capsSchema.prefault({}),
  limits: limitsSchema.prefault({}),
  installs: z.array(installRecordSchema).default([]),
  /** Per-session auto-approval rules (P2); present in the schema so files stay forward-compatible. */
  preapprove: z
    .object({
      npm: z.boolean().default(false),
      pip: z.boolean().default(false),
      hosts: z.array(z.string()).default([]),
    })
    .prefault({}),
  state: sessionStateSchema.default("created"),
});
export type Session = z.infer<typeof sessionSchema>;

/** Hosts a fresh session may reach. Edited per session; see docs/SANDBOX.md. */
export const DEFAULT_ALLOWLIST = [
  "api.anthropic.com",
  "registry.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
  "github.com",
  "objects.githubusercontent.com",
] as const;

export const runStateSchema = z.enum(["running", "paused", "halted", "stopped", "finished", "failed"]);

export const runSchema = z.object({
  id: z.number().int().positive(),
  sessionId: sessionIdSchema,
  startedAt: z.string(),
  endedAt: z.string().optional(),
  state: runStateSchema,
  currentTicket: ticketIdSchema.optional(),
  ticketsDone: z.number().int().nonnegative().default(0),
  cost: costSchema.default({ inputTokens: 0, outputTokens: 0 }),
  /** Why it is paused: "user" | "rate_limit" | "workspace_size" | "requests"; free text for the UI. */
  pauseReason: z.string().optional(),
  /** Rate-limit resets at this time; the loop sleeps until then. */
  resumeAt: z.string().optional(),
});
export type Run = z.infer<typeof runSchema>;

// --- Events (what the UI streams and runs/<n>/events.jsonl stores) ---------

/**
 * Verstas's own event schema. Worker drivers translate whatever their agent
 * emits into these, so the UI, the log files and the loop never depend on
 * one vendor's format.
 */
export const eventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), t: z.string(), ticket: ticketIdSchema.optional(), role: z.enum(["implementer", "reviewer", "planner"]).optional(), text: z.string() }),
  z.object({ kind: z.literal("tool_use"), t: z.string(), ticket: ticketIdSchema.optional(), tool: z.string(), summary: z.string() }),
  z.object({ kind: z.literal("tool_result"), t: z.string(), ticket: ticketIdSchema.optional(), tool: z.string(), ok: z.boolean(), summary: z.string() }),
  z.object({ kind: z.literal("status"), t: z.string(), ticket: ticketIdSchema.optional(), text: z.string() }),
  z.object({ kind: z.literal("gate"), t: z.string(), ticket: ticketIdSchema, name: z.string(), ok: z.boolean(), summary: z.string() }),
  z.object({ kind: z.literal("ticket"), t: z.string(), ticket: ticketIdSchema, from: ticketStateSchema, to: ticketStateSchema, note: z.string().optional() }),
  z.object({ kind: z.literal("denied_network"), t: z.string(), host: z.string(), port: z.number().int() }),
  z.object({ kind: z.literal("request"), t: z.string(), requestId: z.string(), ticket: ticketIdSchema.optional(), summary: z.string() }),
  z.object({ kind: z.literal("cost"), t: z.string(), ticket: ticketIdSchema.optional(), cost: costSchema }),
  z.object({ kind: z.literal("run"), t: z.string(), state: runStateSchema, reason: z.string().optional() }),
  z.object({ kind: z.literal("error"), t: z.string(), ticket: ticketIdSchema.optional(), text: z.string() }),
  /** The last line a worker writes; the harness reads it to decide what happens to the ticket. */
  z.object({
    kind: z.literal("worker_done"),
    t: z.string(),
    ticket: ticketIdSchema.optional(),
    role: z.enum(["implementer", "reviewer", "planner"]),
    ok: z.boolean(),
    stopReason: z.string(),
    rateLimited: z.boolean(),
    costUsd: z.number(),
    turns: z.number().int(),
    seconds: z.number().int(),
    text: z.string(),
    stderr: z.string().default(""),
  }),
]);
export type VerstasEvent = z.infer<typeof eventSchema>;

export const now = (): string => new Date().toISOString();

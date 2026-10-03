import { z } from "zod";
import { DEFAULT_PACKS, packHosts, PACK_NAMES } from "../network/packs.js";

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
  /** Judged implementer attempts: counted when a verdict is given, never when a ticket parks, is stopped or is rate limited. */
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

export const HOSTNAME_PATTERN = /^(\*\.)?([a-z0-9-]+\.)+[a-z0-9-]+$/i;

/**
 * One request = a summary for the user plus zero or more actions, each
 * decided on its own. The ticket parks until every action has a decision.
 * Kinds Verstas applies itself: network, pack, resources. Kinds the
 * user performs or answers: instruction, question.
 */
export const actionDetailSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("network"),
    host: z
      .string()
      .regex(HOSTNAME_PATTERN, "A hostname or *.suffix")
      .refine((h) => !/^\d{1,3}(\.\d{1,3}){3}$/.test(h), "IP literals are not allowed"),
    port: z.number().int().min(1).max(65535).optional(),
  }),
  z.object({
    kind: z.literal("resources"),
    workerMinutes: z.number().int().min(1).max(600).optional(),
    workerTurns: z.number().int().min(1).max(500).optional(),
    memoryMb: z.number().int().min(256).max(65536).optional(),
  }),
  /** A named bundle of hosts (src/network/packs.ts), e.g. "playwright"; approval adds them all. */
  z.object({
    kind: z.literal("pack"),
    pack: z.enum(PACK_NAMES),
  }),
  /** Something a person must do; marked done or declined, with an optional note. */
  z.object({
    kind: z.literal("instruction"),
    text: z.string().min(1).max(5000),
  }),
  /** A question that needs an answer; options are a convenience, free text is always allowed. */
  z.object({
    kind: z.literal("question"),
    text: z.string().min(1).max(5000),
    options: z.array(z.string().min(1).max(200)).max(8).optional(),
  }),
]);
export type ActionDetail = z.infer<typeof actionDetailSchema>;
export type ActionKind = ActionDetail["kind"];

export const actionStateSchema = z.enum(["open", "approved", "declined"]);

export const actionSchema = z.object({
  /** a1, a2, … within the request. */
  id: z.string(),
  detail: actionDetailSchema,
  state: actionStateSchema.default("open"),
  /** What happened: the user's note or answer, a script's exit code and output tail. */
  outcome: z.string().max(8000).optional(),
  decidedAt: z.string().optional(),
});
export type RequestAction = z.infer<typeof actionSchema>;

export const requestStateSchema = z.enum(["open", "resolved"]);

export const requestSchema = z.object({
  id: z.string(), // R-<n>
  ticketId: ticketIdSchema.optional(),
  /** What the worker needs and why, for the user. */
  summary: z.string().min(1).max(8000),
  actions: z.array(actionSchema).max(20).default([]),
  /** Set by the `halt` tool: the run stops after the worker; acknowledging resolves it. */
  halt: z.object({ reason: z.string().min(1).max(5000), severity: z.enum(["major", "critical"]) }).optional(),
  state: requestStateSchema.default("open"),
  /** The user's free-text answer for the whole request. */
  answer: z.string().max(8000).optional(),
  createdAt: z.string(),
  decidedAt: z.string().optional(),
});
export type AgentRequest = z.infer<typeof requestSchema>;

/** The outcome block the next worker reads: answer first, then one line per action. */
export const requestOutcome = (r: AgentRequest): string => {
  const lines = [`${r.id}${r.state === "resolved" ? "" : " (still open)"}: ${r.summary.replace(/\s+/g, " ").slice(0, 300)}`];
  if (r.answer) lines.push(`  Answer: ${r.answer}`);
  for (const a of r.actions) {
    const d = a.detail;
    const what =
      d.kind === "network" ? `network ${d.host}${d.port ? `:${d.port}` : ""}` :
      d.kind === "pack" ? `network pack ${d.pack}` :
      d.kind === "resources" ? `resources ${JSON.stringify({ ...d, kind: undefined })}` :
      d.kind === "instruction" ? `instruction: ${d.text.slice(0, 200)}` :
      `question: ${d.text.slice(0, 200)}`;
    lines.push(`  ${a.id} ${what} -> ${a.state}${a.outcome ? `: ${a.outcome}` : ""}`);
  }
  if (r.halt) lines.push(`  halt (${r.halt.severity}): ${r.halt.reason.slice(0, 300)} -> ${r.state}`);
  return lines.join("\n");
};

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
  /** The commit the clone started from; the feature branch's base when applying. */
  baseCommit: z.string().optional(),
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

/** A setup script copied into the session at creation; runs once as root when the container is created. */
export const sessionSetupScriptSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  description: z.string().max(500).default(""),
  hosts: z.array(z.string()).default([]),
  note: z.string().max(2000).default(""),
  script: z.string().min(1).max(200_000),
  /** root, or the agent with sudo available (a recipe saved from a session). */
  runAs: z.enum(["root", "agent"]).default("root"),
  env: z.string().max(50_000).default(""),
});
export type SessionSetupScript = z.infer<typeof sessionSetupScriptSchema>;

export const setupResultSchema = z.object({
  name: z.string(),
  ok: z.boolean(),
  code: z.number().int(),
  at: z.string(),
  /** Last lines of the output, for the UI; the full log is setup/<name>.log. */
  tail: z.string().max(4000).default(""),
});
export type SetupResult = z.infer<typeof setupResultSchema>;

/** A root script the user approved, from before the agent had sudo; still replayed when the container is recreated (no snapshot). */
export const rootScriptRecordSchema = z.object({
  script: z.string().min(1).max(20_000),
  cwd: z.string().max(500).optional(),
  at: z.string(),
  requestId: z.string().optional(),
});

export const readinessSchema = z.object({
  verdict: z.enum(["ready", "needs"]),
  at: z.string(),
  summary: z.string().max(4000).default(""),
  /** One line per requirement as the setup worker checked it. */
  checks: z.array(z.object({ text: z.string().max(1000), ok: z.boolean() })).max(60).default([]),
  /** Set when you confirmed a "ready" verdict; the gate is open from then on. */
  confirmedAt: z.string().optional(),
});
export type Readiness = z.infer<typeof readinessSchema>;

/** Tickets wait for the environment: requirements are set and nobody confirmed the box meets them. */
export const needsSetup = (s: { requirements: string; readiness?: Readiness }): boolean => Boolean(s.requirements.trim()) && !s.readiness?.confirmedAt;

export const sessionStateSchema = z.enum([
  "created", // workspace built, no run yet
  "setup", // requirements are set and the environment is not confirmed ready; tickets cannot run
  "checking", // the setup worker is running
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
  /** Model for every worker (`claude --model`); empty means the token's default. Aliases like "sonnet" work. */
  model: z.string().max(100).optional(),
  repos: z.array(repoSpecSchema).default([]),
  attachments: z.array(attachmentSchema).default([]),
  allowlist: z.array(z.string()).default([]),
  /** Network packs the allowlist was built from (src/network/packs.ts); the allowlist is what the proxy enforces. */
  packs: z.array(z.string()).default([]),
  caps: capsSchema.prefault({}),
  limits: limitsSchema.prefault({}),
  rootScripts: z.array(rootScriptRecordSchema).default([]),
  setupScripts: z.array(sessionSetupScriptSchema).default([]),
  /** Results of the last setup run, one per script, in order. Empty until the container was first created. */
  setup: z.array(setupResultSchema).default([]),
  /**
   * Session requirements: what the box must be able to do before any ticket
   * runs ("Postgres 17 reachable with the schema migrated; the e2e suite
   * runs"). Empty means no setup phase. When set, a setup worker makes the
   * box meet them and reports; tickets run only after you confirm.
   */
  requirements: z.string().max(20_000).default(""),
  /** Prompts you ran from the session page (one worker, no ticket) and their replies; newest last, at most 20. */
  prompts: z
    .array(z.object({ at: z.string(), runId: z.number().int(), text: z.string().max(20_000), reply: z.string().max(8000).default(""), stopReason: z.string().default("") }))
    .default([]),
  /**
   * The box as it was when you confirmed the environment, committed to an
   * image. A recreated container starts from it instead of replaying the
   * setup, as long as the base image has not changed since.
   */
  snapshot: z.object({ image: z.string(), at: z.string(), baseImageId: z.string() }).optional(),
  /** The setup worker's last verdict on the requirements, and whether you confirmed it. */
  readiness: readinessSchema.optional(),
  /** Per-session auto-approval rules (P2); present in the schema so files stay forward-compatible. */
  preapprove: z
    .object({
      hosts: z.array(z.string()).default([]),
    })
    .prefault({}),
  state: sessionStateSchema.default("created"),
});
export type Session = z.infer<typeof sessionSchema>;

/** Hosts a fresh session may reach when nothing is chosen: the default packs. Edited per session; see docs/SANDBOX.md. */
export const DEFAULT_ALLOWLIST: readonly string[] = packHosts(DEFAULT_PACKS);

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
  z.object({ kind: z.literal("text"), t: z.string(), ticket: ticketIdSchema.optional(), role: z.enum(["implementer", "reviewer", "planner", "setup", "prompt"]).optional(), text: z.string() }),
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
    role: z.enum(["implementer", "reviewer", "planner", "setup", "prompt"]),
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

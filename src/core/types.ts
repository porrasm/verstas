import { z } from "zod";
import { DEFAULT_PACKS, packHosts, PACK_NAMES } from "../network/packs.js";

/**
 * Verstas data model. Everything here is plain JSON on disk: a session is a
 * directory, its board is `board.json`, its runs are `runs/<n>/`. The agent
 * never sees these files directly; it reads and moves tickets through the
 * agent API, which validates against the same schemas.
 */

// --- Agents (drivers) ------------------------------------------------------

/**
 * Which coding agent runs a worker. Every driver honours the same contract
 * (docs/DRIVERS.md); Claude Code is the reference and the default, so a
 * session that never chooses runs exactly as before.
 */
export const driverNameSchema = z.enum(["claude", "codex", "cursor"]);
export type DriverName = z.infer<typeof driverNameSchema>;
export const DRIVER_NAMES = driverNameSchema.options;

/** One agent choice: the driver and, optionally, the model it should use (any id the CLI accepts; empty means the account's default). */
export const agentSpecSchema = z.object({
  driver: driverNameSchema.default("claude"),
  model: z.string().max(100).optional(),
});
export type AgentSpec = z.infer<typeof agentSpecSchema>;

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
  /**
   * Run this ticket's implementer on this agent instead of the session's
   * worker: a fresh worker on that driver and model, judged by the session's
   * reviewer as usual. For tickets that need a particular strength (visual
   * judgement of rendered output, say). In lead mode the lead hands such a
   * ticket over with board_run instead of doing it itself.
   */
  agent: agentSpecSchema.optional(),
  report: z.string().max(20_000).optional(),
  diff: diffStatSchema.optional(),
  cost: costSchema.optional(),
  /**
   * Timing, recorded by transition() and the run (all optional: boards from
   * before this have none and show none). `stateSince` is the last state
   * change; `timeIn` sums the seconds of every visit to each state;
   * `agentSeconds` sums the ticket's workers (implementer and reviewer);
   * `firstClaimAt` is the first move into in_progress.
   */
  stateSince: z.string().optional(),
  timeIn: z.partialRecord(ticketStateSchema, z.number().nonnegative()).optional(),
  agentSeconds: z.number().nonnegative().optional(),
  firstClaimAt: z.string().optional(),
  /** Seconds in ready before the first claim (queueing), so the requeued time can leave it out. */
  readyBeforeClaim: z.number().nonnegative().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Ticket = z.infer<typeof ticketSchema>;

/** How a ticket's time was spent, in seconds; see ticketTiming. */
export type TicketTiming = { working: number; judging: number; waitingOnYou: number; requeued: number; agent: number; total: number };

const secondsBetween = (from: string, to: string): number => Math.max(0, (Date.parse(to) - Date.parse(from)) / 1000);

/**
 * A ticket's time, split by what it waited on. Null for a ticket that was
 * never claimed or carries no timing (an old board). `total` runs from the
 * first claim to done, or to `at` while the ticket is open. A loop run's
 * agent time is what its workers reported; a lead does not report per
 * ticket, so in lead mode the lead's share is the time in in_progress, plus
 * the reviewer's (and an own-agent implementer's) reported seconds.
 */
export const ticketTiming = (t: Ticket, mode: "loop" | "lead", at: string = now()): TicketTiming | null => {
  if (!t.firstClaimAt || !t.stateSince) return null;
  // The visit in progress counts too, up to `at`; a done ticket's clock stopped when it got there.
  const timeIn: Partial<Record<TicketState, number>> = { ...t.timeIn };
  if (t.state !== "done") timeIn[t.state] = (timeIn[t.state] ?? 0) + secondsBetween(t.stateSince, at);
  const working = timeIn.in_progress ?? 0;
  const judging = timeIn.review ?? 0;
  const waitingOnYou = timeIn.waiting ?? 0;
  // Time in ready before the first claim is queueing, not requeueing: `ready` counts only from the first claim on.
  const requeued = Math.max(0, (timeIn.ready ?? 0) - (t.readyBeforeClaim ?? 0));
  const agent = mode === "lead" ? working + (t.agentSeconds ?? 0) : (t.agentSeconds ?? 0);
  const total = secondsBetween(t.firstClaimAt, t.state === "done" ? t.stateSince : at);
  return { working, judging, waitingOnYou, requeued, agent, total };
};

// --- Chores ----------------------------------------------------------------

/**
 * A chore is a small, self-contained fix that is not worth a ticket: a nit,
 * a rename, a missing guard, a doc line. Reviewers, workers and you file
 * them; a lead sweeps a batch at a time and the harness commits the batch
 * as one commit after the repository's own checks and a size check. No
 * reviewer. Anything bigger is promoted to a ticket.
 */
export const CHORE_ID_PATTERN = /^C-\d+$/;
export const choreIdSchema = z.string().regex(CHORE_ID_PATTERN, "Chore ids look like C-3");

export const choreStateSchema = z.enum([
  "proposed", // filed by an agent while the session asks you to approve chores first
  "open", // may be swept
  "sweeping", // a lead holds it in the current sweep
  "done",
  "dropped", // not worth doing, with the reason
  "promoted", // became a ticket (promotedTo)
]);
export type ChoreState = z.infer<typeof choreStateSchema>;

export const choreSchema = z.object({
  id: choreIdSchema,
  text: z.string().min(1).max(2000),
  /** Where to look: a file, a function, a page. Free text. */
  where: z.string().max(500).optional(),
  repo: z.string().min(1).max(100).optional(),
  state: choreStateSchema.default("open"),
  by: noteAuthorSchema,
  /** The ticket whose work surfaced it. */
  fromTicket: ticketIdSchema.optional(),
  /** What the sweep said: done how, or dropped why. */
  outcome: z.string().max(4000).optional(),
  promotedTo: ticketIdSchema.optional(),
  /** The sweep it was settled in. */
  sweep: z.number().int().positive().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Chore = z.infer<typeof choreSchema>;

export const sweepStateSchema = z.enum(["working", "judging", "accepted", "refused"]);

/** The current or last sweep: which chores a lead took, and how it ended. */
export const sweepSchema = z.object({
  n: z.number().int().positive(),
  ids: z.array(choreIdSchema),
  state: sweepStateSchema,
  startedAt: z.string(),
  endedAt: z.string().optional(),
  /** Why it was refused, or what was committed. */
  note: z.string().max(4000).optional(),
  diff: diffStatSchema.optional(),
});
export type Sweep = z.infer<typeof sweepSchema>;

export const SWEEP_OUTCOMES = ["done", "dropped", "promoted"] as const;
export const sweepResultSchema = z.object({
  id: choreIdSchema,
  outcome: z.enum(SWEEP_OUTCOMES),
  /** One line: what was done, why it was dropped, or what the ticket should say. */
  note: z.string().max(2000).optional(),
});
export type SweepResult = z.infer<typeof sweepResultSchema>;

export const BOARD_FORMAT_VERSION = 1;

export const boardSchema = z.object({
  verstas: z.literal(BOARD_FORMAT_VERSION),
  goal: z.string().max(20_000).default(""),
  tickets: z.array(ticketSchema).default([]),
  chores: z.array(choreSchema).default([]),
  /** The sweep in flight, or the last one. */
  sweep: sweepSchema.optional(),
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
  agent: agentSpecSchema.optional(),
});
export type TicketImport = z.infer<typeof ticketImportSchema>;

/** A chore as pasted or filed: text and where; the state only for your own imports. */
export const choreImportSchema = z.object({
  id: choreIdSchema.optional(),
  text: z.string().min(1).max(2000),
  where: z.string().max(500).optional(),
  repo: z.string().min(1).max(100).optional(),
  state: z.enum(["proposed", "open"]).optional(),
});
export type ChoreImport = z.infer<typeof choreImportSchema>;

export const boardImportSchema = z
  .object({
    verstas: z.literal(BOARD_FORMAT_VERSION).optional(),
    goal: z.string().max(20_000).optional(),
    tickets: z.array(ticketImportSchema).default([]),
    chores: z.array(choreImportSchema).default([]),
  })
  .refine((b) => b.tickets.length > 0 || b.chores.length > 0, { message: "Nothing to import: no tickets and no chores", path: ["tickets"] });
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
  /** What it is and what it is for, in your words ("the spec; tickets cite its sections"). Shown to every worker beside its path. */
  description: z.string().max(1000).optional(),
});
export type Attachment = z.infer<typeof attachmentSchema>;

/** One line per attachment for the agents: its path and, when you gave one, your description. */
export const attachmentLines = (attachments: readonly Attachment[], indent = ""): string =>
  attachments.map((a) => `${indent}- \`/workspace/attachments/${a.dir}\`${a.description?.trim() ? `: ${a.description.trim().replace(/\s+/g, " ")}` : ""}`).join("\n");

export const capsSchema = z.object({
  workerMinutes: z.number().int().min(1).max(600).default(25),
  workerTurns: z.number().int().min(1).max(500).default(60),
  runTickets: z.number().int().min(1).max(1000).default(40),
  budgetUsd: z.number().min(0).max(10_000).default(50),
  ticketAttempts: z.number().int().min(1).max(5).default(2),
  reviewer: z.boolean().default(true),
  /**
   * Implementers of one run continue one agent conversation instead of
   * starting fresh per ticket (Claude Code only; others start fresh). The
   * reviewer always starts fresh.
   */
  resumeWorker: z.boolean().default(false),
  /** A lead lives much longer than a worker; at a cap it hands over to a fresh lead instead of failing a ticket. */
  leadMinutes: z.number().int().min(10).max(1440).default(180),
  leadTurns: z.number().int().min(20).max(5000).default(600),
  /** A chore sweep's commit may change at most this many lines (added plus removed) and files; over it, the sweep is refused and the work belongs in a ticket. */
  sweepMaxLines: z.number().int().min(10).max(100_000).default(400),
  sweepMaxFiles: z.number().int().min(1).max(1000).default(15),
  /** Chores filed by agents wait for your approval before a sweep may take them. */
  choreApproval: z.boolean().default(false),
  /**
   * With this many chores open, the lead sweeps before it starts the next
   * ticket: claims and hand-overs are refused until the list is below the
   * line again (sweep a batch, or drop what is not worth doing). 0 turns the
   * line off; the lead then sweeps when it sees fit.
   */
  choreSweepAt: z.number().int().min(0).max(1000).default(10),
});
export type Caps = z.infer<typeof capsSchema>;

/**
 * Paths a sweep may not change, as globs against the path inside the
 * repository: the documents a project treats as its contract and golden
 * files. Changing one of them is a ticket's job, with a reviewer.
 */
export const SWEEP_PROTECTED_GLOBS: readonly string[] = ["**/DESIGN.md", "**/SPEC.md", "**/ARCHITECTURE.md", "**/fixtures/**", "**/__snapshots__/**", "**/*.snap"];

/** A tiny glob: `**` spans directories, `*` one path segment; anchored at both ends. */
export const globToRegExp = (glob: string): RegExp => {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else re += "[^/]*";
    } else re += /[.+^${}()|[\]\\?]/.test(c) ? `\\${c}` : c;
  }
  return new RegExp(`^${re}$`);
};
export const matchesAnyGlob = (p: string, globs: readonly string[]): boolean => globs.some((g) => globToRegExp(g).test(p));

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

/**
 * A session is initialized once its environment exists: the repositories
 * are cloned, the container was created, and the setup step ran (or was
 * skipped). Until then it is a plan: a name, a board and settings, and
 * nothing can run in it.
 */
export const isInitialized = (s: { initializedAt?: string | null }): boolean => Boolean(s.initializedAt);

/** How the environment is set up at initialization: a setup worker, or nothing beyond the container and the recipes. */
export const setupModeSchema = z.enum(["agentic", "skip"]);

/**
 * How the tickets are worked. loop: the harness picks each ready ticket and
 * starts a fresh implementer for it. lead: one long-lived agent works the
 * board, claiming and submitting tickets itself; the harness keeps it alive
 * and still judges every ticket.
 */
export const sessionModeSchema = z.enum(["loop", "lead"]);
export type SessionMode = z.infer<typeof sessionModeSchema>;
export type SetupMode = z.infer<typeof setupModeSchema>;

export const sessionStateSchema = z.enum([
  "created", // initialized, no run yet
  "setup", // not initialized: a plan, or an initialization that needs you
  "checking", // the setup worker is running
  "planning", // planner worker running
  "running",
  "paused", // by you, or by a rate limit / size check
  "halted", // by the agent (request kind halt)
  "waiting", // nothing ready, open requests
  "finished", // board has no ready tickets and no open requests
]);
export type SessionState = z.infer<typeof sessionStateSchema>;

/** Per-role agents. `worker` runs implementer, planner, setup and prompts; `reviewer` defaults to the worker's agent. */
export const sessionAgentsSchema = z.object({
  worker: agentSpecSchema.optional(),
  reviewer: agentSpecSchema.optional(),
});
export type SessionAgents = z.infer<typeof sessionAgentsSchema>;

export type WorkerRole = "implementer" | "reviewer" | "planner" | "setup" | "prompt" | "lead";

/**
 * The agent for a role. Older sessions carry only `model`; that is the
 * worker's Claude model, so they keep running unchanged.
 */
export const agentFor = (s: { model?: string; agents?: SessionAgents }, role: WorkerRole, ticket?: { agent?: AgentSpec }): AgentSpec => {
  // A ticket's own agent applies to the implementer that works it; the reviewer stays the session's, so the review is independent of what wrote the code.
  if (role === "implementer" && ticket?.agent) return ticket.agent;
  const worker: AgentSpec = s.agents?.worker ?? { driver: "claude", model: s.model || undefined };
  if (role === "reviewer" && s.agents?.reviewer) return s.agents.reviewer;
  return worker;
};

/** Drivers named by tickets that are not done yet. */
export const boardDrivers = (board: { tickets: readonly { agent?: AgentSpec; state: TicketState }[] }): DriverName[] => [...new Set(board.tickets.filter((t) => t.agent && t.state !== "done").map((t) => t.agent!.driver))];

/** Every driver a session uses, worker first; with the board, the tickets' own agents too. */
export const sessionDrivers = (s: { model?: string; agents?: SessionAgents; caps?: { reviewer?: boolean } }, board?: { tickets: readonly { agent?: AgentSpec; state: TicketState }[] }): DriverName[] => {
  const out = [agentFor(s, "implementer").driver];
  if (s.caps?.reviewer !== false) {
    const r = agentFor(s, "reviewer").driver;
    if (!out.includes(r)) out.push(r);
  }
  for (const d of board ? boardDrivers(board) : []) if (!out.includes(d)) out.push(d);
  return out;
};

/** "codex · gpt-5.1" for a badge or a board line. */
export const describeAgent = (a: AgentSpec): string => `${a.driver}${a.model ? ` · ${a.model}` : ""}`;

export const sessionSchema = z.object({
  id: sessionIdSchema,
  name: z.string().min(1).max(200),
  /** Legacy, and a draft's goal: no longer part of the setup. The Plan tickets box starts from it when the board is empty. */
  goal: z.string().max(20_000).default(""),
  createdAt: z.string(),
  /** When the environment came to exist (see `isInitialized`); null while the session is a plan. */
  initializedAt: z.string().nullable().default(null),
  image: z.string().min(1).default("verstas-devbox:local"),
  /** Legacy: the worker's Claude model, from before `agents` existed. Read through `agentFor`; new sessions set `agents` instead. */
  model: z.string().max(100).optional(),
  /** Which agent runs each role (see `agentFor`). Absent means Claude Code for everything. */
  agents: sessionAgentsSchema.prefault({}),
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
   * Setup instructions for the setup worker, on top of what it works out
   * itself from the repositories and the board ("Postgres 17 reachable with
   * the schema migrated; the e2e suite runs"). Used when `setupMode` is
   * agentic; empty is fine.
   */
  requirements: z.string().max(20_000).default(""),
  setupMode: setupModeSchema.default("agentic"),
  mode: sessionModeSchema.default("loop"),
  /** Prompts you ran from the session page (one worker, no ticket) and planning requests, with their replies; newest last, at most 20. */
  prompts: z
    .array(z.object({ at: z.string(), runId: z.number().int(), kind: z.enum(["prompt", "plan"]).default("prompt"), text: z.string().max(20_000), reply: z.string().max(8000).default(""), stopReason: z.string().default("") }))
    .default([]),
  /**
   * The box as it was when you confirmed the environment, committed to an
   * image. A recreated container starts from it instead of replaying the
   * setup, as long as the base image has not changed since.
   */
  snapshot: z.object({ image: z.string(), at: z.string(), baseImageId: z.string() }).optional(),
  /** The setup worker's last verdict, and when it was accepted (at initialization, or by you). */
  readiness: readinessSchema.optional(),
  /** Per-session auto-approval rules (P2); present in the schema so files stay forward-compatible. */
  preapprove: z
    .object({
      hosts: z.array(z.string()).default([]),
    })
    .prefault({}),
  state: sessionStateSchema.default("created"),
  /**
   * Show this session on the remote dashboard (docs/REMOTE.md). Off by
   * default: nothing about a session leaves this machine until you tick it.
   */
  remote: z.boolean().default(false),
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
  z.object({ kind: z.literal("text"), t: z.string(), ticket: ticketIdSchema.optional(), role: z.enum(["implementer", "reviewer", "planner", "setup", "prompt", "lead"]).optional(), text: z.string() }),
  z.object({ kind: z.literal("tool_use"), t: z.string(), ticket: ticketIdSchema.optional(), tool: z.string(), summary: z.string() }),
  z.object({ kind: z.literal("tool_result"), t: z.string(), ticket: ticketIdSchema.optional(), tool: z.string(), ok: z.boolean(), summary: z.string() }),
  z.object({ kind: z.literal("status"), t: z.string(), ticket: ticketIdSchema.optional(), text: z.string() }),
  z.object({ kind: z.literal("gate"), t: z.string(), ticket: ticketIdSchema.optional(), name: z.string(), ok: z.boolean(), summary: z.string() }),
  z.object({ kind: z.literal("ticket"), t: z.string(), ticket: ticketIdSchema, from: ticketStateSchema, to: ticketStateSchema, note: z.string().optional() }),
  z.object({ kind: z.literal("denied_network"), t: z.string(), host: z.string(), port: z.number().int() }),
  z.object({ kind: z.literal("request"), t: z.string(), requestId: z.string(), ticket: ticketIdSchema.optional(), summary: z.string() }),
  z.object({ kind: z.literal("cost"), t: z.string(), ticket: ticketIdSchema.optional(), cost: costSchema }),
  z.object({ kind: z.literal("run"), t: z.string(), state: runStateSchema, reason: z.string().optional() }),
  z.object({ kind: z.literal("error"), t: z.string(), ticket: ticketIdSchema.optional(), text: z.string() }),
  /** A chore sweep was judged: committed as one commit, or refused with the reason. */
  z.object({ kind: z.literal("chores"), t: z.string(), sweep: z.number().int(), accepted: z.boolean(), done: z.number().int(), dropped: z.number().int(), promoted: z.number().int(), note: z.string() }),
  /** The last line a worker writes; the harness reads it to decide what happens to the ticket. */
  z.object({
    kind: z.literal("worker_done"),
    t: z.string(),
    ticket: ticketIdSchema.optional(),
    role: z.enum(["implementer", "reviewer", "planner", "setup", "prompt", "lead"]),
    ok: z.boolean(),
    stopReason: z.string(),
    rateLimited: z.boolean(),
    costUsd: z.number(),
    turns: z.number().int(),
    seconds: z.number().int(),
    text: z.string(),
    stderr: z.string().default(""),
    /** The agent conversation this worker ran in, when the harness kept one (caps.resumeWorker, lead mode). */
    agentSession: z.string().optional(),
  }),
]);
export type VerstasEvent = z.infer<typeof eventSchema>;

export const now = (): string => new Date().toISOString();

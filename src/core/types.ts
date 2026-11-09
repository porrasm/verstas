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
  "review", // implementer finished, the reviewer running
  "waiting", // a request is open; returns to ready when answered
  "blocked", // the reviewer said no, or the lead gave up
  "done",
]);
export type TicketState = z.infer<typeof ticketStateSchema>;

/** A label on a ticket: anyone may use any kind. */
export const ticketKindSchema = z.enum(["feature", "bug", "followup", "chore"]);
export type TicketKind = z.infer<typeof ticketKindSchema>;

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

/**
 * How a ticket is judged: `full` runs the reviewer, `none` accepts the
 * ticket when the implementer finished. Only you set it; agents' tickets
 * take the session's. `checks` is a value from before the harness stopped
 * running checks itself (boards still carry it); it reads as `none`.
 */
export const reviewModeSchema = z.enum(["full", "checks", "none"]);
export type ReviewMode = z.infer<typeof reviewModeSchema>;
/** `checks` meant "the harness's checks decide, no reviewer"; without harness checks that is `none`. */
export const normalizeReviewMode = (m: ReviewMode): "full" | "none" => (m === "full" ? "full" : "none");

/** Boards and drafts from before `repos` name one repository as `repo`; read that as a list of one. */
const legacyRepo = (v: unknown): unknown => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return v;
  const { repo, ...rest } = v as Record<string, unknown>;
  if (repo === undefined) return v;
  const repos = Array.isArray(rest.repos) ? rest.repos : typeof repo === "string" && repo ? [repo] : [];
  return { ...rest, repos };
};

/** What the judge found in one repository for a ticket: the change. */
export const touchedRepoSchema = z.object({
  repo: z.string().min(1).max(100),
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  files: z.number().int().nonnegative(),
  /** From before the harness stopped running checks: what its check said then. New verdicts leave it out. */
  check: z.enum(["passed", "failed", "skipped", "none"]).optional(),
});
export type TouchedRepo = z.infer<typeof touchedRepoSchema>;

export const ticketSchema = z.preprocess(legacyRepo, z.object({
  id: ticketIdSchema,
  title: z.string().min(1).max(200),
  kind: ticketKindSchema.default("feature"),
  /**
   * The clones under /workspace the ticket is expected to touch. A hint for
   * you and the lead, never a limit: the judge acts on whatever repositories
   * actually changed (`touched`).
   */
  repos: z.array(z.string().min(1).max(100)).max(20).default([]),
  /** Lower first, as the lead reads it; the harness orders nothing by it. Ties break on creation order. */
  priority: z.number().int().min(0).max(1000).default(100),
  deps: z.array(ticketIdSchema).default([]),
  state: ticketStateSchema.default("backlog"),
  spec: z.string().max(50_000).default(""),
  acceptance: z.array(z.string().min(1).max(2000)).default([]),
  notes: z.array(noteSchema).default([]),
  /**
   * Each repository's HEAD when the ticket entered in_progress, recorded by
   * the harness. The reviewer reads the commits since then that carry the
   * ticket's id, plus the working tree (docs/BOARD.md, Judging). Kept when
   * the ticket is requeued, so earlier commits stay in the review; cleared
   * when it is done.
   */
  baseline: z.record(z.string(), z.string()).optional(),
  /** How the ticket is judged; absent, the session's setting applies (see reviewModeFor). Set by you only. */
  review: reviewModeSchema.optional(),
  report: z.string().max(20_000).optional(),
  /** All touched repositories together, as of the last verdict. */
  diff: diffStatSchema.optional(),
  /** Each repository the last verdict found changed. */
  touched: z.array(touchedRepoSchema).optional(),
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
  /** Seconds in ready before the first move into progress (queueing), so the requeued time can leave it out. */
  readyBeforeClaim: z.number().nonnegative().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
}));
export type Ticket = z.infer<typeof ticketSchema>;

/** The ticket's own review mode, or the session's: the reviewer on means full, off means none. */
export const reviewModeFor = (t: Pick<Ticket, "review">, caps: { reviewer: boolean }): "full" | "none" => (t.review ? normalizeReviewMode(t.review) : caps.reviewer ? "full" : "none");

/** How a ticket's time was spent, in seconds; see ticketTiming. */
export type TicketTiming = { working: number; judging: number; waitingOnYou: number; requeued: number; agent: number; total: number };

const secondsBetween = (from: string, to: string): number => Math.max(0, (Date.parse(to) - Date.parse(from)) / 1000);

/**
 * A ticket's time, split by what it waited on. Null for a ticket that was
 * never claimed or carries no timing (an old board). `total` runs from the
 * first claim to done, or to `at` while the ticket is open. The lead does
 * not report time per ticket, so its share is the time in in_progress,
 * plus the reviewer's reported seconds.
 */
export const ticketTiming = (t: Ticket, at: string = now()): TicketTiming | null => {
  if (!t.firstClaimAt || !t.stateSince) return null;
  // The visit in progress counts too, up to `at`; a done ticket's clock stopped when it got there.
  const timeIn: Partial<Record<TicketState, number>> = { ...t.timeIn };
  if (t.state !== "done") timeIn[t.state] = (timeIn[t.state] ?? 0) + secondsBetween(t.stateSince, at);
  const working = timeIn.in_progress ?? 0;
  const judging = timeIn.review ?? 0;
  const waitingOnYou = timeIn.waiting ?? 0;
  // Time in ready before the first claim is queueing, not requeueing: `ready` counts only from the first claim on.
  const requeued = Math.max(0, (timeIn.ready ?? 0) - (t.readyBeforeClaim ?? 0));
  const agent = working + (t.agentSeconds ?? 0);
  const total = secondsBetween(t.firstClaimAt, t.state === "done" ? t.stateSince : at);
  return { working, judging, waitingOnYou, requeued, agent, total };
};

export const BOARD_FORMAT_VERSION = 1;

export const boardSchema = z.object({
  verstas: z.literal(BOARD_FORMAT_VERSION),
  goal: z.string().max(20_000).default(""),
  tickets: z.array(ticketSchema).default([]),
  // Boards from before carry `chores` and `sweep`; they are dropped on parse (the schema is not strict).
});
export type Board = z.infer<typeof boardSchema>;

/**
 * What a paste or an agent may import: a subset of a ticket with loose
 * requirements. Ids are optional: an empty, missing or foreign id (one that
 * is not `T-n`, say a generator's `J-1`) gets the next free id on import, so
 * a board made outside Verstas can be pasted into an existing session. A
 * `T-n` id that the board already has updates that ticket in a merge, and
 * is renumbered with the rest of the paste when the import adds
 * (src/board/board.ts, importBoard). The only
 * states accepted are backlog and ready, since the others describe a run in
 * flight. Fields from before (`size`, `pinned`, `agent`) are accepted and
 * dropped, so an old board pastes clean.
 */
export const ticketImportSchema = z.object({
  id: z.string().max(40).optional(),
  title: z.string().min(1).max(200),
  kind: ticketKindSchema.optional(),
  /** Expected repositories, a hint (see ticketSchema). */
  repos: z.array(z.string().min(1).max(100)).max(20).optional(),
  /** The older single-repository form: read as `repos: [repo]` (see importRepos). */
  repo: z.string().min(1).max(100).optional(),
  priority: z.number().int().min(0).max(1000).optional(),
  deps: z.array(ticketIdSchema).optional(),
  state: z.enum(["backlog", "ready"]).optional(),
  spec: z.string().max(50_000).optional(),
  acceptance: z.array(z.string().min(1).max(2000)).optional(),
  notes: z.array(z.string().min(1).max(20_000)).optional(),
  /** Yours only: the agent API leaves it out, and an agent's import ignores it. */
  review: reviewModeSchema.optional(),
});
export type TicketImport = z.infer<typeof ticketImportSchema>;

/** An import's expected repositories: `repos`, or the older `repo` as a list of one; undefined when it names neither. */
export const importRepos = (t: Pick<TicketImport, "repos" | "repo">): string[] | undefined => t.repos ?? (t.repo ? [t.repo] : undefined);

export const boardImportSchema = z
  .object({
    verstas: z.literal(BOARD_FORMAT_VERSION).optional(),
    goal: z.string().max(20_000).optional(),
    tickets: z.array(ticketImportSchema).default([]),
  })
  .refine((b) => b.tickets.length > 0, { message: "Nothing to import: no tickets", path: ["tickets"] });
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
  /** More memory for the box; minutes and turns from before are read and ignored (the lead has no such caps). */
  z.object({
    kind: z.literal("resources"),
    workerMinutes: z.number().int().optional(),
    workerTurns: z.number().int().optional(),
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
  /** The lead's answer to a progress check (`caps.progressMinutes`): the page shows only the latest of these. */
  progress: z.boolean().optional(),
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
  /** When you last cleared the inbox: what was settled by then is hidden, not deleted (see inboxCleared). */
  clearedAt: z.string().optional(),
});
export type Inbox = z.infer<typeof inboxSchema>;

/**
 * What Clear inbox hides: messages and ideas posted, and requests decided,
 * at or before `clearedAt`. An open request is never cleared, since it
 * waits for you. Nothing leaves inbox.json: the agents' record of what was
 * asked and answered stays whole, and the page can show it again.
 */
export const inboxCleared = (inbox: Inbox): { messages: Set<string>; ideas: Set<string>; requests: Set<string>; count: number } => {
  const at = inbox.clearedAt;
  const before = (t: string | undefined) => Boolean(at && t && t <= at);
  const messages = new Set(inbox.messages.filter((m) => before(m.createdAt)).map((m) => m.id));
  const ideas = new Set(inbox.ideas.filter((i) => before(i.createdAt)).map((i) => i.id));
  const requests = new Set(inbox.requests.filter((r) => r.state !== "open" && before(r.decidedAt ?? r.createdAt)).map((r) => r.id));
  return { messages, ideas, requests, count: messages.size + ideas.size + requests.size };
};

// --- Sessions and runs -----------------------------------------------------

export const SESSION_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,80}$/;
export const sessionIdSchema = z.string().regex(SESSION_ID_PATTERN);

/** A pull request Verstas opened from a session repository; one per round of work. */
export const pullRecordSchema = z.object({
  /** 1, 2, 3…: a new round after the previous pull request was merged or closed. */
  round: z.number().int().min(1),
  number: z.number().int(),
  url: z.string(),
  /** The branch on GitHub, verstas/<session>-<round>. */
  remoteBranch: z.string(),
  /** The commit Verstas last pushed there. */
  headSha: z.string(),
  base: z.string(),
  title: z.string().default(""),
  state: z.enum(["open", "merged", "closed"]),
  publishedAt: z.string(),
  /** When the state was last read from GitHub. */
  checkedAt: z.string().optional(),
});
export type PullRecord = z.infer<typeof pullRecordSchema>;

export const repoSpecSchema = z.object({
  /** Directory name under /workspace. */
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  /** "owner/name" on github.com: the clone comes from the host's mirror of it. */
  github: z.string().optional(),
  /** Sessions from before GitHub repositories: the local checkout the clone came from, kept for the record. */
  sourcePath: z.string().min(1).optional(),
  /** The base branch: what the clone started from and follows. */
  branch: z.string().min(1).max(200),
  /** Branch the harness commits to inside the clone. */
  runBranch: z.string().min(1).max(200),
  /** The commit the clone started from; the feature branch's base when applying. */
  baseCommit: z.string().optional(),
  /** When the clone last moved to the latest base from GitHub (Sync), or was cloned. */
  syncedAt: z.string().optional(),
  /** Pull requests published from this repository, oldest first. */
  prs: z.array(pullRecordSchema).optional(),
  // Sessions from before the harness stopped running checks carry `check`,
  // `noCheck`, `review`, `alsoCheck` and `agentPolicy` here; they are dropped on
  // parse (the schema is not strict) and the reviewer runs the checks instead.
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

/**
 * What the harness enforces. Not much: an independent reviewer on or off,
 * optional liveness limits on one lead life, and how often the lead is
 * asked for a progress update. The lead decides everything else. Caps from
 * before (worker minutes and turns, tickets per run, attempts, a budget,
 * the chore caps, lives per run) are dropped on parse.
 */
export const capsSchema = z.object({
  reviewer: z.boolean().default(true),
  /**
   * Optional liveness limits on one lead life: at a cap the lead is stopped
   * and a fresh lead continues from its note. Unset (the default), a life
   * ends when the lead stops or hands off.
   */
  leadMinutes: z.number().int().min(10).max(1440).optional(),
  leadTurns: z.number().int().min(20).max(5000).optional(),
  /**
   * Every this many minutes of a run, the running lead is asked for a short
   * progress update, which it posts as a `message` to the inbox (Claude
   * Code only; the others cannot be reached mid-run). 0, the default, turns
   * the check off: the board is the progress report.
   */
  progressMinutes: z.number().int().min(0).max(1440).default(0),
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

/**
 * A session is initialized once its environment exists: the repositories
 * are cloned, the container was created and the recipes ran. Until then it
 * is a plan: a name, a goal, a board and settings, and nothing can run in it.
 */
export const isInitialized = (s: { initializedAt?: string | null }): boolean => Boolean(s.initializedAt);

/** How an earlier goal ended: the lead said it was met, or you rewrote or dropped it. */
export const goalOutcomeSchema = z.enum(["met", "revised", "abandoned"]);
/** One earlier goal of the session: its text, when it was current, how it ended, and the worker's assessment when it was met. */
export const goalRecordSchema = z.object({
  text: z.string().max(20_000),
  from: z.string(),
  until: z.string(),
  outcome: goalOutcomeSchema,
  note: z.string().max(8000).optional(),
});
export type GoalRecord = z.infer<typeof goalRecordSchema>;
/** The lead's claim that the goal is met: when, in which run, and its assessment. Cleared when the goal changes. */
export const goalMetSchema = z.object({ at: z.string(), runId: z.number().int(), note: z.string().max(8000) });
export type GoalMet = z.infer<typeof goalMetSchema>;

export const sessionStateSchema = z.enum([
  "created", // initialized, no run yet
  "setup", // not initialized: a plan
  "running",
  "paused", // by you, or by a rate limit / size check
  "halted", // by the agent (request kind halt)
  "waiting", // nothing ready, open requests
  "finished", // board has no ready tickets and no open requests
]);
export type SessionState = z.infer<typeof sessionStateSchema>;

/** Per-role agents. `worker` runs the lead and Ask the box; `reviewer` defaults to the worker's agent. */
export const sessionAgentsSchema = z.object({
  worker: agentSpecSchema.optional(),
  reviewer: agentSpecSchema.optional(),
});
export type SessionAgents = z.infer<typeof sessionAgentsSchema>;

/** The jobs the harness starts. Logs of old runs also carry `implementer`, `goal`, `planner` and `setup`, from before one lead did everything. */
export type WorkerRole = "reviewer" | "prompt" | "lead";

/**
 * The agent for a role. Older sessions carry only `model`; that is the
 * worker's Claude model, so they keep running unchanged.
 */
export const agentFor = (s: { model?: string; agents?: SessionAgents }, role: WorkerRole): AgentSpec => {
  const worker: AgentSpec = s.agents?.worker ?? { driver: "claude", model: s.model || undefined };
  if (role === "reviewer" && s.agents?.reviewer) return s.agents.reviewer;
  return worker;
};

/** Every driver a session uses, worker first. */
export const sessionDrivers = (s: { model?: string; agents?: SessionAgents; caps?: { reviewer?: boolean } }): DriverName[] => {
  const out = [agentFor(s, "lead").driver];
  if (s.caps?.reviewer !== false) {
    const r = agentFor(s, "reviewer").driver;
    if (!out.includes(r)) out.push(r);
  }
  return out;
};

/** "codex · gpt-5.1" for a badge or a board line. */
export const describeAgent = (a: AgentSpec): string => `${a.driver}${a.model ? ` · ${a.model}` : ""}`;

export const sessionSchema = z.object({
  id: sessionIdSchema,
  name: z.string().min(1).max(200),
  /**
   * What the lead works toward, beside the board: anything from one line to
   * a specification, or empty when the board alone is the work. Read fresh
   * every lead life, so it can be edited at any time (`reviseGoal`).
   */
  goal: z.string().max(20_000).default(""),
  /** When the current goal text was set; absent for a goal that was never revised (the session's creation, then). */
  goalSince: z.string().optional(),
  /** The lead's last claim that the goal is met, until the goal changes. Starting again with the same goal means "not yet". */
  goalMet: goalMetSchema.optional(),
  /** Earlier goals of this session, oldest first: the project log a session keeps across goals. */
  goals: z.array(goalRecordSchema).default([]),
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
  /** Results of the last recipe run, one per script, in order. Empty until the container was first created. */
  setup: z.array(setupResultSchema).default([]),
  /** Prompts you ran from the session page (Ask the box: one worker, no ticket) with their replies; newest last, at most 20. Planning requests from before keep their kind. */
  prompts: z
    .array(z.object({ at: z.string(), runId: z.number().int(), kind: z.enum(["prompt", "plan"]).default("prompt"), text: z.string().max(20_000), reply: z.string().max(8000).default(""), stopReason: z.string().default("") }))
    .default([]),
  /**
   * The box as it was at the end of the last run (and at initialization),
   * committed to an image: the one record of what the lead installed
   * system-wide. A recreated container starts from it instead of a bare
   * image, as long as the base image has not changed since.
   */
  snapshot: z.object({ image: z.string(), at: z.string(), baseImageId: z.string() }).optional(),
  /** Set on a session started from another session's environment: which one and when. */
  environmentFrom: z.object({ session: z.string(), at: z.string() }).optional(),
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

/**
 * The session with a new goal text. The goal it replaces goes to the
 * history with how it ended: met when the worker had said so (its
 * assessment comes along), revised otherwise; an empty old goal leaves no
 * record. The met claim is cleared, since it was about the old text. The
 * same text (whitespace aside) changes nothing, so a save of an unchanged
 * editor is free.
 */
export const reviseGoal = (s: Session, text: string, at: string = now()): Session => {
  const next = text.trim();
  if (next === s.goal.trim()) return s;
  const previous: GoalRecord | null = s.goal.trim() ? { text: s.goal, from: s.goalSince ?? s.createdAt, until: at, outcome: s.goalMet ? "met" : "revised", note: s.goalMet?.note } : null;
  const { goalMet: _met, ...rest } = s;
  return { ...rest, goal: next, goalSince: at, goals: previous ? [...s.goals, previous].slice(-50) : s.goals };
};

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
  /** Lead lives this run has started. */
  rounds: z.number().int().nonnegative().optional(),
  cost: costSchema.default({ inputTokens: 0, outputTokens: 0 }),
  /** Why it is paused: "user" | "rate_limit" | "workspace_size" | "requests"; free text for the UI. */
  pauseReason: z.string().optional(),
  /** Rate-limit resets at this time; the loop sleeps until then. */
  resumeAt: z.string().optional(),
  /**
   * An agent terminal: you type to Claude Code or Codex in their own
   * interface, in the box, with the board tools. Absent on every other run
   * (and on runs from before terminals existed).
   */
  terminal: z.object({ driver: driverNameSchema }).optional(),
});
export type Run = z.infer<typeof runSchema>;

// --- Events (what the UI streams and runs/<n>/events.jsonl stores) ---------

/**
 * Verstas's own event schema. Worker drivers translate whatever their agent
 * emits into these, so the UI, the log files and the loop never depend on
 * one vendor's format.
 */
export const eventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), t: z.string(), ticket: ticketIdSchema.optional(), role: z.enum(["implementer", "reviewer", "planner", "setup", "prompt", "lead", "goal"]).optional(), text: z.string() }),
  z.object({ kind: z.literal("tool_use"), t: z.string(), ticket: ticketIdSchema.optional(), tool: z.string(), summary: z.string() }),
  z.object({ kind: z.literal("tool_result"), t: z.string(), ticket: ticketIdSchema.optional(), tool: z.string(), ok: z.boolean(), summary: z.string() }),
  z.object({ kind: z.literal("status"), t: z.string(), ticket: ticketIdSchema.optional(), text: z.string() }),
  // From before the harness stopped running checks: logs of old runs still carry gate events.
  z.object({ kind: z.literal("gate"), t: z.string(), ticket: ticketIdSchema.optional(), name: z.string(), ok: z.boolean(), summary: z.string() }),
  z.object({ kind: z.literal("ticket"), t: z.string(), ticket: ticketIdSchema, from: ticketStateSchema, to: ticketStateSchema, note: z.string().optional() }),
  z.object({ kind: z.literal("denied_network"), t: z.string(), host: z.string(), port: z.number().int() }),
  z.object({ kind: z.literal("request"), t: z.string(), requestId: z.string(), ticket: ticketIdSchema.optional(), summary: z.string() }),
  z.object({ kind: z.literal("cost"), t: z.string(), ticket: ticketIdSchema.optional(), cost: costSchema }),
  z.object({ kind: z.literal("run"), t: z.string(), state: runStateSchema, reason: z.string().optional() }),
  z.object({ kind: z.literal("error"), t: z.string(), ticket: ticketIdSchema.optional(), text: z.string() }),
  /** From before chores were removed: logs of old runs still carry sweep verdicts. */
  z.object({ kind: z.literal("chores"), t: z.string(), sweep: z.number().int(), accepted: z.boolean(), done: z.number().int(), dropped: z.number().int(), promoted: z.number().int(), note: z.string() }),
  /** The last line a worker writes; the harness reads it to decide what happens to the ticket. */
  z.object({
    kind: z.literal("worker_done"),
    t: z.string(),
    ticket: ticketIdSchema.optional(),
    role: z.enum(["implementer", "reviewer", "planner", "setup", "prompt", "lead", "goal"]),
    ok: z.boolean(),
    stopReason: z.string(),
    rateLimited: z.boolean(),
    costUsd: z.number(),
    turns: z.number().int(),
    seconds: z.number().int(),
    text: z.string(),
    stderr: z.string().default(""),
    /** The agent conversation this worker ran in, when the harness kept one (the lead's). */
    agentSession: z.string().optional(),
  }),
]);
export type VerstasEvent = z.infer<typeof eventSchema>;

export const now = (): string => new Date().toISOString();

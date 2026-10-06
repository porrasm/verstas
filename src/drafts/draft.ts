import { z } from "zod";
import {
  BOARD_FORMAT_VERSION,
  HOSTNAME_PATTERN,
  TICKET_ID_PATTERN,
  ticketIdSchema,
  ticketImportSchema,
  type BoardImport,
  type Ticket,
  type TicketImport,
} from "../core/types.js";
import { parseBoardPaste, validateDeps } from "../board/board.js";
import { DEFAULT_PACKS, PACK_NAMES } from "../network/packs.js";
import { SCRIPT_NAME_PATTERN } from "../scripts/library.js";

/**
 * A draft session: what a person or an assistant prepares before a session
 * exists. It is a plan only: no clones, no container, no run. Drafts are
 * written step by step (through the draft MCP server or by hand) and become
 * a session only when a person opens one in the app and presses Create on
 * the New session form, which is the same path every session takes.
 *
 * A draft holds what the form would hold, minus what only a person should
 * decide at creation time: caps, budget, model, memory limits and
 * attachments are set on the form. Recipes are picked from the library by
 * name; a draft never carries a script of its own.
 *
 * Validation is lenient while editing (a ticket may name a dependency that
 * is added later) and strict at creation, where the board goes through the
 * normal import. `validateDraft` reports what creation would refuse.
 */

export const DRAFT_FORMAT_VERSION = 1;
export const DRAFT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,80}$/;
export const MAX_DRAFT_TICKETS = 300;

/** Workspace directory names a repository may not take (session.ts reserves the same). */
export const RESERVED_REPO_NAMES = ["attachments", "notes", ".home"];

const repoDirName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const draftRepoSchema = z.object({
  /** A work target configured in Settings, by name. A draft cannot add work targets. */
  target: z.string().regex(repoDirName, "A work target name"),
  /** Branch to clone; the work target's checked-out branch when omitted. */
  branch: z.string().min(1).max(200).optional(),
  /** Directory under /workspace; the target name when omitted. */
  name: z.string().regex(repoDirName, "Letters, digits, . _ -").optional(),
});
export type DraftRepo = z.infer<typeof draftRepoSchema>;

const isIpLiteral = (h: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":");

export const draftHostSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(HOSTNAME_PATTERN, "A hostname or *.suffix")
  .refine((h) => !isIpLiteral(h), "IP literals are not allowed");

/** Packs a person can tick; "anthropic" is always on and never stored. */
export const draftPackSchema = z.enum(PACK_NAMES).refine((p) => p !== "anthropic", "The Claude API pack is always on; leave it out");

export const DRAFT_DEFAULT_PACKS = DEFAULT_PACKS.filter((p) => p !== "anthropic");

/** A ticket as a draft stores it: the import shape with its id fixed. */
export const draftTicketSchema = ticketImportSchema.extend({ id: ticketIdSchema });
export type DraftTicket = z.infer<typeof draftTicketSchema>;

export const draftSchema = z.object({
  verstasDraft: z.literal(DRAFT_FORMAT_VERSION),
  id: z.string().regex(DRAFT_ID_PATTERN),
  name: z.string().trim().min(1).max(200),
  /** The session goal: workers read it on every ticket; the planner drafts tickets from it. */
  goal: z.string().max(20_000).default(""),
  /** Session requirements, one per line: what the box must do before any ticket runs. */
  requirements: z.string().max(20_000).default(""),
  /** For the person who reviews the draft: assumptions, open questions, what was left out. */
  notes: z.string().max(20_000).default(""),
  repos: z.array(draftRepoSchema).max(20).default([]),
  packs: z.array(draftPackSchema).default([...DRAFT_DEFAULT_PACKS]),
  extraHosts: z.array(draftHostSchema).max(100).default([]),
  /** Recipe names from the library, in the order they run. */
  recipes: z.array(z.string().regex(SCRIPT_NAME_PATTERN)).max(30).default([]),
  tickets: z.array(draftTicketSchema).max(MAX_DRAFT_TICKETS).default([]),
  createdBy: z.enum(["agent", "user"]).default("agent"),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Set when a person created a session from it; the draft is read-only from then on. */
  promotedTo: z.string().optional(),
  promotedAt: z.string().optional(),
});
export type Draft = z.infer<typeof draftSchema>;

export type DraftErrorCode = "not_found" | "promoted" | "invalid" | "conflict";

export class DraftError extends Error {
  constructor(
    message: string,
    readonly code: DraftErrorCode,
  ) {
    super(message);
  }
}

/** "Nuppi MVP" -> "nuppi-mvp-3f2a": readable, and unique without a directory scan. */
export const makeDraftId = (name: string, random: () => string): string => {
  const slug =
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "draft";
  return `${slug.length < 3 ? `draft-${slug}` : slug}-${random()}`;
};

/** The workspace directory each repository gets. */
export const repoDirNames = (draft: Pick<Draft, "repos">): string[] => draft.repos.map((r) => r.name ?? r.target);

const ticketNumber = (id: string): number => Number(id.slice(2));

const nextId = (taken: Iterable<string>): string => {
  let max = 0;
  for (const id of taken) {
    const n = ticketNumber(id);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `T-${max + 1}`;
};

/** Input for a new ticket: the import shape, id optional. Defaults: kind feature, size M, priority 100, state ready. */
export type NewTicket = TicketImport;

/**
 * Appends tickets. A given id is kept when it is free, so a batch can name
 * its own ids and reference them in deps; a taken id is an error (update
 * that ticket instead). Missing ids get the next free number.
 */
export const addTickets = (draft: Draft, inputs: readonly NewTicket[]): { draft: Draft; ids: string[] } => {
  const parsed = inputs.map((t) => ticketImportSchema.parse(t));
  const existing = new Set(draft.tickets.map((t) => t.id));
  const asked = parsed.map((t) => t.id).filter((id): id is string => Boolean(id));
  for (const id of asked) {
    if (existing.has(id)) throw new DraftError(`${id} already exists in this draft; change it with draft_update_ticket or leave the id out to get a new one`, "conflict");
  }
  if (new Set(asked).size !== asked.length) throw new DraftError("Two new tickets ask for the same id", "conflict");
  if (draft.tickets.length + parsed.length > MAX_DRAFT_TICKETS) throw new DraftError(`A draft holds at most ${MAX_DRAFT_TICKETS} tickets`, "invalid");
  // Numbers go up in batch order; an id the batch asks for later is reserved, never handed out.
  const reserved = new Set(asked);
  const used = new Set(existing);
  const ids: string[] = [];
  const added: DraftTicket[] = parsed.map((t) => {
    let id = t.id;
    if (!id) {
      id = nextId(used);
      while (reserved.has(id)) id = `T-${ticketNumber(id) + 1}`;
    }
    used.add(id);
    ids.push(id);
    return draftTicketSchema.parse({ ...t, id, state: t.state ?? "ready" });
  });
  return { draft: { ...draft, tickets: [...draft.tickets, ...added] }, ids };
};

export const ticketPatchSchema = ticketImportSchema.omit({ id: true }).partial();
export type TicketPatch = z.infer<typeof ticketPatchSchema>;

/** Replaces the given fields of one ticket; fields left out stay as they are. */
export const updateTicket = (draft: Draft, id: string, patch: TicketPatch): Draft => {
  const p = ticketPatchSchema.parse(patch);
  const i = draft.tickets.findIndex((t) => t.id === id);
  if (i < 0) throw new DraftError(`No ticket ${id} in this draft`, "not_found");
  const tickets = [...draft.tickets];
  tickets[i] = draftTicketSchema.parse({ ...tickets[i], ...Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)) });
  return { ...draft, tickets };
};

/** Removes tickets and drops them from every other ticket's deps; reports which deps went away. */
export const removeTickets = (draft: Draft, ids: readonly string[]): { draft: Draft; removed: string[]; depsDropped: string[] } => {
  const gone = new Set(ids);
  const unknown = ids.filter((id) => !draft.tickets.some((t) => t.id === id));
  if (unknown.length) throw new DraftError(`No ticket ${unknown.join(", ")} in this draft`, "not_found");
  const depsDropped: string[] = [];
  const tickets = draft.tickets
    .filter((t) => !gone.has(t.id))
    .map((t) => {
      const deps = (t.deps ?? []).filter((d) => !gone.has(d));
      if (deps.length !== (t.deps ?? []).length) depsDropped.push(`${t.id} no longer depends on ${(t.deps ?? []).filter((d) => gone.has(d)).join(", ")}`);
      return { ...t, deps };
    });
  return { draft: { ...draft, tickets }, removed: [...gone], depsDropped };
};

/**
 * A whole board pasted at once (JSON or the markdown form in docs/BOARD.md).
 * "replace" clears the tickets first; "merge" updates tickets whose id
 * exists and appends the rest (keeping a free id, numbering the others).
 * A goal in the paste replaces the draft's goal.
 */
export const importIntoDraft = (draft: Draft, text: string, mode: "merge" | "replace"): { draft: Draft; created: string[]; updated: string[] } => {
  let parsed: BoardImport;
  try {
    parsed = parseBoardPaste(text);
  } catch (e) {
    const msg = e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : (e as Error).message;
    throw new DraftError(`Not a board: ${msg}`, "invalid");
  }
  let next: Draft = { ...draft, goal: parsed.goal ?? draft.goal, tickets: mode === "replace" ? [] : draft.tickets };
  const created: string[] = [];
  const updated: string[] = [];
  const fresh: NewTicket[] = [];
  for (const t of parsed.tickets) {
    if (t.id && next.tickets.some((x) => x.id === t.id)) {
      const { id, ...patch } = t;
      next = updateTicket(next, id, patch);
      updated.push(id);
    } else {
      // An id already promised to an earlier ticket in this paste would collide: renumber it.
      fresh.push(t.id && fresh.some((f) => f.id === t.id) ? { ...t, id: undefined } : t);
    }
  }
  const added = addTickets(next, fresh);
  created.push(...added.ids);
  return { draft: added.draft, created, updated };
};

export type DraftEnv = {
  /** Work targets configured in Settings. */
  workTargets: readonly { name: string }[];
  /** Recipe names in the library. */
  recipes: readonly string[];
};

export type DraftProblems = { errors: string[]; warnings: string[] };

/**
 * What creating a session from this draft would refuse (errors) and what
 * makes a weak board (warnings). Errors block "Continue" in the app.
 */
export const validateDraft = (draft: Draft, env: DraftEnv): DraftProblems => {
  const errors: string[] = [];
  const warnings: string[] = [];
  const targets = new Set(env.workTargets.map((w) => w.name));
  const dirs = repoDirNames(draft);

  for (const r of draft.repos) if (!targets.has(r.target)) errors.push(`Repository "${r.target}" is not a work target (known: ${[...targets].join(", ") || "none; add them in Settings"})`);
  const seen = new Set<string>();
  for (const d of dirs) {
    if (RESERVED_REPO_NAMES.includes(d)) errors.push(`"${d}" is reserved under /workspace; give the repository another name`);
    if (seen.has(d)) errors.push(`Two repositories use the directory name "${d}"`);
    seen.add(d);
  }
  for (const name of draft.recipes) if (!env.recipes.includes(name)) errors.push(`Recipe "${name}" is not in the library`);
  if (new Set(draft.recipes).size !== draft.recipes.length) warnings.push("A recipe is listed twice; it would run twice");

  if (!draft.tickets.length && !draft.goal.trim()) errors.push("Nothing to work on: add tickets, or a goal the planner can draft tickets from");
  const ids = new Set(draft.tickets.map((t) => t.id));
  for (const t of draft.tickets) {
    if (t.repo && !dirs.includes(t.repo)) {
      errors.push(dirs.length ? `${t.id} names repo "${t.repo}", but the draft's repositories are: ${dirs.join(", ")}` : `${t.id} names repo "${t.repo}", but the draft has no repositories`);
    }
    for (const d of t.deps ?? []) if (!ids.has(d)) errors.push(`${t.id} depends on ${d}, which is not in the draft`);
  }
  // Cycles, with the board's own check (it reads only ids and deps).
  try {
    validateDeps(draft.tickets.filter((t) => (t.deps ?? []).every((d) => ids.has(d))).map((t) => ({ id: t.id, deps: t.deps ?? [] }) as unknown as Ticket));
  } catch (e) {
    errors.push((e as Error).message);
  }

  if (!draft.repos.length) warnings.push("No repositories: workers would start in an empty /workspace");
  const noAcceptance = draft.tickets.filter((t) => !(t.acceptance ?? []).length).map((t) => t.id);
  if (noAcceptance.length) warnings.push(`No acceptance criteria: ${noAcceptance.join(", ")} (the reviewer has nothing to check)`);
  const noSpec = draft.tickets.filter((t) => !(t.spec ?? "").trim()).map((t) => t.id);
  if (noSpec.length) warnings.push(`No spec: ${noSpec.join(", ")} (a fresh worker sees only the title)`);
  const large = draft.tickets.filter((t) => t.size === "L").map((t) => t.id);
  if (large.length) warnings.push(`Size L: ${large.join(", ")} (consider splitting; one worker has a fixed time and turn budget)`);
  if (dirs.length > 1) {
    const noRepo = draft.tickets.filter((t) => !t.repo).map((t) => t.id);
    if (noRepo.length) warnings.push(`No repo on ${noRepo.join(", ")} while the draft has ${dirs.length} repositories`);
  }
  const titles = new Map<string, string>();
  for (const t of draft.tickets) {
    const k = t.title.trim().toLowerCase();
    if (titles.has(k)) warnings.push(`${titles.get(k)} and ${t.id} have the same title`);
    else titles.set(k, t.id);
  }
  if (!draft.tickets.some((t) => t.state === "ready") && draft.tickets.length) warnings.push("Every ticket is in backlog: nothing runs until a person moves one to ready");
  return { errors, warnings };
};

/** The board exactly as the New session form imports it. */
export const draftBoard = (draft: Draft): BoardImport & { verstas: number } => ({
  verstas: BOARD_FORMAT_VERSION,
  goal: draft.goal,
  tickets: draft.tickets.map((t) => ({ ...t, state: t.state ?? "ready" })),
  chores: [],
});

export const draftBoardText = (draft: Draft): string => JSON.stringify(draftBoard(draft), null, 2) + "\n";

/** One line per ticket, for lists and for assistants that do not need every spec. */
export const ticketSummary = (t: DraftTicket) => ({
  id: t.id,
  title: t.title,
  kind: t.kind ?? "feature",
  repo: t.repo,
  size: t.size ?? "M",
  priority: t.priority ?? 100,
  deps: t.deps ?? [],
  state: t.state ?? "ready",
  pinned: t.pinned ?? false,
  agent: t.agent,
  acceptance: (t.acceptance ?? []).length,
  specChars: (t.spec ?? "").length,
});

export const isTicketId = (s: string): boolean => TICKET_ID_PATTERN.test(s);

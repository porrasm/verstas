import {
  boardImportSchema,
  BOARD_FORMAT_VERSION,
  now,
  TICKET_ID_PATTERN,
  type Board,
  type BoardImport,
  type ReviewMode,
  type Ticket,
  importRepos,
  type TicketImport,
  type TicketKind,
  type TicketState,
} from "../core/types.js";

/**
 * Pure board logic: legal state transitions, what an agent may change, and
 * import/merge. No IO; the store module reads
 * and writes the file.
 */

export class BoardError extends Error {
  constructor(
    message: string,
    readonly code:
      | "illegal_transition"
      | "unknown_ticket"
      | "unknown_dep"
      | "dep_cycle"
      | "forbidden_move"
      | "unknown_repo",
  ) {
    super(message);
  }
}

/** Transitions the harness and the user may make. */
const TRANSITIONS: Record<TicketState, readonly TicketState[]> = {
  backlog: ["ready", "in_progress"],
  ready: ["in_progress", "backlog"],
  // done straight from in_progress is for a session without a reviewer (and for you); with one, done comes from review.
  in_progress: ["review", "waiting", "blocked", "ready", "done"],
  review: ["done", "ready", "blocked", "waiting"],
  waiting: ["ready", "blocked", "backlog"],
  blocked: ["ready", "backlog"],
  done: ["ready"], // reopen
};

export const canTransition = (from: TicketState, to: TicketState): boolean =>
  TRANSITIONS[from].includes(to);

export const getTicket = (board: Board, id: string): Ticket => {
  const t = board.tickets.find((x) => x.id === id);
  if (!t) throw new BoardError(`No ticket ${id}`, "unknown_ticket");
  return t;
};

/** Returns a new board with the ticket moved; never mutates. */
export const transition = (
  board: Board,
  id: string,
  to: TicketState,
  note?: { by: "user" | "agent" | "harness"; text: string },
): Board => {
  const t = getTicket(board, id);
  if (!canTransition(t.state, to)) {
    throw new BoardError(`Cannot move ${id} from ${t.state} to ${to}`, "illegal_transition");
  }
  const at = now();
  const updated: Ticket = {
    ...t,
    ...withStateClock(t, to, at),
    state: to,
    updatedAt: at,
    notes: note ? [...t.notes, { at, by: note.by, text: note.text }] : t.notes,
  };
  return replaceTicket(board, updated);
};

/**
 * The timing fields after a move from the ticket's state to `to` at `at`:
 * the visit that ends is added to timeIn, the clock restarts, and the first
 * claim is remembered. A ticket from before timing started its clock now.
 */
export const withStateClock = (t: Ticket, to: TicketState, at: string): Pick<Ticket, "stateSince" | "timeIn" | "firstClaimAt" | "readyBeforeClaim"> => {
  const timeIn = { ...t.timeIn };
  if (t.stateSince) timeIn[t.state] = (timeIn[t.state] ?? 0) + Math.max(0, (Date.parse(at) - Date.parse(t.stateSince)) / 1000);
  const firstClaim = !t.firstClaimAt && to === "in_progress";
  return {
    stateSince: at,
    timeIn: t.stateSince ? timeIn : t.timeIn,
    firstClaimAt: firstClaim ? at : t.firstClaimAt,
    readyBeforeClaim: firstClaim ? (timeIn.ready ?? 0) : t.readyBeforeClaim,
  };
};

export const replaceTicket = (board: Board, ticket: Ticket): Board => ({
  ...board,
  tickets: board.tickets.map((t) => (t.id === ticket.id ? ticket : t)),
});

export const addNote = (
  board: Board,
  id: string,
  by: "user" | "agent" | "harness",
  text: string,
): Board => {
  const t = getTicket(board, id);
  const at = now();
  return replaceTicket(board, { ...t, updatedAt: at, notes: [...t.notes, { at, by, text }] });
};

export const hasOpenWork = (board: Board): boolean =>
  board.tickets.some((t) => t.state === "ready" || t.state === "in_progress" || t.state === "review");

// --- Ids -------------------------------------------------------------------

export const nextTicketId = (board: Board, extra: readonly string[] = []): string => {
  let max = 0;
  for (const id of [...board.tickets.map((t) => t.id), ...extra]) {
    const n = Number(id.slice(2));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `T-${max + 1}`;
};

// --- Dependencies -----------------------------------------------------------

/** Throws on a dependency that does not exist or a cycle. */
export const validateDeps = (tickets: readonly Ticket[]): void => {
  const ids = new Set(tickets.map((t) => t.id));
  for (const t of tickets) {
    for (const d of t.deps) {
      if (!ids.has(d)) throw new BoardError(`${t.id} depends on unknown ${d}`, "unknown_dep");
    }
  }
  // DFS cycle detection
  const state = new Map<string, 0 | 1 | 2>();
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const visit = (id: string, path: string[]): void => {
    const s = state.get(id) ?? 0;
    if (s === 2) return;
    if (s === 1) throw new BoardError(`Dependency cycle: ${[...path, id].join(" -> ")}`, "dep_cycle");
    state.set(id, 1);
    for (const d of byId.get(id)?.deps ?? []) visit(d, [...path, id]);
    state.set(id, 2);
  };
  for (const t of tickets) visit(t.id, []);
};

/** A ticket's expected repositories that are not among the session's. */
export const unknownRepos = (t: Pick<Ticket, "repos">, repoNames: readonly string[]): string[] => t.repos.filter((r) => !repoNames.includes(r));

/**
 * Every repository a ticket expects must be one of the session's. The list
 * is a hint, so this only catches typos: checked at session creation, on
 * import, create and edit. A run notes an unknown name and goes on.
 */
export const validateRepos = (tickets: readonly Pick<Ticket, "id" | "repos" | "state">[], repoNames: readonly string[], opts: { ignoreDone?: boolean } = {}): void => {
  const bad = tickets.filter((t) => unknownRepos(t, repoNames).length && !(opts.ignoreDone && t.state === "done"));
  if (!bad.length) return;
  const names = [...new Set(bad.flatMap((t) => unknownRepos(t, repoNames)))].map((r) => `"${r}"`).join(", ");
  throw new BoardError(
    `${bad.map((t) => t.id).join(", ")} name${bad.length === 1 ? "s" : ""} repo ${names}, but the session's repositories are: ${repoNames.join(", ") || "none"}`,
    "unknown_repo",
  );
};

// --- The agent's limited powers --------------------------------------------

/**
 * Who is calling the agent API: a worker on a job (the reviewer, setup, a
 * prompt), the lead that works the board, or the agent in
 * your terminal (you are typing to it, so it plans with you).
 */
export type AgentRole = "worker" | "lead" | "terminal";

/** Reprioritizing by an agent. The reason is mandatory and lands in the notes. */
export const agentSetPriority = (board: Board, id: string, priority: number, reason: string): Board => {
  const t = getTicket(board, id);
  const at = now();
  return replaceTicket(board, {
    ...t,
    priority,
    updatedAt: at,
    notes: [...t.notes, { at, by: "agent", text: `Priority ${t.priority} -> ${priority}: ${reason}` }],
  });
};

export const agentAddDep = (board: Board, id: string, dep: string, reason: string): Board => {
  const t = getTicket(board, id);
  getTicket(board, dep);
  if (t.deps.includes(dep)) return board;
  const at = now();
  const next = replaceTicket(board, {
    ...t,
    deps: [...t.deps, dep],
    updatedAt: at,
    notes: [...t.notes, { at, by: "agent", text: `Now depends on ${dep}: ${reason}` }],
  });
  validateDeps(next.tickets);
  return next;
};

/** What the lead or the agent in your terminal may change on a ticket. */
export type TicketEdit = Partial<Pick<Ticket, "title" | "kind" | "spec" | "acceptance" | "repos" | "deps" | "priority">> & { state?: "backlog" | "ready" };

/**
 * An edit by the lead or the agent in your terminal: any ticket but one in
 * review, which the reviewer is reading. A state change follows the same
 * transitions as yours. The reason lands in the notes.
 */
export const editTicket = (board: Board, id: string, patch: TicketEdit, reason: string): Board => {
  const t = getTicket(board, id);
  if (t.state === "review") throw new BoardError(`${id} is in review: wait for the verdict`, "forbidden_move");
  const at = now();
  const fields = Object.fromEntries(Object.entries(patch).filter(([k, v]) => v !== undefined && k !== "state")) as Partial<Ticket>;
  let next: Ticket = { ...t, ...fields, updatedAt: at, notes: [...t.notes, { at, by: "agent", text: `Edited (${Object.keys(patch).join(", ") || "nothing"}): ${reason}` }] };
  if (patch.state && patch.state !== t.state) {
    if (!canTransition(t.state, patch.state)) throw new BoardError(`${id} cannot move from ${t.state} to ${patch.state}`, "illegal_transition");
    next = { ...next, ...withStateClock(t, patch.state, at), state: patch.state };
  }
  for (const dep of next.deps) getTicket(board, dep);
  const out = replaceTicket(board, next);
  validateDeps(out.tickets);
  return out;
};

/**
 * Deletion by the lead or the agent in your terminal, for merges and
 * tickets that no longer apply. Tickets that depended on it depend on
 * `replacedBy` instead (the ticket it was merged into), or on nothing more;
 * each says so in its notes. Never a ticket in review.
 */
export const deleteTicket = (board: Board, id: string, reason: string, replacedBy?: string): Board => {
  const t = getTicket(board, id);
  if (t.state === "review") throw new BoardError(`${id} is in review: wait for the verdict`, "forbidden_move");
  if (replacedBy !== undefined) {
    if (replacedBy === id) throw new BoardError(`${id} cannot replace itself`, "unknown_dep");
    getTicket(board, replacedBy);
  }
  const at = now();
  const tickets = board.tickets
    .filter((x) => x.id !== id)
    .map((x) => {
      if (!x.deps.includes(id)) return x;
      const deps = [...new Set(x.deps.flatMap((d) => (d !== id ? [d] : replacedBy && replacedBy !== x.id ? [replacedBy] : [])))];
      const text = `Depended on ${id}, which was deleted (${reason})${replacedBy && replacedBy !== x.id ? `; now depends on ${replacedBy}` : ""}`;
      return { ...x, deps, updatedAt: at, notes: [...x.notes, { at, by: "agent" as const, text }] };
    });
  validateDeps(tickets);
  return { ...board, tickets };
};

// --- Import / merge --------------------------------------------------------

export type ImportResult = {
  board: Board;
  created: string[];
  updated: string[];
  skipped: { title: string; reason: string }[];
  /** In "add" mode: pasted ids that were taken on the board, and the id each ticket got. */
  renumbered: { from: string; to: string }[];
  /** Pasted ids that name a ticket already on the board: what "merge" would update. */
  matching: string[];
};

/**
 * Every pasted ticket as a new one, each with its id settled. Ids are kept
 * when none of them is taken on the board (or twice in the paste); when one
 * is, the whole paste is renumbered after the board's last ticket, in paste
 * order, so the new work reads as one run of ids. A dependency on an id in
 * the paste follows the ticket to its new id; any other dependency names a
 * ticket already on the board. A ticket without a T-n id gets the next free
 * one, past every id the paste keeps.
 */
const asAdditions = (board: Board, incoming: readonly TicketImport[]): { tickets: TicketImport[]; renumbered: ImportResult["renumbered"] } => {
  const taken = new Set(board.tickets.map((t) => t.id));
  const ids = incoming.map((t) => t.id?.trim() || undefined);
  const real = ids.filter((id): id is string => Boolean(id && TICKET_ID_PATTERN.test(id)));
  const clash = real.some((id) => taken.has(id)) || new Set(real).size !== real.length;
  const map = new Map<string, string>();
  const assigned: string[] = clash ? [] : [...real];
  const fresh = ids.map((id) => {
    const own = id && TICKET_ID_PATTERN.test(id) ? id : undefined;
    if (own && !clash) return own;
    const to = nextTicketId(board, assigned);
    assigned.push(to);
    if (own && !map.has(own)) map.set(own, to);
    return to;
  });
  return {
    tickets: incoming.map((t, i) => ({ ...t, id: fresh[i], deps: t.deps?.map((d) => map.get(d) ?? d) })),
    renumbered: [...map].map(([from, to]) => ({ from, to })),
  };
};

/**
 * Brings an import onto a board, in one of two ways.
 *
 * "merge" (the default): a ticket with a known id updates the editable
 * fields (not the state unless the current one is backlog or ready); a
 * ticket without an id, or with an unknown one, is appended with a fresh
 * id. Re-importing an export this way revises the plan in place.
 *
 * "add": every ticket is new, whatever its id says (see asAdditions). This
 * is what pasting the next piece of work onto a used board needs: a paste
 * numbered T-1… must not rewrite the board's own T-1….
 *
 * Deps are validated at the end against the whole result. `by` records who
 * imported in the notes.
 */
export const importBoard = (
  board: Board,
  input: unknown,
  opts: { by: "user" | "agent"; role?: AgentRole; defaultState?: "backlog" | "ready"; mode?: "merge" | "add" } = { by: "user" },
): ImportResult => {
  const parsed: BoardImport = boardImportSchema.parse(input);
  const at = now();
  let tickets = [...board.tickets];
  const created: string[] = [];
  const updated: string[] = [];
  const skipped: ImportResult["skipped"] = [];
  const assigned: string[] = [];
  const onBoard = new Set(board.tickets.map((t) => t.id));
  const matching = [...new Set(parsed.tickets.map((t) => t.id?.trim() ?? "").filter((id) => onBoard.has(id)))];
  const additions = opts.mode === "add" ? asAdditions(board, parsed.tickets) : { tickets: parsed.tickets, renumbered: [] };

  for (const inc of additions.tickets) {
    const kind = inc.kind ?? "feature";
    // An empty or foreign id (a generator's "J-1") is no id: the ticket is appended with the next free T-n.
    const incId = inc.id?.trim() || undefined;
    const existing = incId ? tickets.find((t) => t.id === incId) : undefined;
    if (existing) {
      const canSetState = existing.state === "backlog" || existing.state === "ready";
      const next: Ticket = {
        ...existing,
        title: inc.title,
        kind,
        repos: importRepos(inc) ?? existing.repos,
        priority: inc.priority ?? existing.priority,
        deps: inc.deps ?? existing.deps,
        spec: inc.spec ?? existing.spec,
        acceptance: inc.acceptance ?? existing.acceptance,
        review: opts.by === "user" ? (inc.review ?? existing.review) : existing.review,
        ...(canSetState && inc.state && inc.state !== existing.state ? withStateClock(existing, inc.state, at) : {}),
        state: canSetState && inc.state ? inc.state : existing.state,
        notes: [
          ...existing.notes,
          ...(inc.notes ?? []).map((text) => ({ at, by: opts.by, text })),
        ],
        updatedAt: at,
      };
      tickets = tickets.map((t) => (t.id === next.id ? next : t));
      updated.push(next.id);
    } else {
      const id = incId && !tickets.some((t) => t.id === incId) && TICKET_ID_PATTERN.test(incId)
        ? incId
        : nextTicketId({ ...board, tickets }, assigned);
      assigned.push(id);
      const t: Ticket = {
        id,
        title: inc.title,
        kind,
        repos: importRepos(inc) ?? [],
        priority: inc.priority ?? 100,
        deps: inc.deps ?? [],
        state: inc.state ?? opts.defaultState ?? "backlog",
        spec: inc.spec ?? "",
        acceptance: inc.acceptance ?? [],
        notes: (inc.notes ?? []).map((text) => ({ at, by: opts.by, text })),
        review: opts.by === "user" ? inc.review : undefined,
        stateSince: at,
        createdAt: at,
        updatedAt: at,
      };
      tickets.push(t);
      created.push(id);
    }
  }

  validateDeps(tickets);
  const next: Board = { ...board, verstas: BOARD_FORMAT_VERSION, goal: parsed.goal ?? board.goal, tickets };
  return { board: next, created, updated, skipped, renumbered: additions.renumbered, matching };
};

export const emptyBoard = (goal = ""): Board => ({ verstas: BOARD_FORMAT_VERSION, goal, tickets: [] });

export const exportBoard = (board: Board): string => JSON.stringify(board, null, 2) + "\n";

// --- Markdown import -------------------------------------------------------

/**
 * Accepts the loose markdown an assistant writes when asked for a backlog:
 *
 *   ## T-3 · Mapping engine: CC and notes
 *   Repos: nuppi, docs · Deps: T-1, T-2 · Priority: 20
 *   Free text spec…
 *   - [ ] acceptance item
 *   - [ ] another
 *
 * Headings at level 2 or 3 start a ticket. The id and the "Key: value" line
 * are optional; a size in parentheses after the title, from before, is
 * dropped. Checklist items become acceptance criteria; everything else is
 * the spec. A top-level "# " line before the first ticket is the goal. A
 * "## Chores" section, from before, is skipped.
 */
export const parseMarkdownBoard = (md: string): BoardImport => {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const tickets: TicketImport[] = [];
  let goal: string | undefined;
  let cur: (TicketImport & { specLines: string[] }) | null = null;
  let inChores = false;

  const flush = () => {
    if (!cur) return;
    const { specLines, ...rest } = cur;
    const spec = specLines.join("\n").trim();
    tickets.push({ ...rest, spec: spec || undefined });
    cur = null;
  };

  for (const raw of lines) {
    const heading = /^#{2,3}\s+(.*)$/.exec(raw);
    if (heading && /^chores$/i.test(heading[1]!.trim())) {
      // "## Chores", from before chores were removed: skipped.
      flush();
      inChores = true;
      continue;
    }
    if (inChores && !heading) continue;
    if (heading) {
      inChores = false;
      flush();
      let title = heading[1]!.trim();
      let id: string | undefined;
      const idMatch = /^(T-\d+)\s*[·:.\-–—]?\s*(.*)$/.exec(title);
      if (idMatch) {
        id = idMatch[1];
        title = idMatch[2]!.trim();
      }
      const sizeMatch = /\(\s*[SML]\s*\)\s*$/.exec(title);
      if (sizeMatch) title = title.slice(0, sizeMatch.index).trim();
      cur = { id, title: title || "Untitled", specLines: [] };
      continue;
    }
    if (!cur) {
      const h1 = /^#\s+(.*)$/.exec(raw);
      if (h1 && !goal) goal = h1[1]!.trim();
      continue;
    }
    const check = /^\s*[-*]\s*\[[ xX]?\]\s*(.*)$/.exec(raw);
    if (check) {
      cur.acceptance = [...(cur.acceptance ?? []), check[1]!.trim()];
      continue;
    }
    const kv = /^\s*((?:Repos?|Deps|Priority|Size|Kind|State|Pinned|Agent|Review)\s*:\s*[^·|]+(?:\s*[·|]\s*(?:Repos?|Deps|Priority|Size|Kind|State|Pinned|Agent|Review)\s*:\s*[^·|]+)*)\s*$/i.exec(raw);
    if (kv) {
      for (const part of kv[1]!.split(/\s*[·|]\s*/)) {
        const [k, ...v] = part.split(":");
        const key = k!.trim().toLowerCase();
        const val = v.join(":").trim();
        if (key === "repo" || key === "repos") cur.repos = val.split(/[,\s]+/).filter(Boolean);
        else if (key === "deps") cur.deps = val.split(/[,\s]+/).filter((d) => TICKET_ID_PATTERN.test(d));
        else if (key === "priority" && /^\d+$/.test(val)) cur.priority = Number(val);
        else if (key === "kind" && /^(feature|bug|followup|chore)$/i.test(val)) cur.kind = val.toLowerCase() as TicketKind;
        else if (key === "state" && /^(backlog|ready)$/i.test(val)) cur.state = val.toLowerCase() as "backlog" | "ready";
        else if (key === "review" && /^(full|checks|none)$/i.test(val)) cur.review = val.toLowerCase() as ReviewMode;
      }
      continue;
    }
    cur.specLines.push(raw);
  }
  flush();
  return boardImportSchema.parse({ goal, tickets });
};

/** Detects the paste format and returns an import. JSON that fails to parse is treated as markdown. */
export const parseBoardPaste = (text: string): BoardImport => {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const json: unknown = JSON.parse(trimmed);
    return boardImportSchema.parse(Array.isArray(json) ? { tickets: json } : json);
  }
  return parseMarkdownBoard(text);
};

import {
  boardImportSchema,
  BOARD_FORMAT_VERSION,
  CHORE_ID_PATTERN,
  now,
  TICKET_ID_PATTERN,
  type Board,
  type BoardImport,
  type Chore,
  type ChoreImport,
  type Sweep,
  type SweepResult,
  type Ticket,
  type TicketImport,
  type TicketKind,
  type TicketState,
} from "../core/types.js";

/**
 * Pure board logic: picking the next ticket, legal state transitions, the
 * agent's limited powers, and import/merge. No IO; the store module reads
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
      | "pinned"
      | "forbidden_kind"
      | "forbidden_move"
      | "unknown_repo"
      | "unknown_chore"
      | "chore_state"
      | "sweep_in_flight"
      | "no_sweep",
  ) {
    super(message);
  }
}

/** Transitions the harness and the user may make. */
const TRANSITIONS: Record<TicketState, readonly TicketState[]> = {
  backlog: ["ready"],
  ready: ["in_progress", "backlog"],
  in_progress: ["review", "waiting", "blocked", "ready"],
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
    state: to,
    updatedAt: at,
    notes: note ? [...t.notes, { at, by: note.by, text: note.text }] : t.notes,
  };
  return replaceTicket(board, updated);
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

const isDone = (board: Board, id: string): boolean =>
  board.tickets.some((t) => t.id === id && t.state === "done");

/** Ready and every dependency done: what the loop may take and what a lead may claim. */
export const canStart = (board: Board, t: Ticket): boolean => t.state === "ready" && t.deps.every((d) => isDone(board, d));

/**
 * The next ticket the loop should take: ready, every dependency done, lowest
 * priority number first, then oldest. Unknown dependencies count as unmet so
 * a typo cannot unblock a ticket.
 */
export const nextReady = (board: Board): Ticket | undefined =>
  board.tickets
    .filter((t) => canStart(board, t))
    .sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0];

/** Ready tickets whose dependencies are not all done; shown as "ready, waiting on …". */
export const readyButWaitingOnDeps = (board: Board): Ticket[] =>
  board.tickets.filter((t) => t.state === "ready" && !t.deps.every((d) => isDone(board, d)));

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

/**
 * Every ticket that names a repo must name one of the session's. Checked at
 * session creation, on import, on create and edit, and before a run starts,
 * so a board can never reference a clone that is not in the workspace.
 */
export const validateRepos = (tickets: readonly Pick<Ticket, "id" | "repo" | "state">[], repoNames: readonly string[], opts: { ignoreDone?: boolean } = {}): void => {
  const bad = tickets.filter((t) => t.repo && !repoNames.includes(t.repo) && !(opts.ignoreDone && t.state === "done"));
  if (!bad.length) return;
  const names = [...new Set(bad.map((t) => t.repo))].map((r) => `"${r}"`).join(", ");
  throw new BoardError(
    `${bad.map((t) => t.id).join(", ")} name${bad.length === 1 ? "s" : ""} repo ${names}, but the session's repositories are: ${repoNames.join(", ") || "none"}`,
    "unknown_repo",
  );
};

// --- The agent's limited powers --------------------------------------------

/** Who is calling the agent API: a worker on a ticket, the planner, or a lead that works the board. */
export type AgentRole = "worker" | "planner" | "lead";

export const AGENT_TICKET_KINDS: readonly TicketKind[] = ["bug", "followup", "chore"];

/** Workers create tickets of these kinds only; the planner and a lead may also create features (into the backlog, for your approval). */
export const assertAgentMayCreate = (kind: TicketKind, role: AgentRole): void => {
  if (role === "planner" || role === "lead") return;
  if (!AGENT_TICKET_KINDS.includes(kind)) {
    throw new BoardError(`A worker may not create ${kind} tickets; file an idea instead`, "forbidden_kind");
  }
};

/**
 * Reprioritizing by the agent: never a pinned ticket, and never a move that
 * takes a ticket out of ready (that is the user's call). A reason is
 * mandatory and lands in the notes.
 */
export const agentSetPriority = (board: Board, id: string, priority: number, reason: string): Board => {
  const t = getTicket(board, id);
  if (t.pinned) throw new BoardError(`${id} is pinned`, "pinned");
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
  if (t.pinned) throw new BoardError(`${id} is pinned`, "pinned");
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

// --- Import / merge --------------------------------------------------------

export type ImportResult = {
  board: Board;
  created: string[];
  updated: string[];
  skipped: { title: string; reason: string }[];
  /** Chores created by this import. */
  chores: string[];
};

/**
 * Merges an import into a board. A ticket with a known id updates the
 * editable fields (not the state unless the current one is backlog or
 * ready); a ticket without an id, or with an unknown one, is appended with
 * a fresh id. Deps are validated at the end against the whole result.
 *
 * `by` records who imported in the notes; `role` limits kinds for agents.
 */
export const importBoard = (
  board: Board,
  input: unknown,
  opts: { by: "user" | "agent"; role?: AgentRole; defaultState?: "backlog" | "ready" } = { by: "user" },
): ImportResult => {
  const parsed: BoardImport = boardImportSchema.parse(input);
  const at = now();
  let tickets = [...board.tickets];
  const created: string[] = [];
  const updated: string[] = [];
  const skipped: ImportResult["skipped"] = [];
  const assigned: string[] = [];

  for (const inc of parsed.tickets) {
    const kind = inc.kind ?? "feature";
    if (opts.by === "agent") {
      try {
        assertAgentMayCreate(kind, opts.role ?? "worker");
      } catch (e) {
        skipped.push({ title: inc.title, reason: (e as Error).message });
        continue;
      }
    }
    const existing = inc.id ? tickets.find((t) => t.id === inc.id) : undefined;
    if (existing) {
      const canSetState = existing.state === "backlog" || existing.state === "ready";
      const next: Ticket = {
        ...existing,
        title: inc.title,
        kind,
        repo: inc.repo ?? existing.repo,
        size: inc.size ?? existing.size,
        priority: inc.priority ?? existing.priority,
        deps: inc.deps ?? existing.deps,
        spec: inc.spec ?? existing.spec,
        acceptance: inc.acceptance ?? existing.acceptance,
        pinned: inc.pinned ?? existing.pinned,
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
      const id = inc.id && !tickets.some((t) => t.id === inc.id) && TICKET_ID_PATTERN.test(inc.id)
        ? inc.id
        : nextTicketId({ ...board, tickets }, assigned);
      assigned.push(id);
      const t: Ticket = {
        id,
        title: inc.title,
        kind,
        repo: inc.repo,
        size: inc.size ?? "M",
        priority: inc.priority ?? 100,
        deps: inc.deps ?? [],
        state: inc.state ?? opts.defaultState ?? "backlog",
        spec: inc.spec ?? "",
        acceptance: inc.acceptance ?? [],
        notes: (inc.notes ?? []).map((text) => ({ at, by: opts.by, text })),
        attempts: 0,
        pinned: inc.pinned ?? false,
        createdAt: at,
        updatedAt: at,
      };
      tickets.push(t);
      created.push(id);
    }
  }

  validateDeps(tickets);
  let next: Board = { ...board, verstas: BOARD_FORMAT_VERSION, goal: parsed.goal ?? board.goal, tickets };
  const chores: string[] = [];
  for (const inc of parsed.chores) {
    const existing = inc.id ? next.chores.find((c) => c.id === inc.id) : undefined;
    if (existing) {
      if (existing.state === "proposed" || existing.state === "open") {
        next = replaceChore(next, { ...existing, text: inc.text, where: inc.where ?? existing.where, repo: inc.repo ?? existing.repo, state: inc.state ?? existing.state, updatedAt: at });
      }
      continue;
    }
    const r = addChore(next, inc, opts.by, { state: inc.state ?? (opts.by === "user" ? "open" : undefined) });
    next = r.board;
    chores.push(r.id);
  }
  return { board: next, created, updated, skipped, chores };
};

export const emptyBoard = (goal = ""): Board => ({ verstas: BOARD_FORMAT_VERSION, goal, tickets: [], chores: [] });

// --- Chores ----------------------------------------------------------------
// Small fixes outside the ticket flow: filed by anyone, swept by a lead in
// batches, committed by the harness after the checks and a size check.

export const nextChoreId = (board: Board, extra: readonly string[] = []): string => {
  let max = 0;
  for (const id of [...board.chores.map((c) => c.id), ...extra]) {
    const n = Number(id.slice(2));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `C-${max + 1}`;
};

export const getChore = (board: Board, id: string): Chore => {
  const c = board.chores.find((x) => x.id === id);
  if (!c) throw new BoardError(`No chore ${id}`, "unknown_chore");
  return c;
};

export const replaceChore = (board: Board, chore: Chore): Board => ({ ...board, chores: board.chores.map((c) => (c.id === chore.id ? chore : c)) });

/** Chores a sweep may take. */
export const openChores = (board: Board): Chore[] => board.chores.filter((c) => c.state === "open");

/** A sweep that is being worked or judged. */
export const sweepInFlight = (board: Board): Sweep | undefined => (board.sweep && (board.sweep.state === "working" || board.sweep.state === "judging") ? board.sweep : undefined);

/**
 * Files a chore. Agents' chores start `open`, or `proposed` when the caller
 * says so (the session asks you to approve them first); yours start open.
 */
export const addChore = (
  board: Board,
  input: Pick<ChoreImport, "text" | "where" | "repo"> & { id?: string },
  by: "user" | "agent" | "harness",
  opts: { fromTicket?: string; state?: "proposed" | "open" } = {},
): { board: Board; id: string } => {
  const at = now();
  const id = input.id && CHORE_ID_PATTERN.test(input.id) && !board.chores.some((c) => c.id === input.id) ? input.id : nextChoreId(board);
  const chore: Chore = {
    id,
    text: input.text.trim(),
    where: input.where?.trim() || undefined,
    repo: input.repo,
    state: opts.state ?? "open",
    by,
    fromTicket: opts.fromTicket,
    createdAt: at,
    updatedAt: at,
  };
  return { board: { ...board, chores: [...board.chores, chore] }, id };
};

/** Your moves: approve a proposed chore (to open), or drop one that is not in a sweep. */
export const setChoreState = (board: Board, id: string, to: "open" | "dropped", note?: string): Board => {
  const c = getChore(board, id);
  const ok = (to === "open" && c.state === "proposed") || (to === "dropped" && (c.state === "proposed" || c.state === "open"));
  if (!ok) throw new BoardError(`Cannot move ${id} from ${c.state} to ${to}`, "chore_state");
  return replaceChore(board, { ...c, state: to, outcome: to === "dropped" ? note || "Dropped" : c.outcome, updatedAt: now() });
};

/** A chore that turned out bigger than a chore becomes a backlog ticket (a followup) that quotes it. */
export const promoteChore = (board: Board, id: string, by: "user" | "agent", opts: { note?: string; role?: AgentRole; sweep?: number } = {}): { board: Board; ticketId: string } => {
  const c = getChore(board, id);
  if (c.state !== "proposed" && c.state !== "open" && c.state !== "sweeping") throw new BoardError(`${id} is ${c.state}; only an open chore can become a ticket`, "chore_state");
  const title = c.text.split("\n")[0]!.slice(0, 200);
  const spec = [c.text, c.where ? `Where: ${c.where}` : "", opts.note ? `\n${opts.note}` : ""].filter(Boolean).join("\n");
  const r = importBoard(board, { tickets: [{ title, kind: "followup", spec, repo: c.repo, notes: [`From chore ${c.id}${c.fromTicket ? ` (found while on ${c.fromTicket})` : ""}`] }] }, { by, role: opts.role ?? "lead", defaultState: "backlog" });
  const ticketId = r.created[0]!;
  return { board: replaceChore(r.board, { ...getChore(r.board, id), state: "promoted", promotedTo: ticketId, outcome: opts.note, sweep: opts.sweep, updatedAt: now() }), ticketId };
};

/**
 * A lead takes a batch of open chores: the given ids, or the oldest `max`.
 * One sweep at a time; it holds the chores until the harness settles it.
 */
export const beginSweep = (board: Board, opts: { ids?: string[]; max?: number } = {}): { board: Board; sweep: Sweep; chores: Chore[] } => {
  const live = sweepInFlight(board);
  if (live) throw new BoardError(`Sweep ${live.n} is ${live.state}; submit it before starting another`, "sweep_in_flight");
  const open = openChores(board);
  let picked: Chore[];
  if (opts.ids?.length) {
    picked = opts.ids.map((id) => {
      const c = getChore(board, id);
      if (c.state !== "open") throw new BoardError(`${id} is ${c.state}, not open`, "chore_state");
      return c;
    });
  } else picked = open.slice(0, opts.max ?? 20);
  if (!picked.length) throw new BoardError("No open chores to sweep", "no_sweep");
  const at = now();
  const sweep: Sweep = { n: (board.sweep?.n ?? 0) + 1, ids: picked.map((c) => c.id), state: "working", startedAt: at };
  const ids = new Set(sweep.ids);
  return {
    board: { ...board, sweep, chores: board.chores.map((c) => (ids.has(c.id) ? { ...c, state: "sweeping", updatedAt: at } : c)) },
    sweep,
    chores: picked,
  };
};

/** The lead submitted its sweep: the harness judges it next. */
export const sweepToJudging = (board: Board): Board => {
  const live = sweepInFlight(board);
  if (!live || live.state !== "working") throw new BoardError("No sweep is being worked; start one with chores_sweep", "no_sweep");
  return { ...board, sweep: { ...live, state: "judging" } };
};

/**
 * The harness's verdict on a sweep. Accepted: every result is applied (done,
 * dropped with the reason, or promoted to a backlog ticket), and chores the
 * lead said nothing about go back to open. Refused: everything goes back to
 * open and the note says why.
 */
export const settleSweep = (board: Board, results: readonly SweepResult[], verdict: { accepted: boolean; note: string; diff?: Sweep["diff"] }): { board: Board; done: string[]; dropped: string[]; promoted: { chore: string; ticket: string }[] } => {
  const live = sweepInFlight(board);
  if (!live) throw new BoardError("No sweep to settle", "no_sweep");
  const at = now();
  let next: Board = board;
  const done: string[] = [];
  const dropped: string[] = [];
  const promoted: { chore: string; ticket: string }[] = [];
  const settled = new Set<string>();
  if (verdict.accepted) {
    for (const r of results) {
      if (!live.ids.includes(r.id) || settled.has(r.id)) continue;
      settled.add(r.id);
      const c = getChore(next, r.id);
      if (r.outcome === "promoted") {
        const p = promoteChore(next, r.id, "agent", { note: r.note, sweep: live.n });
        next = p.board;
        promoted.push({ chore: r.id, ticket: p.ticketId });
      } else {
        next = replaceChore(next, { ...c, state: r.outcome, outcome: r.note || (r.outcome === "done" ? "Done in the sweep" : "Dropped"), sweep: live.n, updatedAt: at });
        (r.outcome === "done" ? done : dropped).push(r.id);
      }
    }
  }
  for (const id of live.ids) {
    if (settled.has(id)) continue;
    const c = getChore(next, id);
    if (c.state === "sweeping") next = replaceChore(next, { ...c, state: "open", updatedAt: at });
  }
  return { board: { ...next, sweep: { ...live, state: verdict.accepted ? "accepted" : "refused", endedAt: at, note: verdict.note, diff: verdict.diff } }, done, dropped, promoted };
};

/** A sweep the run could not finish (stop, crash, pause): the chores go back to open; the working tree is left as it is. */
export const releaseSweep = (board: Board, note: string): Board => (sweepInFlight(board) ? settleSweep(board, [], { accepted: false, note }).board : board);

/** The export is the board itself; this exists so callers never serialize ad hoc. */
export const exportBoard = (board: Board): string => JSON.stringify(board, null, 2) + "\n";

// --- Markdown import -------------------------------------------------------

/**
 * Accepts the loose markdown an assistant writes when asked for a backlog:
 *
 *   ## T-3 · Mapping engine: CC and notes (M)
 *   Repo: nuppi · Deps: T-1, T-2 · Priority: 20
 *   Free text spec…
 *   - [ ] acceptance item
 *   - [ ] another
 *
 * Headings at level 2 or 3 start a ticket. The id, size in parentheses,
 * and the "Key: value" line are all optional. Checklist items become
 * acceptance criteria; everything else is the spec. A top-level "# " line
 * before the first ticket is the goal.
 */
export const parseMarkdownBoard = (md: string): BoardImport => {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const tickets: TicketImport[] = [];
  const chores: ChoreImport[] = [];
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
      // "## Chores": every list item under it is a chore, "text — where" or "text (where)".
      flush();
      inChores = true;
      continue;
    }
    if (inChores && !heading) {
      const item = /^\s*[-*]\s+(.*\S)\s*$/.exec(raw);
      if (item) {
        const m = /^(.*?)\s+(?:—|--|·)\s+(.*)$/.exec(item[1]!) ?? /^(.*?)\s+\(([^()]+)\)$/.exec(item[1]!);
        chores.push(m ? { text: m[1]!.trim(), where: m[2]!.trim() } : { text: item[1]!.trim() });
      }
      continue;
    }
    if (heading) {
      inChores = false;
      flush();
      let title = heading[1]!.trim();
      let id: string | undefined;
      let size: TicketImport["size"];
      const idMatch = /^(T-\d+)\s*[·:.\-–—]?\s*(.*)$/.exec(title);
      if (idMatch) {
        id = idMatch[1];
        title = idMatch[2]!.trim();
      }
      const sizeMatch = /\(\s*([SML])\s*\)\s*$/.exec(title);
      if (sizeMatch) {
        size = sizeMatch[1] as "S" | "M" | "L";
        title = title.slice(0, sizeMatch.index).trim();
      }
      cur = { id, title: title || "Untitled", size, specLines: [] };
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
    const kv = /^\s*((?:Repo|Deps|Priority|Size|Kind|State|Pinned)\s*:\s*[^·|]+(?:\s*[·|]\s*(?:Repo|Deps|Priority|Size|Kind|State|Pinned)\s*:\s*[^·|]+)*)\s*$/i.exec(raw);
    if (kv) {
      for (const part of kv[1]!.split(/\s*[·|]\s*/)) {
        const [k, ...v] = part.split(":");
        const key = k!.trim().toLowerCase();
        const val = v.join(":").trim();
        if (key === "repo") cur.repo = val;
        else if (key === "deps") cur.deps = val.split(/[,\s]+/).filter((d) => TICKET_ID_PATTERN.test(d));
        else if (key === "priority" && /^\d+$/.test(val)) cur.priority = Number(val);
        else if (key === "size" && /^[SML]$/i.test(val)) cur.size = val.toUpperCase() as "S" | "M" | "L";
        else if (key === "kind" && /^(feature|bug|followup|chore)$/i.test(val)) cur.kind = val.toLowerCase() as TicketKind;
        else if (key === "state" && /^(backlog|ready)$/i.test(val)) cur.state = val.toLowerCase() as "backlog" | "ready";
        else if (key === "pinned") cur.pinned = /^(true|yes)$/i.test(val);
      }
      continue;
    }
    cur.specLines.push(raw);
  }
  flush();
  return boardImportSchema.parse({ goal, tickets, chores });
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

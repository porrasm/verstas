import { normalizeReviewMode, type Ticket } from "../core/types.js";

/**
 * The rules of judging a change that may touch any subset of a session's
 * repositories (docs/BOARD.md, "Judging"). Pure: the harness gathers what
 * changed since the ticket's baseline and runs what these decide. The
 * harness runs no checks of its own; the reviewer runs the repositories'
 * checks.
 */

/** What changed in one repository for a ticket: since its baseline, or the working tree when it has none. */
export type RepoChange = {
  repo: string;
  added: number;
  removed: number;
  files: number;
  stat: string;
  diff: string;
  paths: string[];
  /** Commits since the ticket's baseline, as "sha subject": this ticket's, other tickets', and ones that name no ticket. Empty for a sweep or a ticket without a baseline. */
  commits: { mine: string[]; others: string[]; unlabelled: string[] };
};

/** How much judging a ticket's change needs: your mode on the ticket, else the session's reviewer setting. */
export const reviewLevel = (ticket: Pick<Ticket, "review">, caps: { reviewer: boolean }): { mode: "full" | "none"; why: string } => {
  if (ticket.review) return { mode: normalizeReviewMode(ticket.review), why: "the ticket's own setting" };
  return { mode: caps.reviewer ? "full" : "none", why: "the session's setting" };
};

const TICKET_IN_TEXT = /\bT-\d+\b/g;

/**
 * The commits in a ticket's range (`git log --format=%H%x09%s%x09%(trailers:key=Verstas-Ticket,valueonly,separator=%x2C) <base>..HEAD`)
 * sorted into this ticket's (its id in the subject or a trailer), other
 * tickets' (another id, not this one) and unlabelled (no id anywhere). Each
 * as "shortsha subject", newest first.
 */
export const classifyCommits = (log: string, ticketId: string): RepoChange["commits"] => {
  const out: RepoChange["commits"] = { mine: [], others: [], unlabelled: [] };
  for (const line of log.split("\n")) {
    const [sha, subject = "", trailers = ""] = line.split("\t");
    if (!sha || !/^[0-9a-f]{7,64}$/.test(sha)) continue;
    const ids = new Set([...(subject.match(TICKET_IN_TEXT) ?? []), ...trailers.split(",").map((x) => x.trim()).filter(Boolean)]);
    const entry = `${sha.slice(0, 12)} ${subject}`;
    if (ids.has(ticketId)) out.mine.push(entry);
    else if (ids.size) out.others.push(entry);
    else out.unlabelled.push(entry);
  }
  return out;
};

/** "planned api; touched api, docs" when the ticket's expected repositories and the change differ, else undefined. */
export const plannedVsTouched = (planned: readonly string[], touched: readonly string[]): string | undefined => {
  if (!planned.length) return undefined;
  const same = planned.length === touched.length && planned.every((p) => touched.includes(p));
  if (same) return undefined;
  return `planned ${planned.join(", ")}; touched ${touched.join(", ") || "nothing"}`;
};

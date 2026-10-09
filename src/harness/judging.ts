import { normalizeReviewMode, type Ticket } from "../core/types.js";

/**
 * The rules of judging a change that may touch any subset of a session's
 * repositories (docs/BOARD.md, "Judging"). Pure: the harness gathers what
 * changed and runs what these decide. The harness runs no checks of its
 * own; the reviewer runs the repositories' checks.
 */

/** What changed in one repository since the ticket started (or since HEAD, for a sweep). */
export type RepoChange = {
  repo: string;
  added: number;
  removed: number;
  files: number;
  stat: string;
  diff: string;
  paths: string[];
  /** Commits of this ticket's earlier attempts that other work came after; the diff above does not include them. */
  scattered: string[];
};

/** How much judging a ticket's change needs: your mode on the ticket, else the session's reviewer setting. */
export const reviewLevel = (ticket: Pick<Ticket, "review">, caps: { reviewer: boolean }): { mode: "full" | "none"; why: string } => {
  if (ticket.review) return { mode: normalizeReviewMode(ticket.review), why: "the ticket's own setting" };
  return { mode: caps.reviewer ? "full" : "none", why: "the session's setting" };
};

/**
 * This ticket's earlier attempts in one repository's history, newest first
 * (`git log --format=%H%x09%s`). `base` is the oldest of the attempts at the
 * top of the history (the ticket's commits since nothing else was
 * committed), so `git diff <base>^` is the whole ticket; `scattered` are
 * older attempts other commits came after.
 */
export const earlierAttempts = (log: string, ticketId: string): { base?: string; scattered: string[] } => {
  const mine = (subject: string) => subject.startsWith(`${ticketId} (`);
  const rows = log
    .split("\n")
    .map((l) => l.split("\t"))
    .filter((r): r is [string, string] => r.length >= 2 && /^[0-9a-f]{7,64}$/.test(r[0]!));
  let i = 0;
  let base: string | undefined;
  while (i < rows.length && mine(rows[i]![1])) base = rows[i++]![0];
  const scattered = rows.slice(i).filter((r) => mine(r[1])).map((r) => r[0].slice(0, 12));
  return { base, scattered };
};

/** "planned api; touched api, docs" when the ticket's expected repositories and the change differ, else undefined. */
export const plannedVsTouched = (planned: readonly string[], touched: readonly string[]): string | undefined => {
  if (!planned.length) return undefined;
  const same = planned.length === touched.length && planned.every((p) => touched.includes(p));
  if (same) return undefined;
  return `planned ${planned.join(", ")}; touched ${touched.join(", ") || "nothing"}`;
};

import { promises as fs } from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "../board/store.js";
import { emptyBoard } from "../board/board.js";
import { inboxSchema, isInitialized, type Session } from "../core/types.js";
import type { SessionDocs } from "./hub.js";
import type { SessionPaths } from "./sessions.js";

/**
 * New work in the same box: the session keeps its container, its
 * repositories and its settings, and loses everything that described the
 * work before, so the next lead starts with nothing to misread. The four
 * steps this replaces by hand (clear the inbox, sync every repository,
 * clear the goal and the board, import the next ones) left the old plan
 * note and the goal history in front of the new lead.
 *
 * This file is the part without git or Docker: what a cleared session
 * looks like, and the copy of what was cleared. The route
 * (src/web/api.ts, /sessions/:id/new-work) syncs the repositories first,
 * since that is the one step that can fail for an outside reason, and a
 * failure there must leave the session as it was.
 */

export type ClearSummary = {
  tickets: number;
  /** The current goal, if any, and the earlier ones. */
  goals: number;
  messages: number;
  ideas: number;
  requests: number;
  /** Requests that were still open: they asked about work that is gone. */
  openRequests: number;
  prompts: number;
  /** Pull requests that were open: they stay on GitHub, and the next publish opens a new one. */
  detached: { repo: string; number: number; url: string }[];
};

/**
 * The documents of a cleared session. Gone: the board's tickets, the goal
 * with its history and the lead's claim that it was met, the whole inbox,
 * and the Ask the box history. An open pull request is marked detached:
 * it belongs to the earlier work, so the next publish starts a new round
 * instead of pushing unrelated commits into it. Kept: the repositories,
 * the recipes and their results, the network, the agents, the caps and
 * limits, the snapshot, and the remote dashboard choice.
 */
export const clearSession = (docs: SessionDocs, at: string): { next: SessionDocs; summary: ClearSummary } => {
  const s = docs.session;
  const detached: ClearSummary["detached"] = [];
  const repos = s.repos.map((r) => {
    const last = r.prs?.at(-1);
    if (!last || last.state !== "open" || last.detached) return r;
    detached.push({ repo: r.name, number: last.number, url: last.url });
    return { ...r, prs: [...r.prs!.slice(0, -1), { ...last, detached: true }] };
  });
  const { goalMet: _met, goalSince: _since, ...rest } = s;
  const session: Session = {
    ...rest,
    goal: "",
    goals: [],
    prompts: [],
    repos,
    state: isInitialized(s) ? "created" : s.state,
  };
  return {
    next: { session, board: emptyBoard(), inbox: inboxSchema.parse({}) },
    summary: {
      tickets: docs.board.tickets.length,
      goals: s.goals.length + (s.goal.trim() ? 1 : 0),
      messages: docs.inbox.messages.length,
      ideas: docs.inbox.ideas.length,
      requests: docs.inbox.requests.length,
      openRequests: docs.inbox.requests.filter((r) => r.state === "open").length,
      prompts: s.prompts.length,
      detached,
    },
  };
};

/** `2026-11-09T10:15:30.123Z` as a directory name. */
const stamp = (at: string): string => at.replace(/[:.]/g, "-");

/**
 * Keeps what a clear removes, under `<session>/history/<time>/`: the
 * board, the inbox, the goals, the Ask the box history, the lead's plan
 * note and the artifacts. The directory is beside the workspace, not in
 * it, so no agent reads it. Call it before the documents are cleared.
 * Answers the directory.
 */
export const archiveCleared = async (paths: SessionPaths, docs: SessionDocs, at: string): Promise<string> => {
  const dir = path.join(paths.dir, "history", stamp(at));
  await fs.mkdir(dir, { recursive: true });
  const s = docs.session;
  await writeJsonAtomic(path.join(dir, "board.json"), docs.board);
  await writeJsonAtomic(path.join(dir, "inbox.json"), docs.inbox);
  await writeJsonAtomic(path.join(dir, "goals.json"), { goal: s.goal, goalSince: s.goalSince, goalMet: s.goalMet, goals: s.goals });
  if (s.prompts.length) await writeJsonAtomic(path.join(dir, "prompts.json"), s.prompts);
  await fs.copyFile(path.join(paths.notes, "state.md"), path.join(dir, "state.md")).catch(() => undefined);
  // The artifacts move as a whole: their index and files stay readable there.
  await fs.rename(paths.artifacts, path.join(dir, "artifacts")).catch(() => undefined);
  return dir;
};

/** The lead's plan and progress note, emptied: it described the work that is gone. The rest of notes/ describes the box and stays. */
export const clearPlanNote = async (paths: SessionPaths): Promise<boolean> => {
  const file = path.join(paths.notes, "state.md");
  const had = await fs.stat(file).then((st) => st.size > 0, () => false);
  if (had) await fs.rm(file, { force: true });
  return had;
};

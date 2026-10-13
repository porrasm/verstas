import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { writeJsonAtomic } from "../board/store.js";
import type { Shell } from "../harness/run.js";
import type { Session } from "../core/types.js";

/**
 * What state each session repository is in: the clone's side, read with
 * git inside the container (docs/SANDBOX.md Boundary 5), and GitHub's side,
 * read from the host's mirror. The clone's side is cached in
 * `<session>/repo-state.json`, so the page can say which repositories got
 * commits while the container is stopped; it says how old the reading is.
 */

const SHA = /^[0-9a-f]{40}$/;

export const commitSchema = z.object({ sha: z.string(), date: z.string(), subject: z.string() });
export type CommitLine = z.infer<typeof commitSchema>;

export const boxRepoStateSchema = z.object({
  /** When this was read from the container. */
  at: z.string(),
  head: z.string(),
  /** Commits on the run branch since the base: the session's own work. Null when the base is unknown (older sessions). */
  ahead: z.number().int().nullable(),
  /** Changed or untracked files not yet committed. */
  dirty: z.number().int(),
  /** The newest commits since the base, newest first (at most 30). */
  commits: z.array(commitSchema),
  /** The base commit itself, as the clone has it. */
  base: commitSchema.nullable(),
});
export type BoxRepoState = z.infer<typeof boxRepoStateSchema>;

const cacheSchema = z.record(z.string(), boxRepoStateSchema);

const SCRIPT = [
  'base="$1"; rb="$2"',
  'echo "HEAD $(git rev-parse HEAD 2>/dev/null)"',
  'echo "DIRTY $(git status --porcelain 2>/dev/null | wc -l)"',
  'if [ -n "$base" ] && git cat-file -e "$base^{commit}" 2>/dev/null; then',
  '  echo "AHEAD $(git rev-list --count "$base..$rb")"',
  '  git log -1 --format="BASE %H%x09%cI%x09%s" "$base"',
  '  git log -n 30 --format="C %H%x09%cI%x09%s" "$base..$rb"',
  "else",
  '  git log -n 10 --format="C %H%x09%cI%x09%s" "$rb"',
  "fi",
].join("\n");

const parseCommit = (rest: string): CommitLine | null => {
  const [sha = "", date = "", ...subject] = rest.split("\t");
  return SHA.test(sha) ? { sha, date, subject: subject.join("\t").slice(0, 300) } : null;
};

/** One repository's clone, read inside the container; null when the clone cannot be read (no clone, not a repository). */
export const readBoxRepoState = async (sh: Shell, repo: Session["repos"][number], at = new Date()): Promise<BoxRepoState | null> => {
  const base = repo.baseCommit && SHA.test(repo.baseCommit) ? repo.baseCommit : "";
  const r = await sh.exec(["sh", "-c", SCRIPT, "sh", base, repo.runBranch], { workdir: `/workspace/${repo.name}`, timeoutMs: 60_000 });
  if (r.code !== 0) return null;
  const out: BoxRepoState = { at: at.toISOString(), head: "", ahead: null, dirty: 0, commits: [], base: null };
  for (const line of r.stdout.split("\n")) {
    const sp = line.indexOf(" ");
    const key = line.slice(0, sp);
    const rest = line.slice(sp + 1).trim();
    if (key === "HEAD") out.head = SHA.test(rest) ? rest : "";
    else if (key === "DIRTY") out.dirty = Number(rest) || 0;
    else if (key === "AHEAD") out.ahead = /^\d+$/.test(rest) ? Number(rest) : null;
    else if (key === "BASE") out.base = parseCommit(rest);
    else if (key === "C") {
      const c = parseCommit(rest);
      if (c) out.commits.push(c);
    }
  }
  if (!out.head) return null;
  return out;
};

const cacheFile = (sessionDir: string) => path.join(sessionDir, "repo-state.json");

export const loadRepoStateCache = async (sessionDir: string): Promise<Record<string, BoxRepoState>> => {
  try {
    return cacheSchema.parse(JSON.parse(await fs.readFile(cacheFile(sessionDir), "utf8")));
  } catch {
    return {};
  }
};

export const saveRepoStateCache = (sessionDir: string, state: Record<string, BoxRepoState>): Promise<void> => writeJsonAtomic(cacheFile(sessionDir), state);

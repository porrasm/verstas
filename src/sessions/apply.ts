import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

/**
 * Taking the work back: a bundle made inside the container is fetched into
 * your real repository as a feature branch. Host git touches only two
 * things here, a bundle file (pure data) and your own trusted checkout, so
 * nothing from the workspace's .git ever runs on your machine (see
 * docs/SANDBOX.md Boundary 5). The branch is updated with force, because it
 * is Verstas's own branch; the branch you have checked out is never moved.
 */

const execFileP = promisify(execFile);
const git = async (cwd: string, ...args: string[]): Promise<string> =>
  (await execFileP("git", args, { cwd, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })).stdout.trim();

export type ApplyInput = {
  /** The real repository on this machine (the work target's path at session creation). */
  targetPath: string;
  bundleFile: string;
  /** The run branch inside the bundle, e.g. verstas/2026-10-03-nuppi. */
  branch: string;
  /** The commit the session was cloned from, for the commit list; optional for old sessions. */
  baseCommit?: string;
  /** The branch the session was cloned from, used to find a base when baseCommit is missing. */
  sourceBranch?: string;
};

export type ApplyResult = {
  targetPath: string;
  branch: string;
  base: string | null;
  commits: { sha: string; subject: string }[];
  /** Lines the user can paste next. */
  howTo: string[];
};

export class ApplyError extends Error {}

export const applyBundle = async (i: ApplyInput): Promise<ApplyResult> => {
  const target = path.resolve(i.targetPath);
  const inside = await git(target, "rev-parse", "--is-inside-work-tree").catch(() => "false");
  if (inside !== "true") throw new ApplyError(`${target} is not a git work tree any more; re-add the work target or apply by hand from ${i.bundleFile}`);
  await fs.access(i.bundleFile).catch(() => {
    throw new ApplyError(`Bundle not found: ${i.bundleFile}`);
  });
  await git(target, "bundle", "verify", i.bundleFile).catch((e: Error) => {
    throw new ApplyError(`The bundle does not apply to this repository (its base commits are missing here): ${e.message.split("\n")[0]}`);
  });

  const current = await git(target, "symbolic-ref", "--short", "-q", "HEAD").catch(() => "");
  if (current === i.branch) {
    throw new ApplyError(`${i.branch} is checked out in ${target}; switch to another branch first, then apply again`);
  }
  // Force-update only Verstas's own branch; nothing else in the repository moves.
  await git(target, "fetch", "--no-tags", "--quiet", i.bundleFile, `+${i.branch}:${i.branch}`);

  let base: string | null = i.baseCommit ?? null;
  if (!base && i.sourceBranch) base = await git(target, "merge-base", i.sourceBranch, i.branch).catch(() => null);
  const range = base ? `${base}..${i.branch}` : i.branch;
  const log = await git(target, "log", "--no-decorate", "--format=%h%x09%s", range).catch(() => "");
  const commits = log
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [sha = "", ...rest] = l.split("\t");
      return { sha, subject: rest.join("\t") };
    });
  const howTo = [
    `cd ${shellQuote(target)}`,
    `git log --oneline ${base ? `${base.slice(0, 10)}..` : ""}${i.branch}`,
    `git switch ${i.branch}            # look around on the feature branch`,
    `git merge ${i.branch}             # or: git rebase ${i.branch}; or cherry-pick single tickets by sha`,
  ];
  return { targetPath: target, branch: i.branch, base, commits, howTo };
};

const shellQuote = (s: string): string => (/^[A-Za-z0-9_\/.~-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);

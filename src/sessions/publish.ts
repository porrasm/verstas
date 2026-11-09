import { promises as fs } from "node:fs";
import path from "node:path";
import type { Shell } from "../harness/run.js";
import type { PullRecord, Session } from "../core/types.js";
import type { BoxRepoState, CommitLine } from "./repo-state.js";

/**
 * Publish PR: a session repository's commits go to GitHub as a `verstas/`
 * branch and a draft pull request. The commits leave the container as an
 * incremental bundle (base..run branch) made by git inside it; the host
 * takes the bundle into the repository's mirror (pure data, Boundary 5)
 * and pushes from there with the token, which the container never sees.
 */

/** The branch on GitHub for a round: verstas/<session>-<round>. */
export const remoteBranchFor = (sessionId: string, round: number): string => `verstas/${sessionId}-${round}`;

/** The pull request a publish updates (the last one, while it is open), or the round a new one starts. */
export const publishTarget = (prs: readonly PullRecord[] | undefined): { round: number; update: PullRecord | null } => {
  const last = prs?.at(-1);
  if (last?.state === "open") return { round: last.round, update: last };
  return { round: (last?.round ?? 0) + 1, update: null };
};

/** Files that change how CI or a build runs: pushing them runs agent-written code with whatever the repository's CI can reach. */
const CI_ADJACENT = new Set(["package.json", "Makefile", "Dockerfile", "docker-compose.yml", "pyproject.toml", "setup.py", "setup.cfg", "tox.ini", "noxfile.py", "Cargo.toml", "build.rs", "go.mod", "build.gradle", "build.gradle.kts", "pom.xml", "Gemfile", "Rakefile", "justfile", "Taskfile.yml", ".pre-commit-config.yaml"]);

export const flaggedPaths = (paths: readonly string[]): string[] => paths.filter((p) => p.startsWith(".github/") || p.startsWith(".gitlab-ci") || p.startsWith(".circleci/") || CI_ADJACENT.has(p.split("/").pop() ?? ""));

/** A title and body to start from: the one commit's subject or the session's name, and the commits as a list. */
export const defaultPullText = (session: Pick<Session, "name" | "goal">, commits: readonly CommitLine[], more = 0): { title: string; body: string } => {
  const title = commits.length === 1 ? commits[0]!.subject : session.name;
  const lines = [
    `From the Verstas session "${session.name}".`,
    ...(session.goal.trim() ? ["", `Goal: ${session.goal.trim().split("\n")[0]!.slice(0, 300)}`] : []),
    "",
    "Commits:",
    ...[...commits].reverse().map((c) => `- ${c.subject}`),
    ...(more > 0 ? [`- … and ${more} more`] : []),
  ];
  return { title: title.slice(0, 250), body: lines.join("\n") };
};

// --- Publish all -------------------------------------------------------------

type Repo = Session["repos"][number];

/**
 * Why Publish all leaves a repository out, or undefined when it goes. A
 * repository whose last pull request was merged or closed while the branch
 * still holds that request's commits is left out: a new pull request would
 * carry the old work again. Publish PR on its line still does it, after
 * showing the warning.
 */
export const publishSkip = (repo: Repo, st: BoxRepoState | null): string | undefined => {
  if (!st) return "its clone could not be read";
  if (st.ahead === 0) return "no commits since the base";
  const last = repo.prs?.at(-1);
  if (last?.state === "open" && last.headSha === st.head) return `pull request #${last.number} already has every commit`;
  if (last && last.state !== "open" && last.headSha && st.commits.some((c) => c.sha === last.headSha)) return `pull request #${last.number} was ${last.state} and the branch still holds its commits; sync to ${repo.branch} first`;
  return undefined;
};

export type PublishAllRow = {
  repo: string;
  /** "ready": it would be published (an answer that asks for a confirm first). */
  outcome: "opened" | "updated" | "skipped" | "failed" | "ready";
  /** Why it was skipped or how it failed. */
  reason?: string;
  pr?: PullRecord;
  commits?: number | null;
  /** Uncommitted files, which are not published. */
  dirty?: number;
};
export type PublishAllResult = {
  /** False when nothing was pushed because files below wait for your confirm. */
  published: boolean;
  /** Build and CI files among the changes, per repository: pushing them runs agent-written code in CI. */
  flagged: { repo: string; paths: string[] }[];
  rows: PublishAllRow[];
};

/**
 * Publish all: every repository with commits gets a draft pull request,
 * and every open pull request gets the new commits, with default titles
 * and bodies. Nothing asks, except once: when the changes touch build or
 * CI files, the answer lists them and publishes nothing until the call
 * comes again with `acknowledgeFlagged`. One repository failing does not
 * stop the others; every row says what happened.
 *
 * The reading and the publishing are passed in, so this is the whole
 * decision and has no git or network of its own.
 */
export const publishAll = async (
  repos: readonly Repo[],
  io: {
    read(repo: Repo): Promise<{ st: BoxRepoState | null; paths: string[] }>;
    publish(repo: Repo, st: BoxRepoState): Promise<{ pr: PullRecord; updated: boolean }>;
  },
  opts: { acknowledgeFlagged: boolean },
): Promise<PublishAllResult> => {
  const rows: PublishAllRow[] = [];
  const going: { repo: Repo; st: BoxRepoState; row: PublishAllRow }[] = [];
  const flagged: PublishAllResult["flagged"] = [];
  for (const repo of repos) {
    if (!repo.github) {
      rows.push({ repo: repo.name, outcome: "skipped", reason: "not a GitHub repository" });
      continue;
    }
    let read: { st: BoxRepoState | null; paths: string[] };
    try {
      read = await io.read(repo);
    } catch (e) {
      rows.push({ repo: repo.name, outcome: "failed", reason: (e as Error).message });
      continue;
    }
    const skip = publishSkip(repo, read.st);
    if (skip || !read.st) {
      rows.push({ repo: repo.name, outcome: "skipped", reason: skip, commits: read.st?.ahead, dirty: read.st?.dirty || undefined });
      continue;
    }
    const row: PublishAllRow = { repo: repo.name, outcome: "ready", commits: read.st.ahead, dirty: read.st.dirty || undefined };
    rows.push(row);
    going.push({ repo, st: read.st, row });
    const f = flaggedPaths(read.paths);
    if (f.length) flagged.push({ repo: repo.name, paths: f });
  }
  if (flagged.length && !opts.acknowledgeFlagged) return { published: false, flagged, rows };
  for (const g of going) {
    try {
      const r = await io.publish(g.repo, g.st);
      g.row.outcome = r.updated ? "updated" : "opened";
      g.row.pr = r.pr;
    } catch (e) {
      g.row.outcome = "failed";
      g.row.reason = (e as Error).message;
    }
  }
  return { published: true, flagged, rows };
};

const SHA = /^[0-9a-f]{40}$/;

/** Paths the session changed since its base, read inside the container. */
export const changedPaths = async (sh: Shell, repo: Session["repos"][number]): Promise<string[]> => {
  if (!repo.baseCommit || !SHA.test(repo.baseCommit)) return [];
  const r = await sh.exec(["git", "diff", "--name-only", "--no-renames", `${repo.baseCommit}..${repo.runBranch}`, "--"], { workdir: `/workspace/${repo.name}`, timeoutMs: 60_000 });
  return r.code === 0 ? r.stdout.split("\n").filter(Boolean).slice(0, 5000) : [];
};

/**
 * Bundles the run branch's commits since the base, inside the container,
 * and copies the file to the session's export directory on the host. A
 * path the agent replaced with a symlink is refused rather than followed.
 */
export const bundleForPublish = async (sh: Shell, repo: Session["repos"][number], workspaceDir: string, exportDir: string): Promise<string> => {
  const name = `${repo.name}.publish.bundle`;
  const inBox = `/workspace/.verstas/export/${name}`;
  const mk = await sh.exec(["mkdir", "-p", "/workspace/.verstas/export"]);
  if (mk.code !== 0) throw new Error(`The agent cannot write in /workspace: ${mk.stderr.trim().slice(-200)}`);
  const range = repo.baseCommit && SHA.test(repo.baseCommit) ? [repo.runBranch, `^${repo.baseCommit}`] : [repo.runBranch];
  const b = await sh.exec(["git", "bundle", "create", inBox, ...range], { workdir: `/workspace/${repo.name}`, timeoutMs: 600_000 });
  if (b.code !== 0) throw new Error(`bundle ${repo.name}: ${b.stderr.trim().slice(-500)}`);
  const src = path.join(workspaceDir, ".verstas", "export", name);
  const st = await fs.lstat(src);
  if (!st.isFile()) throw new Error(`${src} is not a regular file`);
  await fs.mkdir(exportDir, { recursive: true });
  const dst = path.join(exportDir, name);
  await fs.copyFile(src, dst);
  await fs.rm(src, { force: true });
  return dst;
};

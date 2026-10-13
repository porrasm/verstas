import { promises as fs } from "node:fs";
import path from "node:path";
import type { Shell } from "../harness/run.js";
import type { PullRecord, Session } from "../core/types.js";
import type { CommitLine } from "./repo-state.js";

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

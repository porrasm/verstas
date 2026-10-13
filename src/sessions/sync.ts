import type { Shell } from "../harness/run.js";
import type { PullRecord, Session } from "../core/types.js";
import type { BoxRepoState } from "./repo-state.js";

/**
 * Sync: a session repository's clone moves to the latest base branch from
 * GitHub without a new clone. The host bundles what the clone lacks from
 * the repository's mirror (base..tip), the bundle is streamed into the
 * container's /tmp through `docker exec` (the path resolves inside the
 * container, never on the host), and git inside the container fetches it into
 * refs/remotes/github/<branch> and moves the run branch there. Host git
 * still never reads the workspace's .git (docs/SANDBOX.md Boundary 5).
 */

export type UnpublishedChoice = "refuse" | "rebase" | "discard";

export type SyncCheck =
  | { ok: true; reason: "clean" | "merged" }
  | { ok: false; reason: "dirty" | "unpublished" | "open-pr"; message: string };

/**
 * Whether the clone can move to the new base as it is: no uncommitted
 * files, and no commits that exist nowhere else. Commits published in a
 * pull request that GitHub reports as merged count as safe even when the
 * merge was a squash (their shas are not in the base then).
 */
export const syncCheck = (repo: Pick<Session["repos"][number], "name" | "prs">, box: BoxRepoState): SyncCheck => {
  if (box.dirty > 0) return { ok: false, reason: "dirty", message: `${repo.name} has ${box.dirty} uncommitted file${box.dirty === 1 ? "" : "s"}` };
  if (box.ahead === 0) return { ok: true, reason: "clean" };
  const last: PullRecord | undefined = repo.prs?.at(-1);
  if (last && last.headSha === box.head) {
    if (last.state === "merged") return { ok: true, reason: "merged" };
    if (last.state === "open") return { ok: false, reason: "open-pr", message: `${repo.name}'s pull request #${last.number} is still open; merge it on GitHub first` };
  }
  const n = box.ahead ?? box.commits.length;
  return { ok: false, reason: "unpublished", message: `${repo.name} has ${n} commit${n === 1 ? "" : "s"} that are not in a merged pull request` };
};

const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

export type SyncResult = { mode: "fast" | "rebase" | "discard"; tip: string };

/**
 * The container's half: fetch the bundle (at `bundleInBox`) and move the
 * run branch onto the new tip, by the rule the caller chose. A rebase that
 * conflicts is aborted and the conflicting files reported; the clone is
 * then as it was.
 */
export const syncInBox = async (sh: Shell, repo: Session["repos"][number], branch: string, tip: string, bundleInBox: string, mode: SyncResult["mode"]): Promise<SyncResult> => {
  const dir = `/workspace/${repo.name}`;
  const run = async (cmd: string, what: string) => {
    const r = await sh.exec(["sh", "-c", cmd], { workdir: dir, timeoutMs: 600_000 });
    if (r.code !== 0) throw new Error(`${what} in ${repo.name}: ${(r.stderr || r.stdout).trim().slice(-600)}`);
    return r.stdout;
  };
  const git = "git -c core.hooksPath=/dev/null -c core.fsmonitor=false";
  const remoteRef = `refs/remotes/github/${branch}`;
  await run(`${git} fetch --quiet --no-tags ${q(bundleInBox)} ${q(`+refs/heads/${branch}:${remoteRef}`)}`, "fetch from the bundle");
  const got = (await run(`${git} rev-parse ${q(`${remoteRef}^{commit}`)}`, "read the fetched tip")).trim();
  if (got !== tip) throw new Error(`${repo.name}: the bundle brought ${got.slice(0, 7)}, not ${tip.slice(0, 7)}`);
  if (mode === "rebase") {
    if (!repo.baseCommit) throw new Error(`${repo.name}: the base is unknown, so the session's commits cannot be told apart for a rebase`);
    const r = await sh.exec(["sh", "-c", `${git} rebase --quiet --onto ${q(remoteRef)} ${q(repo.baseCommit)} ${q(repo.runBranch)}`], { workdir: dir, timeoutMs: 600_000 });
    if (r.code !== 0) {
      const conflicts = await sh.exec(["git", "diff", "--name-only", "--diff-filter=U"], { workdir: dir });
      await sh.exec(["sh", "-c", `${git} rebase --abort`], { workdir: dir });
      const files = conflicts.stdout.split("\n").filter(Boolean);
      throw new Error(`${repo.name}: the rebase onto ${branch} conflicts${files.length ? ` in ${files.slice(0, 10).join(", ")}` : ""}; nothing changed. Resolve it with an agent terminal or Ask the box, or discard the commits.`);
    }
    return { mode, tip };
  }
  if (mode === "discard") await run(`${git} reset --quiet --hard && ${git} clean -fdq`, "discard uncommitted files");
  await run(`${git} checkout --quiet -B ${q(repo.runBranch)} ${q(remoteRef)}`, "move the run branch");
  return { mode, tip };
};

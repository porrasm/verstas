import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { detectPacks, MANIFESTS, type PackName } from "../network/packs.js";
import { GITHUB_REPO_RE } from "./api.js";

/**
 * One bare mirror per GitHub repository, owned by the host app, under
 * `$VERSTAS_HOME/mirrors/<owner>/<name>.git`. GitHub is downloaded once per
 * host; after that a fetch brings only what is new, and sessions clone from
 * the mirror (docs/SANDBOX.md Boundary 1).
 *
 * Host git runs here and nowhere else after cloning: the mirror is made
 * with no template (no hooks), is never mounted into a container, and every
 * command runs with hooks and fsmonitor off. The token reaches git through
 * GIT_CONFIG_* environment variables as an http.extraheader scoped to
 * https://github.com/, so it is in no argv, no config file and no remote
 * URL; no remote is configured at all.
 */

const execFileP = promisify(execFile);

const SAFE = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];

/** The environment a git command needs to authenticate to github.com with the token, and nothing else: host credential helpers are switched off. */
export const githubAuthEnv = (token: string | undefined): Record<string, string> => {
  const pairs: [string, string][] = [["credential.helper", ""]];
  if (token) pairs.push(["http.https://github.com/.extraheader", `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`]);
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: String(pairs.length) };
  pairs.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  return env;
};

const scrub = (text: string, token: string | undefined): string => (token ? text.split(token).join("***") : text);

const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/;
export const isBranchName = (b: string): boolean => BRANCH_RE.test(b) && !b.includes("..") && !b.endsWith(".lock") && !b.endsWith("/");

export type MirrorStatus = { github: string; path: string; fetchedAt: string | null; fetching: boolean; error: string | null };

export type MirrorsOptions = {
  /** `$VERSTAS_HOME`; the mirrors live under its `mirrors/`. */
  home: string;
  token: () => Promise<string | undefined>;
  /** Where to fetch from; github.com by default. Tests point it at a local bare repository. */
  remote?: (github: string) => string;
  /** A fetch younger than this is reused by `fresh`; 30 s by default. */
  maxAgeMs?: number;
};

export class Mirrors {
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly lastError = new Map<string, string>();

  constructor(private readonly o: MirrorsOptions) {}

  path(github: string): string {
    if (!GITHUB_REPO_RE.test(github)) throw new Error(`Not a GitHub repository: ${github}`);
    const [owner, name] = github.toLowerCase().split("/") as [string, string];
    return path.join(this.o.home, "mirrors", owner, `${name}.git`);
  }

  remote(github: string): string {
    return this.o.remote?.(github) ?? `https://github.com/${github}.git`;
  }

  private stamp(github: string): string {
    return path.join(this.path(github), "verstas-fetched-at");
  }

  async status(github: string): Promise<MirrorStatus> {
    const fetchedAt = await fs.readFile(this.stamp(github), "utf8").then((s) => s.trim() || null, () => null);
    return { github, path: this.path(github), fetchedAt, fetching: this.inFlight.has(github), error: this.lastError.get(github) ?? null };
  }

  /** git in the mirror, hooks off, with the token in the environment only when `auth` is set. */
  private async git(github: string, args: string[], opts: { auth?: boolean; timeoutMs?: number } = {}): Promise<string> {
    const token = opts.auth ? await this.o.token() : undefined;
    try {
      const { stdout } = await execFileP("git", [...SAFE, "-C", this.path(github), ...args], {
        maxBuffer: 64 * 1024 * 1024,
        timeout: opts.timeoutMs ?? 120_000,
        env: { ...process.env, ...githubAuthEnv(token) },
      });
      return stdout.trim();
    } catch (e) {
      const err = e as Error & { stderr?: string };
      throw new Error(scrub((err.stderr?.trim() || err.message).split("\n").slice(-5).join("\n"), token));
    }
  }

  private async ensure(github: string): Promise<void> {
    const dir = this.path(github);
    if (await fs.access(path.join(dir, "HEAD")).then(() => true, () => false)) return;
    await fs.mkdir(path.dirname(dir), { recursive: true, mode: 0o700 });
    await execFileP("git", ["init", "-q", "--bare", "--template=", dir]);
  }

  /**
   * Fetches every branch from GitHub into the mirror's refs/heads, pruning
   * branches deleted there. Refs Verstas keeps for itself (refs/verstas/*)
   * are outside the refspec and are never pruned. One fetch per mirror at a
   * time; a caller arriving during a fetch waits for that one.
   */
  fetch(github: string): Promise<void> {
    const running = this.inFlight.get(github);
    if (running) return running;
    const p = (async () => {
      try {
        await this.ensure(github);
        await this.git(github, ["fetch", "--quiet", "--prune", "--no-tags", this.remote(github), "+refs/heads/*:refs/heads/*"], { auth: true, timeoutMs: 3_600_000 });
        await fs.writeFile(this.stamp(github), new Date().toISOString() + "\n");
        this.lastError.delete(github);
      } catch (e) {
        const raw = (e as Error).message;
        // git asks for a username when GitHub answers 401/404: private without a token that reaches it, or gone.
        const msg = /could not read Username|Authentication failed|Repository not found|returned error: 40[34]/.test(raw) ? "GitHub refused access: the repository is private or gone, and no saved token can read it" : raw;
        this.lastError.set(github, msg);
        throw new Error(`Fetching ${github} from GitHub failed: ${msg}`);
      } finally {
        this.inFlight.delete(github);
      }
    })();
    this.inFlight.set(github, p);
    return p;
  }

  /** The mirror, fetched within maxAgeMs; a fetch runs only when the last one is older. */
  async fresh(github: string): Promise<string> {
    const s = await this.status(github);
    const age = s.fetchedAt ? Date.now() - Date.parse(s.fetchedAt) : Infinity;
    if (s.fetching || !(age < (this.o.maxAgeMs ?? 30_000))) await this.fetch(github);
    return this.path(github);
  }

  async branches(github: string): Promise<string[]> {
    const out = await this.git(github, ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads/"]);
    return out.split("\n").filter(Boolean);
  }

  async hasBranch(github: string, branch: string): Promise<boolean> {
    if (!isBranchName(branch)) return false;
    return this.git(github, ["rev-parse", "-q", "--verify", `refs/heads/${branch}^{commit}`]).then(() => true, () => false);
  }

  /** The newest commits of a branch: sha, subject, author, ISO date. */
  async log(github: string, branch: string, n = 10): Promise<{ sha: string; subject: string; author: string; date: string }[]> {
    if (!isBranchName(branch)) throw new Error(`Bad branch name: ${branch}`);
    const out = await this.git(github, ["log", "--no-decorate", `-n${n}`, "--format=%H%x09%an%x09%cI%x09%s", `refs/heads/${branch}`, "--"]);
    return out
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [sha = "", author = "", date = "", ...rest] = l.split("\t");
        return { sha, author, date, subject: rest.join("\t") };
      });
  }

  /** A branch's newest commit; null when the mirror has no such branch. */
  async tip(github: string, branch: string): Promise<{ sha: string; date: string; subject: string } | null> {
    if (!(await this.hasBranch(github, branch))) return null;
    const [c] = await this.log(github, branch, 1);
    return c ? { sha: c.sha, date: c.date, subject: c.subject } : null;
  }

  /** Commits on the branch that `from` lacks (how far GitHub moved past a base); null when the mirror does not know `from`. */
  async countSince(github: string, from: string, branch: string): Promise<number | null> {
    if (!/^[0-9a-f]{40}$/.test(from) || !isBranchName(branch)) return null;
    const out = await this.git(github, ["rev-list", "--count", `${from}..refs/heads/${branch}`]).catch(() => null);
    return out !== null && /^\d+$/.test(out) ? Number(out) : null;
  }

  /** The packs a branch's manifests imply, read from the mirror's objects (no checkout exists). */
  async packs(github: string, branch: string): Promise<PackName[]> {
    if (!isBranchName(branch)) return [];
    const listed = await this.git(github, ["ls-tree", "-r", "--name-only", `refs/heads/${branch}`]);
    const globs = MANIFESTS.map((m) => new RegExp(`^${m.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`));
    const paths = listed
      .split("\n")
      .filter((p) => p && !p.includes("node_modules/") && globs.some((g) => g.test(p.split("/").pop()!)))
      .slice(0, 60);
    const files: { path: string; text: string }[] = [];
    for (const p of paths) files.push({ path: p, text: (await this.git(github, ["cat-file", "blob", `refs/heads/${branch}:${p}`]).catch(() => "")).slice(0, 200_000) });
    return detectPacks(files);
  }
}

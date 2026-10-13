import { z } from "zod";

/**
 * The GitHub REST API, from the host app only (docs/SANDBOX.md Boundary 6).
 * The token goes in an Authorization header to the API origin and nowhere
 * else; errors carry GitHub's message, never the token. Without a token the
 * calls still work for public repositories, at GitHub's anonymous limits.
 */

/** "owner/name", as GitHub spells it. */
export const GITHUB_REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

/** "owner/name", "https://github.com/owner/name(.git)" or "git@github.com:owner/name.git" -> "owner/name"; null when it is none of them. */
export const parseGithubRepo = (raw: string): string | null => {
  const s = raw.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  const m = /^(?:https?:\/\/(?:www\.)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)?([^/\s]+\/[^/\s]+)$/.exec(s);
  const repo = m?.[1];
  return repo && GITHUB_REPO_RE.test(repo) && !repo.endsWith("/.") && !repo.endsWith("/..") ? repo : null;
};

export class GithubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const repoSchema = z.object({
  full_name: z.string(),
  default_branch: z.string(),
  private: z.boolean(),
  permissions: z.object({ push: z.boolean().optional() }).partial().optional(),
});

export type GithubRepo = { github: string; defaultBranch: string; private: boolean; canPush: boolean | null };

const pullSchema = z.object({
  number: z.number().int(),
  html_url: z.string(),
  state: z.enum(["open", "closed"]),
  draft: z.boolean().optional(),
  merged_at: z.string().nullable().optional(),
  title: z.string(),
  head: z.object({ ref: z.string(), sha: z.string() }),
  base: z.object({ ref: z.string() }),
});

/** A pull request as Verstas records it. */
export type Pull = { number: number; url: string; state: "open" | "merged" | "closed"; draft: boolean; title: string; headRef: string; headSha: string; base: string };

const toPull = (raw: unknown): Pull => {
  const p = pullSchema.parse(raw);
  return { number: p.number, url: p.html_url, state: p.merged_at ? "merged" : p.state, draft: p.draft ?? false, title: p.title, headRef: p.head.ref, headSha: p.head.sha, base: p.base.ref };
};

export type GithubApi = {
  /** The token's user; null without a token. */
  whoami(): Promise<{ login: string } | null>;
  repo(github: string): Promise<GithubRepo>;
  pull(github: string, number: number): Promise<Pull>;
  /** The newest pull request from a branch of the repository itself, in any state; null when there is none. */
  findPull(github: string, branch: string): Promise<Pull | null>;
  createPull(github: string, p: { head: string; base: string; title: string; body: string; draft: boolean }): Promise<Pull>;
  updatePull(github: string, number: number, p: { title?: string; body?: string }): Promise<Pull>;
};

export const githubApi = (token: string | undefined, base = "https://api.github.com", fetchImpl: typeof fetch = fetch): GithubApi => {
  const call = async (p: string, method = "GET", body?: unknown): Promise<unknown> => {
    const res = await fetchImpl(`${base}${p}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "verstas",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 300);
      try {
        const j = JSON.parse(text) as { message?: unknown; errors?: { message?: unknown }[] };
        msg = [j.message, ...(j.errors ?? []).map((e) => e.message)].filter(Boolean).join(": ") || msg;
      } catch {
        // not JSON
      }
      throw new GithubError(`GitHub ${res.status}: ${msg}`, res.status);
    }
    return JSON.parse(text);
  };
  return {
    whoami: async () => (token ? { login: z.object({ login: z.string() }).parse(await call("/user")).login } : null),
    repo: async (github) => {
      if (!GITHUB_REPO_RE.test(github)) throw new GithubError(`Not a GitHub repository: ${github}`, 400);
      try {
        const r = repoSchema.parse(await call(`/repos/${github}`));
        return { github: r.full_name, defaultBranch: r.default_branch, private: r.private, canPush: r.permissions?.push ?? null };
      } catch (e) {
        if (e instanceof GithubError && e.status === 404) throw new GithubError(`${github} was not found, or the token cannot see it`, 404);
        throw e;
      }
    },
    pull: async (github, number) => toPull(await call(`/repos/${github}/pulls/${number}`)),
    findPull: async (github, branch) => {
      const owner = github.split("/")[0]!;
      const list = z.array(z.unknown()).parse(await call(`/repos/${github}/pulls?state=all&per_page=1&head=${encodeURIComponent(`${owner}:${branch}`)}`));
      return list.length ? toPull(list[0]) : null;
    },
    createPull: async (github, p) => toPull(await call(`/repos/${github}/pulls`, "POST", p)),
    updatePull: async (github, number, p) => toPull(await call(`/repos/${github}/pulls/${number}`, "PATCH", p)),
  };
};

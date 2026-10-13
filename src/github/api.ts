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

export type GithubApi = {
  /** The token's user; null without a token. */
  whoami(): Promise<{ login: string } | null>;
  repo(github: string): Promise<GithubRepo>;
};

export const githubApi = (token: string | undefined, base = "https://api.github.com", fetchImpl: typeof fetch = fetch): GithubApi => {
  const call = async (p: string): Promise<unknown> => {
    const res = await fetchImpl(`${base}${p}`, {
      headers: {
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
        msg = String((JSON.parse(text) as { message?: unknown }).message ?? msg);
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
  };
};

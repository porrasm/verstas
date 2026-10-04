import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { writeJsonAtomic } from "./board/store.js";

/**
 * Host app configuration, kept outside the repository and outside any
 * session: `$VERSTAS_HOME` (default `~/.verstas`) holds `config.json` and a
 * `secrets.json` with mode 0600. The sessions root is the one setting that
 * matters; everything a session needs lives under it.
 */

export const workTargetSchema = z.object({
  /** Display name and default clone directory name. */
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  /** Absolute path to a git repository on this machine. */
  path: z.string().min(1),
});
export type WorkTarget = z.infer<typeof workTargetSchema>;

export const configSchema = z.object({
  sessionsRoot: z.string().min(1).default(path.join(os.homedir(), "verstas", "sessions")),
  workTargets: z.array(workTargetSchema).default([]),
  uiPort: z.number().int().min(1).max(65535).default(4700),
  agentApiPort: z.number().int().min(1).max(65535).default(4701),
  devboxImage: z.string().min(1).default("verstas-devbox:local"),
  /** Set true when the host is Linux and the proxy needs host-gateway spelled out. */
  linuxHost: z.boolean().default(process.platform === "linux"),
  /**
   * Remote dashboard (docs/REMOTE.md): where to push the sessions you
   * shared. Off until you turn it on; the token lives in secrets.json.
   */
  remote: z
    .object({
      enabled: z.boolean().default(false),
      /** e.g. https://porras.club, or https://localhost:3001 while testing. */
      baseUrl: z.string().max(500).default(""),
    })
    .prefault({}),
});
export type Config = z.infer<typeof configSchema>;

export const secretsSchema = z.object({
  /** From `claude setup-token`; passed to the session container as CLAUDE_CODE_OAUTH_TOKEN. */
  claudeToken: z.string().min(1).optional(),
  /**
   * The contents of Codex's auth.json after `codex login` on this machine
   * (a ChatGPT subscription login). Codex rotates the tokens inside; the
   * worker driver hands the refreshed file back and it is stored here again.
   */
  codexAuth: z.string().min(2).max(200_000).optional(),
  /** A Cursor user API key (dashboard, API Keys); passed to the worker as CURSOR_API_KEY. Draws on the Cursor plan, not on a provider key. */
  cursorApiKey: z.string().min(1).optional(),
  /** The token you created in the remote dashboard; sent as a bearer token to its base URL only. */
  remoteToken: z.string().min(1).optional(),
});
export type Secrets = z.infer<typeof secretsSchema>;

/**
 * Every secret string that must never appear in a commit: the plain tokens,
 * plus the tokens inside Codex's auth file (its JSON wrapper is not secret,
 * its values are). Used by the harness's staged-diff scan.
 */
export const secretValues = (s: Secrets): string[] => {
  const out: string[] = [];
  if (s.claudeToken) out.push(s.claudeToken);
  if (s.cursorApiKey) out.push(s.cursorApiKey);
  if (s.codexAuth) {
    const walk = (v: unknown) => {
      if (typeof v === "string") {
        if (v.length >= 16) out.push(v);
      } else if (v && typeof v === "object") for (const x of Object.values(v as Record<string, unknown>)) walk(x);
    };
    try {
      walk(JSON.parse(s.codexAuth));
    } catch {
      out.push(s.codexAuth);
    }
  }
  return out;
};

/** When Codex last rotated its tokens, from the auth file; undefined when unknown. */
export const codexAuthRefreshedAt = (codexAuth: string | undefined): Date | undefined => {
  if (!codexAuth) return undefined;
  try {
    const j = JSON.parse(codexAuth) as { last_refresh?: unknown };
    if (typeof j.last_refresh === "string") {
      const d = new Date(j.last_refresh);
      if (!Number.isNaN(d.getTime())) return d;
    }
  } catch {
    // not JSON; treated as unknown
  }
  return undefined;
};

export const verstasHome = (): string => process.env.VERSTAS_HOME ?? path.join(os.homedir(), ".verstas");

const readJson = async (file: string): Promise<unknown> => {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
};

export const loadConfig = async (home = verstasHome()): Promise<Config> =>
  configSchema.parse(await readJson(path.join(home, "config.json")));

export const saveConfig = async (config: Config, home = verstasHome()): Promise<void> => {
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  await writeJsonAtomic(path.join(home, "config.json"), configSchema.parse(config));
};

export const loadSecrets = async (home = verstasHome()): Promise<Secrets> =>
  secretsSchema.parse(await readJson(path.join(home, "secrets.json")));

export const saveSecrets = async (secrets: Secrets, home = verstasHome()): Promise<void> => {
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  await writeJsonAtomic(path.join(home, "secrets.json"), secretsSchema.parse(secrets));
};

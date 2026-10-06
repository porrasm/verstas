import type { Secrets } from "../config.js";
import { codexAuthRefreshedAt } from "../config.js";
import { DRIVER_NAMES, sessionDrivers, type AgentSpec, type DriverName, type SessionAgents, type TicketState } from "../core/types.js";
import { driverPack, type PackName } from "../network/packs.js";

/**
 * The host's view of a worker driver: which credential it needs, under what
 * environment variable the worker process receives it, which network pack
 * its backend lives in, and what to tell the user when it is missing. The
 * in-container side (how the agent is spawned and how its output becomes
 * events) lives in src/worker; the two meet on `job.driver`.
 *
 * Claude Code is the reference driver. Codex and Cursor are optional: when
 * their CLI is not in the image or their credential is not configured, a
 * run that needs them fails with a clear message, and a session on Claude
 * is untouched.
 */
export type DriverInfo = {
  name: DriverName;
  title: string;
  /** The field in secrets.json. */
  secret: keyof Secrets;
  /** The environment variable the worker process receives the credential in. */
  env: string;
  pack: PackName;
  /** How the user gets the credential, shown where it is missing. */
  hint: string;
  /** Model ids to offer; any string the CLI accepts also works. */
  models: readonly string[];
  /** The driver reports USD cost itself (Claude). Others report tokens only, so the budget cap cannot apply. */
  reportsCost: boolean;
};

export const DRIVERS: Record<DriverName, DriverInfo> = {
  claude: {
    name: "claude",
    title: "Claude Code",
    secret: "claudeToken",
    env: "CLAUDE_CODE_OAUTH_TOKEN",
    pack: driverPack("claude"),
    hint: "Run `claude setup-token` in a terminal and paste the result in Settings.",
    models: ["claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1", "claude-haiku-4-5-20251001", "sonnet", "opus", "haiku"],
    reportsCost: true,
  },
  codex: {
    name: "codex",
    title: "Codex",
    secret: "codexAuth",
    env: "VERSTAS_CODEX_AUTH",
    pack: driverPack("codex"),
    hint: "Run `codex login --device-auth` on this machine with your ChatGPT account, then import the login in Settings.",
    // Verify against `codex exec --help` for the pinned CLI; the field accepts any id.
    models: ["gpt-5.1-codex", "gpt-5.1-codex-mini", "gpt-5.1", "gpt-5-codex", "gpt-5"],
    reportsCost: false,
  },
  cursor: {
    name: "cursor",
    title: "Cursor",
    secret: "cursorApiKey",
    env: "CURSOR_API_KEY",
    pack: driverPack("cursor"),
    hint: "Create a user API key in the Cursor dashboard (API Keys) and paste it in Settings. Turn on-demand usage off there if you want a hard stop at the plan's limit.",
    // Verify against `agent --help` for the pinned CLI; the field accepts any id.
    models: ["auto", "sonnet-4.5", "opus-4.1", "gpt-5", "gpt-5-codex"],
    reportsCost: false,
  },
};

export const driverInfo = (name: DriverName | undefined): DriverInfo => DRIVERS[name ?? "claude"];

/** The configured value for a driver, or undefined. */
export const credentialFor = (secrets: Secrets, driver: DriverName): string | undefined => {
  const v = secrets[DRIVERS[driver].secret];
  return typeof v === "string" && v ? v : undefined;
};

export const missingCredentialError = (driver: DriverName, because?: string): Error => {
  const d = DRIVERS[driver];
  return new Error(`No ${d.title} credential configured${because ? ` (${because})` : ""}. ${d.hint}`);
};

type BoardLike = { tickets: readonly { id: string; agent?: AgentSpec; state: TicketState }[] };

/** Drivers a session's roles, and its tickets' own agents, need but have no credential for. */
export const missingCredentials = (secrets: Secrets, session: { model?: string; agents?: SessionAgents; caps?: { reviewer?: boolean } }, board?: BoardLike): DriverName[] =>
  sessionDrivers(session, board).filter((d) => !credentialFor(secrets, d));

/** Why a driver is needed, for the error: the tickets that name it, or the session's roles. */
export const whyDriverNeeded = (session: { model?: string; agents?: SessionAgents; caps?: { reviewer?: boolean } }, board: BoardLike | undefined, driver: DriverName): string | undefined => {
  if (sessionDrivers(session).includes(driver)) return undefined;
  const ids = (board?.tickets ?? []).filter((t) => t.agent?.driver === driver && t.state !== "done").map((t) => t.id);
  return ids.length ? `${ids.join(", ")} name${ids.length === 1 ? "s" : ""} it as the ticket's agent; add the credential in Settings or remove the agent from the ticket` : undefined;
};

/** Which drivers have a credential, for the status endpoint. */
export const configuredDrivers = (secrets: Secrets): Record<DriverName, boolean> =>
  Object.fromEntries(DRIVER_NAMES.map((d) => [d, Boolean(credentialFor(secrets, d))])) as Record<DriverName, boolean>;

/** Days since Codex last rotated its login, or undefined when unknown. */
export const codexAuthAgeDays = (secrets: Secrets, now = new Date()): number | undefined => {
  const at = codexAuthRefreshedAt(secrets.codexAuth);
  return at ? (now.getTime() - at.getTime()) / 86_400_000 : undefined;
};

/**
 * Codex refreshes its login when it is about eight days old, and the refresh
 * token is single use. Two Codex workers refreshing at once would invalidate
 * each other, so once the login passes this age, Codex workers run one at a
 * time across sessions until the refreshed file is stored.
 */
export const CODEX_SERIALIZE_AFTER_DAYS = 7;

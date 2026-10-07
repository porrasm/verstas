import { promises as fs } from "node:fs";
import path from "node:path";
import {
  DEFAULT_ALLOWLIST,
  inboxSchema,
  now,
  sessionDrivers,
  sessionSchema,
  SESSION_ID_PATTERN,
  type Inbox,
  type Session,
  type SessionAgents,
  type SessionSetupScript,
  type SetupMode,
} from "../core/types.js";
import { writeJsonAtomic, saveBoard } from "../board/store.js";
import { emptyBoard } from "../board/board.js";
import type { WorkTarget } from "../config.js";
import { allowlistFor, DEFAULT_PACKS, driverPack, packHosts } from "../network/packs.js";
import { cloneWorkTarget, extractZip, listBranches, runBranchName, type CloneResult, type ExtractResult } from "./workspace.js";

/**
 * A session is a directory under the sessions root:
 *
 *   <root>/<id>/
 *     session.json      Session (core/types)
 *     board.json        Board
 *     inbox.json        requests, messages, ideas
 *     proxy/            mounted read-only into the proxy (a directory, so
 *       allowlist.json  atomic rewrites are seen; a single-file mount pins the old inode)
 *     workspace/        the one bind mount
 *       <repo>/         fresh clones
 *       attachments/    extracted zips
 *       notes/          agent memory outside git
 *     runs/<n>/         env (0600), events.jsonl, tickets/<id>.md
 *     export/           bundles
 *
 * Only the host app writes these files; the agent reaches them through the
 * agent API. Deleting a session is deleting the directory (after the
 * sandbox module has removed the containers).
 */

export type SessionPaths = {
  dir: string;
  session: string;
  board: string;
  inbox: string;
  /** Directory mounted into the proxy; holds allowlist.json. */
  proxyDir: string;
  allowlist: string;
  workspace: string;
  attachments: string;
  notes: string;
  runs: string;
  exportDir: string;
  setup: string;
};

export const sessionPaths = (root: string, id: string): SessionPaths => {
  if (!SESSION_ID_PATTERN.test(id)) throw new Error(`Bad session id: ${id}`);
  const dir = path.join(root, id);
  return {
    dir,
    session: path.join(dir, "session.json"),
    board: path.join(dir, "board.json"),
    inbox: path.join(dir, "inbox.json"),
    proxyDir: path.join(dir, "proxy"),
    allowlist: path.join(dir, "proxy", "allowlist.json"),
    workspace: path.join(dir, "workspace"),
    attachments: path.join(dir, "workspace", "attachments"),
    notes: path.join(dir, "workspace", "notes"),
    runs: path.join(dir, "runs"),
    exportDir: path.join(dir, "export"),
    setup: path.join(dir, "setup"),
  };
};

/** "Nuppi MVP" -> "2026-10-03-nuppi-mvp"; unique within the root by suffixing -2, -3, … */
export const makeSessionId = async (root: string, name: string, date = new Date()): Promise<string> => {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "session";
  const base = `${date.toISOString().slice(0, 10)}-${slug}`;
  let id = base;
  for (let n = 2; ; n++) {
    try {
      await fs.access(path.join(root, id));
      id = `${base}-${n}`;
    } catch {
      return id;
    }
  }
};

export type CreateSessionInput = {
  name: string;
  /** A draft's goal, kept as the first suggestion for the Plan tickets box; nothing else reads it. */
  goal?: string;
  repos: { target: WorkTarget; branch?: string; name?: string }[];
  zips: { name: string; file: string }[];
  /** Extra hosts beyond the packs; with no packs given, the whole allowlist (older callers). */
  allowlist?: string[];
  packs?: string[];
  requirements?: string;
  /** Absent means agentic, the schema's default. */
  setupMode?: SetupMode;
  image: string;
  /** Legacy: the worker's Claude model. New callers pass `agents`. */
  model?: string;
  agents?: SessionAgents;
  setupScripts?: SessionSetupScript[];
  caps?: Partial<Session["caps"]>;
  limits?: Partial<Session["limits"]>;
  /** How planning agents size tickets; absent, they choose. */
  planning?: Session["planning"];
};

/** The packs plus the one each chosen agent's backend lives in (the Claude pack is always on through packHosts). */
export const withAgentPacks = (packs: readonly string[], s: { model?: string; agents?: SessionAgents; caps?: { reviewer?: boolean } }, board?: Parameters<typeof sessionDrivers>[1]): string[] => {
  const out = [...packs];
  for (const d of sessionDrivers(s, board)) {
    const p = driverPack(d);
    if (!out.includes(p)) out.push(p);
  }
  return out;
};

export type CreateSessionResult = {
  session: Session;
  paths: SessionPaths;
  extracts: ExtractResult[];
};

/** Directory names under /workspace that a repository cannot take. */
export const RESERVED_WORKSPACE_NAMES: readonly string[] = ["attachments", "notes", ".home", ".verstas"];

/**
 * The record of a repository pick, before the clone exists: the branch is
 * fixed now (the one you chose, or the target's current one), the clone and
 * its base commit come at initialization.
 */
export const repoPick = async (sessionId: string, pick: { target: WorkTarget; branch?: string; name?: string }): Promise<Session["repos"][number]> => {
  const name = pick.name ?? pick.target.name;
  const found = await listBranches(pick.target.path).catch(() => null);
  if (!found) throw new Error(`${pick.target.path} is not a git work tree`);
  const branch = pick.branch ?? found.current;
  if (!branch) throw new Error(`${pick.target.name}: cannot tell the current branch (detached HEAD?); choose one`);
  return { name, sourcePath: pick.target.path, branch, runBranch: runBranchName(sessionId) };
};

/**
 * Creates the session directory and its files. Nothing is cloned and no
 * container exists yet: the session is a plan until `provisionSession`
 * runs at initialization. Attachments are extracted now; they are files of
 * yours, not an environment.
 */
export const createSession = async (root: string, input: CreateSessionInput): Promise<CreateSessionResult> => {
  const id = await makeSessionId(root, input.name);
  const paths = sessionPaths(root, id);
  await fs.mkdir(paths.workspace, { recursive: true, mode: 0o755 });
  await fs.mkdir(paths.attachments, { recursive: true });
  await fs.mkdir(paths.notes, { recursive: true });
  await fs.mkdir(paths.runs, { recursive: true });
  await fs.mkdir(paths.exportDir, { recursive: true });
  await fs.mkdir(paths.setup, { recursive: true });

  const extracts: ExtractResult[] = [];
  const session: Session = sessionSchema.parse({
    id,
    name: input.name,
    goal: input.goal ?? "",
    createdAt: now(),
    initializedAt: null,
    state: "setup",
    image: input.image,
    model: input.model?.trim() || undefined,
    agents: input.agents ?? {},
    requirements: input.requirements?.trim() ?? "",
    setupMode: input.setupMode,
    setupScripts: input.setupScripts ?? [],
    // Packs plus extra hosts; hosts the chosen scripts download from join too. The agents' own backends come with the agent choice.
    packs: withAgentPacks(input.packs ?? (input.allowlist ? [] : [...DEFAULT_PACKS]), input),
    allowlist: [
      ...new Set([
        ...(input.packs ? allowlistFor(withAgentPacks(input.packs, input), input.allowlist ?? []) : [...(input.allowlist ?? [...DEFAULT_ALLOWLIST]), ...packHosts(withAgentPacks([], input))]),
        ...(input.setupScripts ?? []).flatMap((x) => x.hosts),
      ]),
    ],
    caps: input.caps ?? {},
    limits: input.limits ?? {},
    planning: input.planning,
  });

  try {
    const used = new Set<string>(RESERVED_WORKSPACE_NAMES);
    for (const r of input.repos) {
      const name = r.name ?? r.target.name;
      if (used.has(name)) throw new Error(`Duplicate workspace directory name: ${name}`);
      used.add(name);
      session.repos.push(await repoPick(id, r));
    }
    for (const z of input.zips) {
      const dirName = z.name.replace(/\.zip$/i, "").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 100) || "attachment";
      const ex = await extractZip(z.file, path.join(paths.attachments, dirName));
      extracts.push(ex);
      session.attachments.push({ name: z.name, dir: dirName, bytes: ex.bytes, skipped: ex.skipped });
    }
    await writeRecipeFiles(paths, session.setupScripts);
    await writeJsonAtomic(paths.session, session);
    await saveBoard(paths.dir, emptyBoard(input.goal ?? ""));
    await writeJsonAtomic(paths.inbox, inboxSchema.parse({}));
    await writeAllowlist(paths, session.allowlist);
  } catch (e) {
    await fs.rm(paths.dir, { recursive: true, force: true });
    throw e;
  }
  return { session, paths, extracts };
};

/**
 * A copy of each recipe, readable in the session directory (the container
 * runs the copy), and the environment description a recipe brings along
 * for the setup worker to verify. Stale copies of recipes no longer chosen
 * are removed.
 */
export const writeRecipeFiles = async (paths: SessionPaths, scripts: readonly SessionSetupScript[]): Promise<void> => {
  await fs.mkdir(paths.setup, { recursive: true });
  const keep = new Set(scripts.map((sc) => `${sc.name}.sh`));
  for (const f of await fs.readdir(paths.setup).catch(() => [] as string[])) if (f.endsWith(".sh") && !keep.has(f)) await fs.rm(path.join(paths.setup, f), { force: true });
  for (const sc of scripts) await fs.writeFile(path.join(paths.setup, `${sc.name}.sh`), sc.script, { mode: 0o600 });
  const envs = scripts.filter((sc) => sc.env.trim());
  const envFile = path.join(paths.notes, "env.md");
  const current = await fs.readFile(envFile, "utf8").catch(() => "");
  // Only a recipe-written env.md is replaced; one the setup worker wrote is its own.
  if (envs.length && (!current || current.startsWith("<!-- from recipe "))) {
    await fs.mkdir(paths.notes, { recursive: true });
    await fs.writeFile(envFile, envs.map((sc) => `<!-- from recipe ${sc.name}; true for the session it was saved from, verify here -->\n${sc.env.trim()}`).join("\n\n") + "\n");
  } else if (!envs.length && current.startsWith("<!-- from recipe ")) await fs.rm(envFile, { force: true });
};

/** The clone of a repository exists in the workspace (a repository picked earlier, or one from before initialization existed). */
export const cloneExists = (paths: SessionPaths, name: string): Promise<boolean> => fs.access(path.join(paths.workspace, name, ".git")).then(() => true, () => false);

/**
 * Initialization, host side: fresh clones of every picked repository at its
 * recorded branch, taken now so they are current when the work starts. A
 * repository already cloned (a retry after a failure, or an older session)
 * is left alone. On a failure the clones made in this call are removed, so
 * the session can be initialized again. Returns the updated repos.
 */
export const provisionSession = async (root: string, session: Session): Promise<{ repos: Session["repos"]; clones: CloneResult[] }> => {
  const paths = sessionPaths(root, session.id);
  const clones: CloneResult[] = [];
  const made: string[] = [];
  const repos: Session["repos"] = [];
  try {
    for (const r of session.repos) {
      if (await cloneExists(paths, r.name)) {
        repos.push(r);
        continue;
      }
      const clone = await cloneWorkTarget(r.sourcePath, path.join(paths.workspace, r.name), r.branch, session.id);
      made.push(clone.dest);
      clones.push(clone);
      repos.push({ ...r, branch: clone.branch, runBranch: clone.runBranch, baseCommit: clone.commit });
    }
  } catch (e) {
    for (const dest of made) await fs.rm(dest, { recursive: true, force: true });
    throw e;
  }
  return { repos, clones };
};

/** Removes the clones; the session is a plan again (the caller removes the sandbox and clears the session fields). */
export const removeClones = async (root: string, session: Session): Promise<void> => {
  const paths = sessionPaths(root, session.id);
  for (const r of session.repos) await fs.rm(path.join(paths.workspace, r.name), { recursive: true, force: true });
};

/**
 * The proxy re-reads this file; mode 0644 because the proxy runs as uid 1000.
 * Written to a temp file and renamed: the proxy mounts the directory, so it
 * sees the new file at the same path and never a half-written one.
 */
export const writeAllowlist = async (paths: SessionPaths, allowlist: readonly string[]): Promise<void> => {
  await fs.mkdir(paths.proxyDir, { recursive: true, mode: 0o755 });
  const tmp = `${paths.allowlist}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(allowlist, null, 2) + "\n", { mode: 0o644 });
  await fs.rename(tmp, paths.allowlist);
};

export const LEGACY_PREFLIGHT_REQUIREMENTS = "The goal and the board can be worked in this box: the tools, services and network hosts the tickets need are present and verified by running them.";

/**
 * Sessions from before the setup phase: an "agentic initialization" tick
 * (caps.preflight) becomes generic requirements, and a passed check counts
 * as confirmed so a running session is not gated after an upgrade.
 *
 * Sessions from before initialization existed (no `initializedAt` field)
 * were cloned at creation, so they count as initialized from their creation,
 * unless they were still gated by unconfirmed requirements: those stay
 * uninitialized and finish through the Initialize button, which skips the
 * clones that exist.
 */
export const migrateSession = (raw: unknown): unknown => {
  if (!raw || typeof raw !== "object") return raw;
  const r = { ...(raw as Record<string, unknown>) };
  const caps = r.caps as Record<string, unknown> | undefined;
  const pre = r.preflight as { ok?: boolean; at?: string; summary?: string } | undefined;
  if (r.requirements === undefined && caps?.preflight === true) r.requirements = LEGACY_PREFLIGHT_REQUIREMENTS;
  if (r.readiness === undefined && pre?.at) {
    r.readiness = { verdict: pre.ok ? "ready" : "needs", at: pre.at, summary: pre.summary ?? "", checks: [], confirmedAt: pre.ok ? pre.at : undefined };
  }
  delete r.preflight;
  if (r.initializedAt === undefined) {
    const readiness = r.readiness as { confirmedAt?: string } | undefined;
    const gated = Boolean(String(r.requirements ?? "").trim()) && !readiness?.confirmedAt;
    r.initializedAt = gated ? null : (r.createdAt as string | undefined) ?? null;
  }
  return r;
};

export const loadSession = async (root: string, id: string): Promise<Session> => {
  const paths = sessionPaths(root, id);
  return sessionSchema.parse(migrateSession(JSON.parse(await fs.readFile(paths.session, "utf8"))));
};

export const saveSession = async (root: string, session: Session): Promise<void> => {
  await writeJsonAtomic(sessionPaths(root, session.id).session, sessionSchema.parse(session));
};

/**
 * Older request shapes are migrated on load so session files keep working:
 * the single-`detail` requests of 2026-10-03 (install, decision, secret,
 * network, resources, root_command, ask, halt) become one request with one
 * action (or a halt flag). Saved back in the new shape on the next write.
 *
 * root_script actions (retired 2026-10-04: the agent installs with sudo)
 * become instructions that keep the script, so the history reads right and
 * an open one can still be done by hand or declined.
 */
export const migrateInbox = (raw: unknown): unknown => {
  if (!raw || typeof raw !== "object") return raw;
  const r = raw as { requests?: Record<string, unknown>[] };
  if (!Array.isArray(r.requests)) return raw;
  const retire = (detail: Record<string, unknown>): Record<string, unknown> =>
    detail.kind === "root_script"
      ? { kind: "instruction", text: `Retired request kind: run as root in the box (the agent now installs with sudo itself; decline to let the next worker do it).\n\n${String(detail.script ?? "").slice(0, 4800)}` }
      : detail;
  const requests = r.requests.map((req) => {
    if (Array.isArray(req.actions)) return { ...req, actions: (req.actions as Record<string, unknown>[]).map((a) => (a && typeof a === "object" && a.detail ? { ...a, detail: retire(a.detail as Record<string, unknown>) } : a)) };
    if (!req.detail) return req;
    const d = req.detail as Record<string, unknown>;
    const why = String(req.why ?? "");
    const oldState = String(req.state ?? "open");
    const actionState = oldState === "approved" ? "approved" : oldState === "denied" ? "declined" : "open";
    const base = { id: req.id, ticketId: req.ticketId, summary: why || "(migrated request)", state: oldState === "open" ? "open" : "resolved", answer: req.answer, createdAt: req.createdAt, decidedAt: req.decidedAt };
    const act = (detail: Record<string, unknown>) => ({ ...base, actions: [{ id: "a1", detail: retire(detail), state: actionState, outcome: req.answer, decidedAt: req.decidedAt }] });
    switch (d.kind) {
      case "network":
      case "resources":
        return act(d);
      case "root_command":
        return act({ kind: "root_script", script: String(d.command ?? ""), cwd: d.cwd });
      case "install": {
        const packages = Array.isArray(d.packages) ? d.packages.map(String).join(" ") : "";
        const cmd = d.manager === "apt" ? `apt-get update && apt-get install -y --no-install-recommends ${packages}` : d.manager === "npm" ? `npm install -g ${packages}` : `pip install --break-system-packages ${packages}`;
        return act({ kind: "root_script", script: cmd });
      }
      case "decision":
        return act({ kind: "question", text: String(d.question ?? "") });
      case "secret":
        return act({ kind: "instruction", text: `Place the secret ${String(d.name ?? "")} in a file under /workspace. ${String(d.purpose ?? "")}` });
      case "ask":
        return act({ kind: "instruction", text: [d.what, d.how, d.verify ? `Verify: ${String(d.verify)}` : ""].filter(Boolean).map(String).join(" ") });
      case "halt":
        return { ...base, actions: [], halt: { reason: String(d.reason ?? ""), severity: d.severity === "critical" ? "critical" : "major" } };
      default:
        return { ...base, actions: [] };
    }
  });
  return { ...r, requests };
};

export const loadInbox = async (root: string, id: string): Promise<Inbox> => {
  try {
    return inboxSchema.parse(migrateInbox(JSON.parse(await fs.readFile(sessionPaths(root, id).inbox, "utf8"))));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return inboxSchema.parse({});
    throw e;
  }
};

export const saveInbox = async (root: string, id: string, inbox: Inbox): Promise<void> => {
  await writeJsonAtomic(sessionPaths(root, id).inbox, inboxSchema.parse(inbox));
};

export const listSessions = async (root: string): Promise<Session[]> => {
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const sessions: Session[] = [];
  for (const id of entries) {
    if (!SESSION_ID_PATTERN.test(id)) continue;
    try {
      sessions.push(await loadSession(root, id));
    } catch {
      // A directory without a valid session.json is not a session; `doctor` reports it.
    }
  }
  return sessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
};

/** Removes the directory. Callers stop the sandbox first (see sandbox/lifecycle). */
export const deleteSessionDir = async (root: string, id: string): Promise<void> => {
  const paths = sessionPaths(root, id);
  // Refuse anything that is not a direct child of the root, whatever the id pattern allowed.
  if (path.dirname(paths.dir) !== path.resolve(root)) throw new Error("Refusing to delete outside the sessions root");
  await fs.rm(paths.dir, { recursive: true, force: true });
};

/** Size of workspace/ in MB, for the between-tickets check. */
export const workspaceSizeMb = async (paths: SessionPaths): Promise<number> => {
  let bytes = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) await walk(p);
      else if (ent.isFile()) bytes += (await fs.stat(p)).size;
    }
  };
  await walk(paths.workspace);
  return Math.round(bytes / 1_048_576);
};

import { promises as fs } from "node:fs";
import path from "node:path";
import {
  DEFAULT_ALLOWLIST,
  inboxSchema,
  now,
  sessionSchema,
  SESSION_ID_PATTERN,
  type Inbox,
  type Session,
  type SessionSetupScript,
} from "../core/types.js";
import { writeJsonAtomic, saveBoard } from "../board/store.js";
import { emptyBoard } from "../board/board.js";
import type { WorkTarget } from "../config.js";
import { cloneWorkTarget, extractZip, type CloneResult, type ExtractResult } from "./workspace.js";

/**
 * A session is a directory under the sessions root:
 *
 *   <root>/<id>/
 *     session.json      Session (core/types)
 *     board.json        Board
 *     inbox.json        requests, messages, ideas
 *     allowlist.json    string[]; mounted read-only into the proxy
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
    allowlist: path.join(dir, "allowlist.json"),
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
  goal: string;
  repos: { target: WorkTarget; branch?: string; name?: string }[];
  zips: { name: string; file: string }[];
  allowlist?: string[];
  image: string;
  model?: string;
  setupScripts?: SessionSetupScript[];
  caps?: Partial<Session["caps"]>;
  limits?: Partial<Session["limits"]>;
};

export type CreateSessionResult = {
  session: Session;
  paths: SessionPaths;
  clones: CloneResult[];
  extracts: ExtractResult[];
};

export const createSession = async (root: string, input: CreateSessionInput): Promise<CreateSessionResult> => {
  const id = await makeSessionId(root, input.name);
  const paths = sessionPaths(root, id);
  await fs.mkdir(paths.workspace, { recursive: true, mode: 0o755 });
  await fs.mkdir(paths.attachments, { recursive: true });
  await fs.mkdir(paths.notes, { recursive: true });
  await fs.mkdir(paths.runs, { recursive: true });
  await fs.mkdir(paths.exportDir, { recursive: true });
  await fs.mkdir(paths.setup, { recursive: true });
  // The agent's HOME lives in the workspace so dotfiles it writes stay in the box.
  await fs.mkdir(path.join(paths.workspace, ".home"), { recursive: true });

  const clones: CloneResult[] = [];
  const extracts: ExtractResult[] = [];
  const session: Session = sessionSchema.parse({
    id,
    name: input.name,
    goal: input.goal,
    createdAt: now(),
    image: input.image,
    model: input.model?.trim() || undefined,
    setupScripts: input.setupScripts ?? [],
    // Hosts the chosen scripts download from join the allowlist.
    allowlist: [...new Set([...(input.allowlist ?? [...DEFAULT_ALLOWLIST]), ...(input.setupScripts ?? []).flatMap((x) => x.hosts)])],
    caps: input.caps ?? {},
    limits: input.limits ?? {},
  });

  try {
    const used = new Set<string>(["attachments", "notes", ".home"]);
    for (const r of input.repos) {
      const name = r.name ?? r.target.name;
      if (used.has(name)) throw new Error(`Duplicate workspace directory name: ${name}`);
      used.add(name);
      const clone = await cloneWorkTarget(r.target.path, path.join(paths.workspace, name), r.branch, id);
      clones.push(clone);
      session.repos.push({ name, sourcePath: r.target.path, branch: clone.branch, runBranch: clone.runBranch, baseCommit: clone.commit });
    }
    for (const z of input.zips) {
      const dirName = z.name.replace(/\.zip$/i, "").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 100) || "attachment";
      const ex = await extractZip(z.file, path.join(paths.attachments, dirName));
      extracts.push(ex);
      session.attachments.push({ name: z.name, dir: dirName, bytes: ex.bytes, skipped: ex.skipped });
    }
    // A copy of each script, readable in the session directory; the container runs the copy.
    for (const sc of session.setupScripts) await fs.writeFile(path.join(paths.setup, `${sc.name}.sh`), sc.script, { mode: 0o600 });
    await writeJsonAtomic(paths.session, session);
    await saveBoard(paths.dir, emptyBoard(input.goal));
    await writeJsonAtomic(paths.inbox, inboxSchema.parse({}));
    await writeAllowlist(paths, session.allowlist);
  } catch (e) {
    await fs.rm(paths.dir, { recursive: true, force: true });
    throw e;
  }
  return { session, paths, clones, extracts };
};

/** The proxy re-reads this file; mode 0644 because the proxy runs as uid 1000. */
export const writeAllowlist = async (paths: SessionPaths, allowlist: readonly string[]): Promise<void> => {
  const tmp = `${paths.allowlist}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(allowlist, null, 2) + "\n", { mode: 0o644 });
  await fs.rename(tmp, paths.allowlist);
};

export const loadSession = async (root: string, id: string): Promise<Session> => {
  const paths = sessionPaths(root, id);
  return sessionSchema.parse(JSON.parse(await fs.readFile(paths.session, "utf8")));
};

export const saveSession = async (root: string, session: Session): Promise<void> => {
  await writeJsonAtomic(sessionPaths(root, session.id).session, sessionSchema.parse(session));
};

/**
 * Request kinds that existed before the four-kind model (2026-10-03):
 * install -> root_command, decision/secret -> ask. Applied on load so old
 * session files keep working; saved back in the new shape on the next write.
 */
export const migrateInbox = (raw: unknown): unknown => {
  if (!raw || typeof raw !== "object") return raw;
  const r = raw as { requests?: Record<string, unknown>[] };
  if (!Array.isArray(r.requests)) return raw;
  const requests = r.requests.map((req) => {
    const detail = (req.detail ?? {}) as Record<string, unknown>;
    if (detail.kind === "install") {
      const packages = Array.isArray(detail.packages) ? detail.packages.map(String).join(" ") : "";
      const cmd = detail.manager === "apt" ? `apt-get update && apt-get install -y --no-install-recommends ${packages}` : detail.manager === "npm" ? `npm install -g ${packages}` : `pip install --break-system-packages ${packages}`;
      return { ...req, detail: { kind: "root_command", command: cmd } };
    }
    if (detail.kind === "decision") return { ...req, detail: { kind: "ask", what: String(detail.question ?? "") } };
    if (detail.kind === "secret") return { ...req, detail: { kind: "ask", what: `Place the secret ${String(detail.name ?? "")} in a file under /workspace`, how: String(detail.purpose ?? "") } };
    return req;
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

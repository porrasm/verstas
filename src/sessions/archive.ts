import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { z } from "zod";
import { boardSchema, inboxSchema, now, sessionIdSchema, sessionSchema, type Session } from "../core/types.js";
import { writeJsonAtomic } from "../board/store.js";
import type { WorkTarget } from "../config.js";
import { migrateInbox, migrateSession, sessionPaths, writeAllowlist, writeRecipeFiles } from "./sessions.js";
import { cloneFromBundle, entryProblem } from "./workspace.js";

/**
 * A session archive (`<id>.ver`, a zip): everything a session is except its
 * environment, so another machine can import it and initialize it again.
 *
 *   manifest.json        format, version, what is inside
 *   session.json         settings, requirements, prompts, the setup verdict
 *   board.json           the board
 *   inbox.json           requests, messages, ideas
 *   runs/<n>/...         run history: run.json, events.jsonl, ticket reports
 *   workspace/...        notes, attachments and other files beside the clones
 *   repos/<name>.bundle  each clone as a git bundle (--all), made in the container
 *
 * Light: no container, home volume or snapshot, and nothing a repository
 * ignores (node_modules, build output). Those are tied to the machine and
 * its CPU architecture; initialization on the importing machine rebuilds
 * them (the recipes, notes/setup.sh and the setup worker).
 *
 * Left out because they are recreated: proxy/ (from session.allowlist),
 * setup/ (from session.setupScripts), sandbox.env, export/, and any env file
 * under runs/.
 */

export const ARCHIVE_FORMAT = "verstas-session";
export const ARCHIVE_VERSION = 1;
/** Per file inside an archive: bundles of large repositories go past the attachment limit. */
export const ARCHIVE_MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024 - 1;
export const ARCHIVE_MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024;

export const archiveManifestSchema = z.object({
  format: z.literal(ARCHIVE_FORMAT),
  version: z.number().int(),
  mode: z.enum(["light"]),
  exportedAt: z.string(),
  verstasVersion: z.string().default(""),
  sessionId: sessionIdSchema,
  name: z.string(),
  /** False for a plan: no clones exist yet, so there are no bundles; the repositories are picks. */
  initialized: z.boolean(),
  repos: z.array(z.object({ name: z.string(), runBranch: z.string(), bundle: z.string().optional() })).default([]),
  /** Files left out at export (symlinks, special files), for the record. */
  skipped: z.array(z.string()).default([]),
});
export type ArchiveManifest = z.infer<typeof archiveManifestSchema>;

/** Directories under workspace/ that are not exported: the clones travel as bundles, the rest is Verstas's own scratch. */
const workspaceSkip = (repos: readonly { name: string }[]): Set<string> => new Set([...repos.map((r) => r.name), ".verstas", ".home"]);

const isEnvFile = (name: string): boolean => name === "env" || name.endsWith(".env");

/**
 * Regular files under `dir`, as paths relative to it. Symlinks and special
 * files are never followed or read: the workspace is the agent's, and a link
 * there could point anywhere on this machine.
 */
const walkFiles = async (dir: string, skipTop: (name: string) => boolean, skipped: string[], rel = ""): Promise<string[]> => {
  const out: string[] = [];
  let ents;
  try {
    ents = await fs.readdir(path.join(dir, rel), { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return out;
    throw e;
  }
  for (const ent of ents) {
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    if (!rel && skipTop(ent.name)) continue;
    if (ent.isSymbolicLink()) skipped.push(`${r}: symlink`);
    else if (ent.isDirectory()) out.push(...(await walkFiles(dir, skipTop, skipped, r)));
    else if (ent.isFile()) out.push(r);
    else skipped.push(`${r}: not a regular file`);
  }
  return out;
};

export type WriteArchiveInput = {
  root: string;
  session: Session;
  /** One bundle per repository, made inside the container; required for an initialized session. */
  bundles: { repo: string; file: string }[];
  outFile: string;
  verstasVersion?: string;
};

/** Writes the archive. The caller makes sure no run is active and the bundles are fresh. */
export const writeArchive = async (i: WriteArchiveInput): Promise<{ file: string; bytes: number; skipped: string[] }> => {
  const paths = sessionPaths(i.root, i.session.id);
  const initialized = Boolean(i.session.initializedAt);
  const zip = new AdmZip();
  const skipped: string[] = [];
  let total = 0;
  const add = async (entry: string, file: string) => {
    const st = await fs.lstat(file);
    if (!st.isFile()) {
      skipped.push(`${entry}: not a regular file`);
      return;
    }
    total += st.size;
    if (total > ARCHIVE_MAX_TOTAL_BYTES) throw new Error(`The session is larger than ${ARCHIVE_MAX_TOTAL_BYTES / 1024 ** 3} GB; remove large attachments or files beside the repositories first`);
    // adm-zip takes the permission bits and adds the file type itself.
    zip.addFile(entry, await fs.readFile(file), "", st.mode & 0o777);
  };

  for (const f of ["session.json", "board.json", "inbox.json"]) await add(f, path.join(paths.dir, f));
  for (const f of await walkFiles(paths.runs, () => false, skipped)) if (!isEnvFile(path.basename(f))) await add(`runs/${f}`, path.join(paths.runs, f));
  const skipTop = workspaceSkip(i.session.repos);
  for (const f of await walkFiles(paths.workspace, (n) => skipTop.has(n), skipped)) await add(`workspace/${f}`, path.join(paths.workspace, f));

  const repos: ArchiveManifest["repos"] = [];
  for (const r of i.session.repos) {
    const b = i.bundles.find((x) => x.repo === r.name);
    if (initialized && !b) throw new Error(`No bundle for ${r.name}`);
    if (b) await add(`repos/${r.name}.bundle`, b.file);
    repos.push({ name: r.name, runBranch: r.runBranch, bundle: b ? `repos/${r.name}.bundle` : undefined });
  }

  const manifest: ArchiveManifest = {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    mode: "light",
    exportedAt: now(),
    verstasVersion: i.verstasVersion ?? "",
    sessionId: i.session.id,
    name: i.session.name,
    initialized,
    repos,
    skipped,
  };
  zip.addFile("manifest.json", Buffer.from(JSON.stringify(manifest, null, 2) + "\n"));
  await fs.mkdir(path.dirname(i.outFile), { recursive: true });
  const tmp = `${i.outFile}.${process.pid}.tmp`;
  await zip.writeZipPromise(tmp, { overwrite: true });
  await fs.rename(tmp, i.outFile);
  return { file: i.outFile, bytes: (await fs.stat(i.outFile)).size, skipped };
};

export class ArchiveError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const readJsonEntry = (zip: AdmZip, name: string): unknown => {
  const e = zip.getEntry(name);
  if (!e) throw new ArchiveError(`Not a Verstas session archive: ${name} is missing`);
  try {
    return JSON.parse(e.getData().toString("utf8"));
  } catch {
    throw new ArchiveError(`${name} in the archive is not valid JSON`);
  }
};

/** The manifest and session of an archive, checked; nothing is written. */
export const readArchive = (file: string): { zip: AdmZip; manifest: ArchiveManifest; session: Session } => {
  let zip: AdmZip;
  try {
    zip = new AdmZip(file);
  } catch (e) {
    throw new ArchiveError(`Not a zip file: ${(e as Error).message}`);
  }
  const raw = readJsonEntry(zip, "manifest.json") as { format?: unknown; version?: unknown };
  if (raw?.format !== ARCHIVE_FORMAT) throw new ArchiveError("Not a Verstas session archive");
  if (typeof raw.version !== "number" || raw.version > ARCHIVE_VERSION) throw new ArchiveError(`This archive is format version ${String(raw.version)}; this Verstas reads up to ${ARCHIVE_VERSION}. Update Verstas first.`);
  const manifest = archiveManifestSchema.parse(raw);
  const session = sessionSchema.parse(migrateSession(readJsonEntry(zip, "session.json")));
  return { zip, manifest, session };
};

export type ImportInput = {
  root: string;
  file: string;
  /** The id the session gets here: its own, or a fresh one for a copy. */
  id: string;
  /** A name other than the exported one, e.g. "Floralin (copy)" for a copy beside the original. */
  name?: string;
  /** This machine's repositories; a pick or clone is pointed at the one with the same name. */
  workTargets: readonly WorkTarget[];
  /** This machine's dev-box image. */
  image: string;
  /**
   * Replace the session of the same id here. Its environment (container,
   * home volume, snapshot) is removed once the import is unpacked and
   * cloned; its directory is swapped out and deleted only after the
   * imported one is in place.
   */
  replace?: { removeEnvironment: () => Promise<void> };
};

export type ImportResult = {
  session: Session;
  /** Repositories with no work target of the same name here: Apply needs one; Export bundles works regardless. */
  unmapped: string[];
  skipped: string[];
};

/**
 * Unpacks an archive into a staging directory beside the sessions, clones
 * every bundle, and moves it into place as `<root>/<id>`. The session comes
 * in as a plan with its clones in place: Initialize builds the container
 * here (recipes, notes/setup.sh, the setup worker) and keeps the clones.
 */
export const importArchive = async (i: ImportInput): Promise<ImportResult> => {
  const { zip, manifest, session: exported } = readArchive(i.file);
  const final = sessionPaths(i.root, i.id);
  const stagingDir = path.join(i.root, `.import-${crypto.randomBytes(6).toString("hex")}`);
  const staging = relocate(final, final.dir, stagingDir);
  const skipped: string[] = [];
  const skipTop = workspaceSkip(exported.repos);

  await fs.mkdir(i.root, { recursive: true });
  try {
    for (const d of [staging.workspace, staging.attachments, staging.notes, staging.runs, staging.exportDir, staging.setup]) await fs.mkdir(d, { recursive: true });

    // Files: only the known places, each entry checked like an attachment zip (no absolute paths, no .., no symlinks).
    let total = 0;
    for (const entry of zip.getEntries()) {
      const name = entry.entryName.replace(/\\/g, "/");
      if (entry.isDirectory || ["manifest.json", "session.json", "board.json", "inbox.json"].includes(name) || name.startsWith("repos/")) continue;
      const problem = entryProblem(name, entry.header.attr, entry.header.size, ARCHIVE_MAX_FILE_BYTES);
      if (problem) {
        skipped.push(`${name}: ${problem}`);
        continue;
      }
      let dest: string | null = null;
      if (name.startsWith("runs/")) dest = isEnvFile(path.basename(name)) ? null : path.join(staging.runs, name.slice(5));
      else if (name.startsWith("workspace/")) {
        const rel = name.slice(10);
        dest = rel && !skipTop.has(rel.split("/")[0]!) ? path.join(staging.workspace, rel) : null;
      }
      if (!dest) {
        skipped.push(`${name}: not part of a session`);
        continue;
      }
      total += entry.header.size;
      if (total > ARCHIVE_MAX_TOTAL_BYTES) throw new ArchiveError("The archive unpacks to more than the size limit");
      const mode = (entry.header.attr >>> 16) & 0o111 ? 0o755 : 0o644;
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, entry.getData(), { mode });
    }

    // Clones from the bundles, at the run branch, as they were in the container.
    const unmapped: string[] = [];
    const repos: Session["repos"] = [];
    for (const r of exported.repos) {
      const target = i.workTargets.find((w) => w.name === r.name);
      if (!target) unmapped.push(r.name);
      const m = manifest.repos.find((x) => x.name === r.name);
      if (m?.bundle) {
        const e = zip.getEntry(m.bundle);
        if (!e) throw new ArchiveError(`${m.bundle} is missing from the archive`);
        const bundleFile = path.join(staging.exportDir, `${r.name}.bundle`);
        await fs.writeFile(bundleFile, e.getData());
        try {
          await cloneFromBundle(bundleFile, path.join(staging.workspace, r.name), r.runBranch);
        } catch (err) {
          throw new ArchiveError(`${r.name}: ${(err as Error).message.split("\n")[0]}`);
        }
        await fs.rm(bundleFile, { force: true });
      } else if (manifest.initialized) throw new ArchiveError(`${r.name} has no bundle in the archive`);
      repos.push({ ...r, sourcePath: target?.path ?? r.sourcePath });
    }

    // The session as a plan of this machine: its image, no snapshot and no setup verdict; Initialize brings those.
    const session: Session = sessionSchema.parse({
      ...exported,
      id: i.id,
      name: i.name ?? exported.name,
      image: i.image,
      repos,
      initializedAt: null,
      readiness: undefined,
      snapshot: undefined,
      setup: [],
      state: "setup",
    });
    await writeJsonAtomic(staging.session, session);
    await writeJsonAtomic(staging.board, boardSchema.parse(readJsonEntry(zip, "board.json")));
    await writeJsonAtomic(staging.inbox, inboxSchema.parse(migrateInbox(readJsonEntry(zip, "inbox.json"))));
    await writeAllowlist(staging, session.allowlist);
    await writeRecipeFiles(staging, session.setupScripts);
    await settleRuns(staging.runs, i.id);

    let aside: string | null = null;
    if (i.replace) {
      await i.replace.removeEnvironment();
      aside = path.join(i.root, `.replaced-${crypto.randomBytes(6).toString("hex")}`);
      await fs.rename(final.dir, aside);
    }
    try {
      // Without replace, an existing directory makes this fail rather than mix two sessions.
      await fs.rename(stagingDir, final.dir);
    } catch (e) {
      if (aside) await fs.rename(aside, final.dir).catch(() => undefined);
      throw (e as NodeJS.ErrnoException).code === "ENOTEMPTY" || (e as NodeJS.ErrnoException).code === "EEXIST" ? new ArchiveError(`A session ${i.id} exists here already`, 409) : e;
    }
    if (aside) await fs.rm(aside, { recursive: true, force: true });
    return { session, unmapped, skipped };
  } catch (e) {
    await fs.rm(stagingDir, { recursive: true, force: true });
    throw e;
  }
};

/** The same layout as `paths`, under another directory. */
const relocate = <T extends Record<string, string>>(paths: T, from: string, to: string): T =>
  Object.fromEntries(Object.entries(paths).map(([k, v]) => [k, v === from ? to : v.startsWith(from + path.sep) ? to + v.slice(from.length) : v])) as T;

/**
 * Run records name their session, and one left "running" by a host that
 * died before the export would show as live here: it is marked stopped.
 */
const settleRuns = async (runsDir: string, id: string): Promise<void> => {
  for (const n of await fs.readdir(runsDir).catch(() => [] as string[])) {
    const file = path.join(runsDir, n, "run.json");
    let run: Record<string, unknown>;
    try {
      run = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
    } catch {
      continue;
    }
    const next = { ...run, sessionId: id, ...(run.state === "running" ? { state: "stopped", endedAt: run.endedAt ?? now() } : {}) };
    await writeJsonAtomic(file, next);
  }
};

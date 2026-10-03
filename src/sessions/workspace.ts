import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import AdmZip from "adm-zip";

/**
 * What enters a workspace: fresh clones and extracted zips. See
 * docs/SANDBOX.md Boundary 1. Everything here runs on the host BEFORE the
 * session container exists, against repositories you own; after that, no
 * host git command ever runs inside a workspace.
 */

const execFileP = promisify(execFile);

const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/;

const git = async (args: string[], cwd?: string): Promise<string> => {
  const { stdout } = await execFileP("git", args, { cwd, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return stdout.trim();
};

export type CloneResult = { dest: string; branch: string; runBranch: string; commit: string };

export const runBranchName = (sessionId: string): string => `verstas/${sessionId}`;

/**
 * `git clone --no-local --template= --branch <b> --single-branch <src> <dest>`
 *
 * - `--no-local`: use the normal transport, which produces a self-contained
 *   clone: no hard links into your repository's objects, no alternates file
 *   pointing back at it.
 * - `--template=`: copy nothing from the git template directory, so a custom
 *   template with live hooks cannot seed hooks into the clone.
 * - `--single-branch`: only the branch you chose; unrelated branches stay home.
 * - Then the origin remote is removed (a host path means nothing in the box),
 *   a run branch is created, and a fixed author is configured for the
 *   harness's in-container commits.
 */
export const cloneWorkTarget = async (
  sourcePath: string,
  dest: string,
  branch: string | undefined,
  sessionId: string,
): Promise<CloneResult> => {
  const src = path.resolve(sourcePath);
  const inside = await git(["-C", src, "rev-parse", "--is-inside-work-tree"]).catch(() => "false");
  if (inside !== "true") throw new Error(`${sourcePath} is not a git work tree`);
  const chosen = branch ?? (await git(["-C", src, "symbolic-ref", "--short", "HEAD"]));
  if (!BRANCH_RE.test(chosen) || chosen.startsWith("-")) throw new Error(`Bad branch name: ${chosen}`);

  await git(["clone", "--no-local", "--template=", "--branch", chosen, "--single-branch", "--", src, dest]);
  await git(["-C", dest, "remote", "remove", "origin"]);
  const runBranch = runBranchName(sessionId);
  await git(["-C", dest, "checkout", "-q", "-b", runBranch]);
  await git(["-C", dest, "config", "user.name", "Verstas"]);
  await git(["-C", dest, "config", "user.email", "verstas@localhost"]);
  await git(["-C", dest, "config", "commit.gpgsign", "false"]);
  const commit = await git(["-C", dest, "rev-parse", "HEAD"]);
  return { dest, branch: chosen, runBranch, commit };
};

export const ZIP_MAX_FILE_BYTES = 200 * 1024 * 1024;
export const ZIP_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
export const ZIP_MAX_ENTRIES = 50_000;

export type ExtractResult = { dir: string; files: number; bytes: number; skipped: string[] };

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

/**
 * Extracts a zip entry by entry with the checks `extractAllTo` does not
 * make strictly enough: no absolute names, no `..` segments, no symlinks,
 * no file over the per-file limit, no archive over the total limit. Skipped
 * entries are returned so the session log can show them.
 */
export const extractZip = async (zipFile: string, destDir: string): Promise<ExtractResult> => {
  const zip = new AdmZip(zipFile);
  const entries = zip.getEntries();
  if (entries.length > ZIP_MAX_ENTRIES) throw new Error(`Zip has ${entries.length} entries; the limit is ${ZIP_MAX_ENTRIES}`);
  await fs.mkdir(destDir, { recursive: true });
  const root = path.resolve(destDir);
  let files = 0;
  let bytes = 0;
  const skipped: string[] = [];

  for (const entry of entries) {
    const name = entry.entryName.replace(/\\/g, "/");
    const reason = entryProblem(name, entry.header.attr, entry.header.size);
    if (reason) {
      skipped.push(`${name}: ${reason}`);
      continue;
    }
    const target = path.resolve(root, name);
    if (target !== root && !target.startsWith(root + path.sep)) {
      skipped.push(`${name}: escapes the destination`);
      continue;
    }
    if (entry.isDirectory) {
      await fs.mkdir(target, { recursive: true });
      continue;
    }
    if (bytes + entry.header.size > ZIP_MAX_TOTAL_BYTES) {
      skipped.push(`${name}: total size limit reached`);
      continue;
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    const data = entry.getData();
    await fs.writeFile(target, data, { mode: 0o644 });
    files++;
    bytes += data.length;
  }
  return { dir: destDir, files, bytes, skipped };
};

export const entryProblem = (name: string, attr: number, size: number): string | null => {
  if (!name || name.startsWith("/") || /^[A-Za-z]:/.test(name)) return "absolute path";
  if (name.split("/").some((seg) => seg === "..")) return "parent directory segment";
  if (name.includes("\0")) return "nul in name";
  const mode = (attr >>> 16) & 0xffff;
  if ((mode & S_IFMT) === S_IFLNK) return "symlink";
  if (size > ZIP_MAX_FILE_BYTES) return "file too large";
  return null;
};

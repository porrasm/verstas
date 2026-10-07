import { promises as fs } from "node:fs";
import path from "node:path";
import type { Readiness, Session } from "../core/types.js";
import type { SessionPaths } from "./sessions.js";

/**
 * A new session from an existing session's environment: a fresh board on a
 * box that is already set up, without running setup again. The source is
 * never modified. This module decides what carries over; the route in
 * src/web/api.ts does the Docker work (copyHomeVolume, copySnapshot) and the
 * clones, then initializes through the usual path.
 */

/** Notes that describe the box: always copied. `tools` is a directory. */
export const ENVIRONMENT_NOTES = ["env.md", "setup.sh", "tools", "INDEX.md"] as const;
/** What workers learned about the project: copied unless you untick it. */
export const PROJECT_NOTES = ["brief.md", "learnings.md"] as const;
/** The last lead's handoff belongs to the old board: never copied. */
export const NEVER_NOTES = ["state.md"] as const;

export type EnvironmentCopy = {
  /** brief.md and learnings.md (default on). */
  projectNotes: boolean;
  /** Every note but state.md (default off). */
  allNotes: boolean;
  /** The source's attachments (default off). */
  attachments: boolean;
};

/** Which entries of the source's notes directory are copied. */
export const notesToCopy = (names: readonly string[], o: Pick<EnvironmentCopy, "projectNotes" | "allNotes">): string[] =>
  names.filter((n) => {
    if ((NEVER_NOTES as readonly string[]).includes(n)) return false;
    if (o.allNotes) return true;
    return (ENVIRONMENT_NOTES as readonly string[]).includes(n) || (o.projectNotes && (PROJECT_NOTES as readonly string[]).includes(n));
  });

/**
 * The settings a session started from `source` takes: the box (image,
 * recipes, root scripts, network), the limits, caps, agents, mode and setup
 * instructions. The readiness comes along only when it was confirmed ready
 * and your requirements are the source's; changed requirements leave it out
 * so the setup worker checks the box against them. The board, inbox, runs,
 * prompts, chores, remote flag, id and name never come along.
 */
export const environmentSettings = (
  source: Session,
  form: { requirements?: string },
  at: string,
): Pick<Session, "image" | "setupScripts" | "rootScripts" | "allowlist" | "packs" | "preapprove" | "limits" | "caps" | "agents" | "model" | "requirements" | "setupMode" | "mode" | "environmentFrom"> & { readiness?: Readiness } => {
  const requirements = (form.requirements ?? source.requirements).trim();
  const carry = Boolean(source.readiness?.verdict === "ready" && source.readiness.confirmedAt) && requirements === source.requirements.trim();
  return {
    image: source.image,
    setupScripts: source.setupScripts,
    rootScripts: source.rootScripts,
    allowlist: source.allowlist,
    packs: source.packs,
    preapprove: source.preapprove,
    limits: source.limits,
    caps: source.caps,
    agents: source.agents,
    model: source.model,
    requirements,
    setupMode: source.setupMode,
    mode: source.mode,
    readiness: carry ? source.readiness : undefined,
    environmentFrom: { session: source.id, at, readinessCarried: carry },
  };
};

/** Copies the chosen notes (and attachments) from the source's directories; returns what was copied. */
export const copyEnvironmentFiles = async (from: SessionPaths, to: SessionPaths, o: EnvironmentCopy): Promise<{ notes: string[]; attachments: boolean }> => {
  const names = await fs.readdir(from.notes).catch(() => [] as string[]);
  const notes = notesToCopy(names, o);
  await fs.mkdir(to.notes, { recursive: true });
  for (const n of notes) await fs.cp(path.join(from.notes, n), path.join(to.notes, n), { recursive: true, force: true });
  if (o.attachments) await fs.cp(from.attachments, to.attachments, { recursive: true, force: true }).catch(() => undefined);
  return { notes, attachments: o.attachments };
};

import { promises as fs } from "node:fs";
import path from "node:path";
import type { Session } from "../core/types.js";
import type { SessionPaths } from "./sessions.js";

/**
 * A new session from an existing session's environment: a fresh board on a
 * box that is already set up, without running setup again. The source is
 * never modified. This module decides what carries over; the route in
 * src/web/api.ts does the Docker work (copyHomeVolume, copySnapshot) and the
 * clones, then initializes through the usual path.
 */

/** The last lead's plan and handoff note belongs to the old board: never copied. */
export const NEVER_NOTES = ["state.md"] as const;

export type EnvironmentCopy = {
  /** The source's notes directory, state.md excepted (default on): what earlier leads wrote down about the box and the project. */
  notes: boolean;
  /** The source's attachments (default off). */
  attachments: boolean;
};

/** Which entries of the source's notes directory are copied. */
export const notesToCopy = (names: readonly string[], o: Pick<EnvironmentCopy, "notes">): string[] =>
  names.filter((n) => o.notes && !(NEVER_NOTES as readonly string[]).includes(n));

/**
 * The settings a session started from `source` takes: the box (image,
 * recipes, root scripts, network), the limits, caps and agents. The board,
 * inbox, runs, prompts, remote flag, id and name never come along.
 */
export const environmentSettings = (source: Session, at: string): Pick<Session, "image" | "setupScripts" | "rootScripts" | "allowlist" | "packs" | "preapprove" | "limits" | "caps" | "agents" | "model" | "environmentFrom"> => ({
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
  environmentFrom: { session: source.id, at },
});

/** Copies the chosen notes (and attachments) from the source's directories; returns what was copied. */
export const copyEnvironmentFiles = async (from: SessionPaths, to: SessionPaths, o: EnvironmentCopy): Promise<{ notes: string[]; attachments: boolean }> => {
  const names = await fs.readdir(from.notes).catch(() => [] as string[]);
  const notes = notesToCopy(names, o);
  await fs.mkdir(to.notes, { recursive: true });
  for (const n of notes) await fs.cp(path.join(from.notes, n), path.join(to.notes, n), { recursive: true, force: true });
  if (o.attachments) await fs.cp(from.attachments, to.attachments, { recursive: true, force: true }).catch(() => undefined);
  return { notes, attachments: o.attachments };
};

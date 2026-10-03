import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { verstasHome } from "../config.js";

/**
 * The setup script library: named bash scripts you write once and tick
 * at session creation. Stored as two files per script under
 * `~/.verstas/scripts/`: `<name>.sh` (the script, editable in any editor)
 * and `<name>.json` (description, hosts it downloads from, a note for the
 * worker). Sessions get a copy at creation, so editing the library never
 * changes a running session.
 */

export const SCRIPT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const setupScriptMetaSchema = z.object({
  name: z.string().regex(SCRIPT_NAME_PATTERN),
  description: z.string().max(500).default(""),
  /** Hosts the script downloads from; merged into the session allowlist. */
  hosts: z.array(z.string().trim().min(1).max(260)).max(50).default([]),
  /** One paragraph for VERSTAS.md: what is installed and how to use it. */
  note: z.string().max(2000).default(""),
});

export const setupScriptSchema = setupScriptMetaSchema.extend({
  script: z.string().min(1).max(200_000),
});
export type SetupScript = z.infer<typeof setupScriptSchema>;

export const scriptsDir = (home = verstasHome()): string => path.join(home, "scripts");

export const listScripts = async (home = verstasHome()): Promise<SetupScript[]> => {
  const dir = scriptsDir(home);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const out: SetupScript[] = [];
  for (const f of entries.filter((f) => f.endsWith(".json")).sort()) {
    const name = f.slice(0, -5);
    const s = await getScript(name, home).catch(() => null);
    if (s) out.push(s);
  }
  return out;
};

export const getScript = async (name: string, home = verstasHome()): Promise<SetupScript> => {
  if (!SCRIPT_NAME_PATTERN.test(name)) throw new Error(`Bad script name: ${name}`);
  const dir = scriptsDir(home);
  const meta = setupScriptMetaSchema.parse({ ...JSON.parse(await fs.readFile(path.join(dir, `${name}.json`), "utf8")), name });
  const script = await fs.readFile(path.join(dir, `${name}.sh`), "utf8");
  return setupScriptSchema.parse({ ...meta, script });
};

export const saveScript = async (input: unknown, home = verstasHome()): Promise<SetupScript> => {
  const s = setupScriptSchema.parse(input);
  const dir = scriptsDir(home);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const { script, ...meta } = s;
  await fs.writeFile(path.join(dir, `${s.name}.sh`), script.endsWith("\n") ? script : script + "\n", { mode: 0o600 });
  await fs.writeFile(path.join(dir, `${s.name}.json`), JSON.stringify(meta, null, 2) + "\n", { mode: 0o600 });
  return s;
};

export const deleteScript = async (name: string, home = verstasHome()): Promise<void> => {
  if (!SCRIPT_NAME_PATTERN.test(name)) throw new Error(`Bad script name: ${name}`);
  const dir = scriptsDir(home);
  await fs.rm(path.join(dir, `${name}.sh`), { force: true });
  await fs.rm(path.join(dir, `${name}.json`), { force: true });
};

/** "# needs-hosts: a.com b.com" in the first 20 lines, the convention the LLM context asks for. */
export const hostsFromScript = (script: string): string[] => {
  for (const line of script.split("\n").slice(0, 20)) {
    const m = /^#\s*needs-hosts:\s*(.+)$/i.exec(line.trim());
    if (m) return m[1]!.split(/[\s,]+/).filter(Boolean);
  }
  return [];
};

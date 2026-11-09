import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { verstasHome } from "../config.js";

/**
 * Goal templates: text you write once and pick per session, saying how the
 * work should be done ("research first, no time limit", "a prototype:
 * rough code is fine"), so a goal can say only what to do. One file per
 * template under `~/.verstas/templates/`, `<name>.md`, editable in any
 * editor.
 *
 * A session stores the template's name, not its text: every lead life and
 * every review reads the file as it is then, so an edit reaches the
 * sessions that use the template without touching them.
 */

/** A name you can read in a dropdown and that is also a safe file name: letters, digits, spaces and . _ & + -. */
export const TEMPLATE_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9 ._&+-]{0,62}[A-Za-z0-9._&+-])?$/;
export const templateNameSchema = z.string().regex(TEMPLATE_NAME_PATTERN, "A template name is 1 to 64 letters, digits, spaces or . _ & + -, and starts with a letter or digit");

export const goalTemplateSchema = z.object({
  name: templateNameSchema,
  text: z.string().trim().min(1, "The template is empty").max(20_000),
});
export type GoalTemplate = z.infer<typeof goalTemplateSchema> & { updatedAt?: string };

export const templatesDir = (home = verstasHome()): string => path.join(home, "templates");
const fileOf = (name: string, home: string): string => {
  if (!TEMPLATE_NAME_PATTERN.test(name)) throw new Error(`Bad template name: ${name}`);
  return path.join(templatesDir(home), `${name}.md`);
};

/** The template, or null when there is none by that name (it was deleted or renamed outside). */
export const getTemplate = async (name: string, home = verstasHome()): Promise<GoalTemplate | null> => {
  if (!TEMPLATE_NAME_PATTERN.test(name)) return null;
  const file = fileOf(name, home);
  try {
    const text = (await fs.readFile(file, "utf8")).trim();
    if (!text) return null;
    return { name, text: text.slice(0, 20_000), updatedAt: (await fs.stat(file)).mtime.toISOString() };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
};

export const listTemplates = async (home = verstasHome()): Promise<GoalTemplate[]> => {
  let entries: string[];
  try {
    entries = await fs.readdir(templatesDir(home));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const out: GoalTemplate[] = [];
  for (const f of entries.filter((f) => f.endsWith(".md")).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))) {
    const t = await getTemplate(f.slice(0, -3), home).catch(() => null);
    if (t) out.push(t);
  }
  return out;
};

export const saveTemplate = async (input: unknown, home = verstasHome()): Promise<GoalTemplate> => {
  const t = goalTemplateSchema.parse(input);
  await fs.mkdir(templatesDir(home), { recursive: true, mode: 0o700 });
  await fs.writeFile(fileOf(t.name, home), t.text + "\n", { mode: 0o600 });
  return (await getTemplate(t.name, home))!;
};

export const deleteTemplate = async (name: string, home = verstasHome()): Promise<void> => {
  await fs.rm(fileOf(name, home), { force: true });
};

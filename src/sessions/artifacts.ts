import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";

/**
 * Session artifacts: files an agent publishes because you asked for them
 * (a screenshot, a report, a log), to look at or download on the session
 * page. Each is a copy made at publish time, kept outside the workspace,
 * so the box cannot change it afterwards. Publishing a name again replaces
 * the earlier file. They stay until you delete them.
 */

export const ARTIFACT_MAX_BYTES = 25 * 1024 * 1024;
export const ARTIFACT_MAX_COUNT = 50;
/** Text over this is offered as a download only. */
export const ARTIFACT_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024;

const artifactSchema = z.object({
  id: z.string().regex(/^a\d+$/),
  name: z.string(),
  bytes: z.number().int().nonnegative(),
  /** text and image have a preview in the page; file is a download only. */
  kind: z.enum(["text", "image", "file"]),
  /** What the file is served as: worked out from its bytes, never from the name the agent gave. */
  mime: z.string(),
  runId: z.number().int(),
  publishedAt: z.string(),
});
export type Artifact = z.infer<typeof artifactSchema>;

const INDEX = "index.json";

/** The name shown and downloaded: the last path part, in plain characters. */
export const artifactName = (raw: string): string => {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[^A-Za-z0-9._ -]+/g, "-").replace(/^[.\s-]+/, "").trim().slice(0, 120);
  return clean || "artifact";
};

const IMAGES: { mime: string; test: (b: Buffer) => boolean }[] = [
  { mime: "image/png", test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: "image/jpeg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "image/gif", test: (b) => b.subarray(0, 4).toString("latin1") === "GIF8" },
  { mime: "image/webp", test: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
];

/**
 * What a file is, from its bytes: one of the raster image formats a browser
 * shows without running anything, UTF-8 text without NUL bytes, or else a
 * plain download. SVG and HTML are text here, so they are shown as source.
 */
export const sniffArtifact = (bytes: Buffer, total = bytes.length): Pick<Artifact, "kind" | "mime"> => {
  const image = IMAGES.find((i) => i.test(bytes));
  if (image) return { kind: "image", mime: image.mime };
  if (total <= ARTIFACT_TEXT_PREVIEW_BYTES && !bytes.includes(0)) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return { kind: "text", mime: "text/plain; charset=utf-8" };
    } catch {
      // not UTF-8
    }
  }
  return { kind: "file", mime: "application/octet-stream" };
};

export const loadArtifacts = async (dir: string): Promise<Artifact[]> => {
  const raw = await fs.readFile(path.join(dir, INDEX), "utf8").catch(() => "[]");
  const parsed = z.array(artifactSchema).safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : [];
};

const saveIndex = async (dir: string, list: Artifact[]): Promise<void> => {
  const tmp = path.join(dir, `${INDEX}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(list, null, 2));
  await fs.rename(tmp, path.join(dir, INDEX));
};

/** One writer per directory: two publishes at once must not lose an index entry. */
const chains = new Map<string, Promise<unknown>>();
const serial = <T>(dir: string, fn: () => Promise<T>): Promise<T> => {
  const p = (chains.get(dir) ?? Promise.resolve()).then(fn, fn);
  chains.set(dir, p.catch(() => undefined));
  return p;
};

/**
 * Adds an artifact: `fill` writes the file at the path it is given (and
 * resolves with its size); the bytes decide its kind. A name published
 * before is replaced.
 */
export const addArtifact = (dir: string, meta: { name: string; runId: number; now: string }, fill: (file: string) => Promise<number>): Promise<Artifact> =>
  serial(dir, async () => {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const list = await loadArtifacts(dir);
    const name = artifactName(meta.name);
    const others = list.filter((a) => a.name !== name);
    if (others.length >= ARTIFACT_MAX_COUNT) throw new Error(`This session holds ${ARTIFACT_MAX_COUNT} artifacts already: ask the user to delete some on the session page, or publish under a name used before to replace one`);
    const id = `a${list.reduce((m, a) => Math.max(m, Number(a.id.slice(1))), 0) + 1}`;
    const file = path.join(dir, id);
    await fs.rm(file, { force: true });
    const bytes = await fill(file);
    const fh = await fs.open(file, "r");
    let head: Buffer;
    try {
      head = Buffer.alloc(Math.min(bytes, ARTIFACT_TEXT_PREVIEW_BYTES));
      await fh.read(head, 0, head.length, 0);
    } finally {
      await fh.close();
    }
    const a: Artifact = { id, name, bytes, ...sniffArtifact(head, bytes), runId: meta.runId, publishedAt: meta.now };
    for (const old of list.filter((x) => x.name === name)) await fs.rm(path.join(dir, old.id), { force: true });
    await saveIndex(dir, [...others, a]);
    return a;
  });

/** The artifact and its file on the host; null when there is no such artifact. */
export const artifactFile = async (dir: string, id: string): Promise<{ artifact: Artifact; file: string } | null> => {
  const a = (await loadArtifacts(dir)).find((x) => x.id === id);
  return a ? { artifact: a, file: path.join(dir, a.id) } : null;
};

/** Deletes one artifact; false when there was none. */
export const deleteArtifact = (dir: string, id: string): Promise<boolean> =>
  serial(dir, async () => {
    const list = await loadArtifacts(dir);
    if (!list.some((a) => a.id === id)) return false;
    await fs.rm(path.join(dir, id), { force: true });
    await saveIndex(dir, list.filter((a) => a.id !== id));
    return true;
  });

export const clearArtifacts = (dir: string): Promise<void> => serial(dir, () => fs.rm(dir, { recursive: true, force: true }));

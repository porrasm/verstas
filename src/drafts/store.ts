import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";
import { now } from "../core/types.js";
import { writeJsonAtomic } from "../board/store.js";
import { verstasHome } from "../config.js";
import { DRAFT_FORMAT_VERSION, DRAFT_ID_PATTERN, DraftError, draftSchema, makeDraftId, type Draft } from "./draft.js";

/**
 * Drafts on disk: `$VERSTAS_HOME/drafts/<id>.json`, one file each, outside
 * the sessions root (a draft is not a session and has no directory of its
 * own). The host app is the only writer: the draft MCP endpoint and the UI
 * API share one store, every write is serialised per draft, and each one
 * emits `change` so open pages update while an assistant edits.
 */

export type DraftChange = { draftId: string; draft?: Draft; deleted?: boolean };

export const draftsDir = (home = verstasHome()): string => path.join(home, "drafts");

export class DraftStore extends EventEmitter {
  private chains = new Map<string, Promise<unknown>>();

  constructor(readonly dir: string = draftsDir()) {
    super();
  }

  private file(id: string): string {
    if (!DRAFT_ID_PATTERN.test(id)) throw new DraftError(`No draft ${id}`, "not_found");
    return path.join(this.dir, `${id}.json`);
  }

  /** Every draft that parses, newest change first. A file that does not parse is skipped. */
  async list(): Promise<Draft[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    const out: Draft[] = [];
    for (const f of entries) {
      if (!f.endsWith(".json")) continue;
      const d = await this.get(f.slice(0, -5)).catch(() => null);
      if (d) out.push(d);
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(id: string): Promise<Draft> {
    try {
      return draftSchema.parse(JSON.parse(await fs.readFile(this.file(id), "utf8")));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new DraftError(`No draft ${id}`, "not_found");
      throw e;
    }
  }

  async create(input: { name: string; goal?: string; createdBy: Draft["createdBy"] }): Promise<Draft> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = makeDraftId(input.name, () => crypto.randomBytes(2).toString("hex"));
      const at = now();
      const draft = draftSchema.parse({ verstasDraft: DRAFT_FORMAT_VERSION, id, name: input.name, goal: input.goal ?? "", createdBy: input.createdBy, createdAt: at, updatedAt: at });
      try {
        // "wx": never overwrite a draft that happens to have the same id.
        await fs.writeFile(this.file(id), JSON.stringify(draft, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw e;
      }
      this.emit("change", { draftId: id, draft } satisfies DraftChange);
      return draft;
    }
    throw new DraftError("Could not find a free draft id", "conflict");
  }

  /**
   * Read-modify-write for one draft, serialised per id. `fn` returns the
   * next draft (validated here) and an optional result. A draft that became
   * a session is read-only unless `allowPromoted` is set (only the step
   * that records the promotion uses it).
   */
  mutate<T = undefined>(id: string, fn: (d: Draft) => { draft: Draft; result?: T }, opts: { allowPromoted?: boolean } = {}): Promise<{ draft: Draft; result: T }> {
    const prev = this.chains.get(id) ?? Promise.resolve();
    const run = prev.then(async () => {
      const current = await this.get(id);
      if (current.promotedTo && !opts.allowPromoted) {
        throw new DraftError(`Draft ${id} already became the session ${current.promotedTo}; drafts can only be edited before that`, "promoted");
      }
      const out = fn(current);
      const draft = draftSchema.parse({ ...out.draft, id: current.id, verstasDraft: DRAFT_FORMAT_VERSION, createdAt: current.createdAt, createdBy: current.createdBy, updatedAt: now() });
      await writeJsonAtomic(this.file(id), draft);
      this.emit("change", { draftId: id, draft } satisfies DraftChange);
      return { draft, result: out.result as T };
    });
    // Keep the chain alive after a failure; the caller still sees the error.
    this.chains.set(id, run.catch(() => undefined));
    return run;
  }

  async markPromoted(id: string, sessionId: string): Promise<Draft> {
    const { draft } = await this.mutate(id, (d) => ({ draft: { ...d, promotedTo: sessionId, promotedAt: now() } }), { allowPromoted: true });
    return draft;
  }

  async remove(id: string): Promise<void> {
    await fs.rm(this.file(id), { force: true });
    this.chains.delete(id);
    this.emit("change", { draftId: id, deleted: true } satisfies DraftChange);
  }
}

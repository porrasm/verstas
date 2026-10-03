import { EventEmitter } from "node:events";
import path from "node:path";
import type { Board, Inbox, Session, VerstasEvent } from "../core/types.js";
import { loadBoard, saveBoard } from "../board/store.js";
import { loadInbox, loadSession, saveInbox, saveSession, sessionPaths, writeAllowlist, type SessionPaths } from "./sessions.js";

/**
 * One in-process owner per session directory. Every change to a session's
 * board, inbox or metadata goes through `mutate`, which serialises writers,
 * persists what changed, and emits a `change` event the UI's WebSocket and
 * the loop subscribe to. The agent API, the UI API and the loop all share
 * the same hub, so there is exactly one writer per file.
 */

export type SessionDocs = { session: Session; board: Board; inbox: Inbox };

export type ChangeEvent = { sessionId: string; session?: Session; board?: Board; inbox?: Inbox };
export type RunEvent = { sessionId: string; runId: number; event: VerstasEvent };

export class SessionHandle {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly root: string;
  constructor(
    readonly id: string,
    readonly paths: SessionPaths,
    private docs: SessionDocs,
    private readonly emit: (c: ChangeEvent) => void,
  ) {
    this.root = path.dirname(paths.dir);
  }

  get session(): Session {
    return this.docs.session;
  }
  get board(): Board {
    return this.docs.board;
  }
  get inbox(): Inbox {
    return this.docs.inbox;
  }
  snapshot(): SessionDocs {
    return { ...this.docs };
  }

  /**
   * Runs `fn` with a draft; whatever it returns in `next` replaces the
   * documents. Returning nothing leaves them untouched. Serialised per
   * session so two API calls cannot interleave their read-modify-write.
   */
  mutate<T>(fn: (docs: SessionDocs) => { next?: Partial<SessionDocs>; result?: T } | Promise<{ next?: Partial<SessionDocs>; result?: T }>): Promise<T> {
    const run = async (): Promise<T> => {
      const out = await fn(this.docs);
      const next = out.next ?? {};
      const changed: ChangeEvent = { sessionId: this.id };
      if (next.board && next.board !== this.docs.board) {
        await saveBoard(this.paths.dir, next.board);
        changed.board = next.board;
      }
      if (next.inbox && next.inbox !== this.docs.inbox) {
        await saveInbox(this.root, this.id, next.inbox);
        changed.inbox = next.inbox;
      }
      if (next.session && next.session !== this.docs.session) {
        await saveSession(this.root, next.session);
        if (next.session.allowlist !== this.docs.session.allowlist) await writeAllowlist(this.paths, next.session.allowlist);
        changed.session = next.session;
      }
      this.docs = { ...this.docs, ...next };
      if (changed.board || changed.inbox || changed.session) this.emit(changed);
      return out.result as T;
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }
}

export class SessionHub extends EventEmitter {
  private handles = new Map<string, Promise<SessionHandle>>();
  constructor(readonly root: string) {
    super();
  }

  get(id: string): Promise<SessionHandle> {
    let p = this.handles.get(id);
    if (!p) {
      p = (async () => {
        const paths = sessionPaths(this.root, id);
        const [session, board, inbox] = await Promise.all([loadSession(this.root, id), loadBoard(paths.dir), loadInbox(this.root, id)]);
        return new SessionHandle(id, paths, { session, board, inbox }, (c) => this.emit("change", c));
      })();
      this.handles.set(id, p);
      p.catch(() => this.handles.delete(id));
    }
    return p;
  }

  /** After a delete, or to force a re-read from disk. */
  forget(id: string): void {
    this.handles.delete(id);
  }

  /** Run events (worker output, loop decisions) fan out here for the WebSocket. */
  emitRunEvent(e: RunEvent): void {
    this.emit("event", e);
  }
}

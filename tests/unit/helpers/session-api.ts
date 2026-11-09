import { promises as fs } from "node:fs";
import type net from "node:net";
import os from "node:os";
import path from "node:path";
import { saveBoard, writeJsonAtomic } from "../../../src/board/store.js";
import { emptyBoard } from "../../../src/board/board.js";
import { inboxSchema, sessionSchema, type Board } from "../../../src/core/types.js";
import { SessionHub } from "../../../src/sessions/hub.js";
import { sessionPaths } from "../../../src/sessions/sessions.js";
import { createUiApi, type UiApiDeps } from "../../../src/web/api.js";

/**
 * A session on disk and the UI API in front of it, for tests of one route.
 * Nothing runs: `running` says whether the API sees an active run, and
 * `deps` adds or replaces what a route needs beyond the hub.
 */
export const sessionApi = async (opts: { id?: string; session?: Record<string, unknown>; board?: Board; inbox?: unknown; deps?: Partial<UiApiDeps> } = {}) => {
  const id = opts.id ?? "2026-11-09-test";
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "verstas-api-"));
  const paths = sessionPaths(root, id);
  await fs.mkdir(paths.workspace, { recursive: true });
  await writeJsonAtomic(paths.session, sessionSchema.parse({ id, name: "test", createdAt: "2026-11-09T00:00:00.000Z", ...opts.session }));
  await saveBoard(paths.dir, opts.board ?? emptyBoard());
  await writeJsonAtomic(paths.inbox, inboxSchema.parse(opts.inbox ?? {}));
  const hub = new SessionHub(root);
  const state = { running: false, messages: [] as string[], started: 0 };
  const runs = {
    status: () => (state.running ? { id: "r1" } : undefined),
    stopAndWait: async () => {
      state.running = false;
      return true;
    },
    start: async () => {
      state.started++;
      state.running = true;
      return { run: { id: 7, sessionId: id, state: "running" } };
    },
    message: async (_id: string, text: string) => {
      state.messages.push(text);
      return { ok: true, to: "lead" };
    },
  };
  const getConfig = () => ({ sessionsRoot: root, workTargets: [] });
  const server = createUiApi({ hub, runs, getConfig, ...opts.deps } as unknown as UiApiDeps).listen(0, "127.0.0.1");
  const port = await new Promise<number>((r) => server.on("listening", () => r((server.address() as net.AddressInfo).port)));
  const call = async <T = any>(method: string, route: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const r = await fetch(`http://127.0.0.1:${port}/api/sessions/${id}${route}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json().catch(() => null)) as T };
  };
  return {
    id,
    root,
    paths,
    hub,
    state,
    call,
    docs: () => hub.get(id),
    close: async () => {
      server.close();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
};

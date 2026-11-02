import { test, expect } from "@playwright/test";
import { promises as fs } from "node:fs";
import type net from "node:net";
import os from "node:os";
import path from "node:path";
import { emptyBoard, importBoard } from "../../src/board/board.js";
import { saveBoard, writeJsonAtomic } from "../../src/board/store.js";
import { inboxSchema, sessionSchema } from "../../src/core/types.js";
import { SessionHub } from "../../src/sessions/hub.js";
import { sessionPaths } from "../../src/sessions/sessions.js";
import { createUiApi, type UiApiDeps } from "../../src/web/api.js";

/** Clear board takes every ticket off in one step, keeps the goal, and waits for a run to stop. */

const base = { id: "2026-11-02-clear", name: "clear", createdAt: "2026-11-02T00:00:00.000Z" };

test("the session API clears the board, keeps the goal, and refuses while a run is active", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "verstas-clear-"));
  const paths = sessionPaths(root, base.id);
  await fs.mkdir(paths.workspace, { recursive: true });
  await writeJsonAtomic(paths.session, sessionSchema.parse(base));
  const board = importBoard(emptyBoard("the goal"), { tickets: [{ title: "one" }, { title: "two", deps: ["T-1"] }] }).board;
  await saveBoard(paths.dir, board);
  await writeJsonAtomic(paths.inbox, inboxSchema.parse({}));
  const hub = new SessionHub(root);
  let running = true;
  const deps = { hub, runs: { status: () => (running ? { id: "r1" } : undefined) } } as unknown as UiApiDeps;
  const server = createUiApi(deps).listen(0, "127.0.0.1");
  const port = await new Promise<number>((r) => server.on("listening", () => r((server.address() as net.AddressInfo).port)));
  const clear = () => fetch(`http://127.0.0.1:${port}/api/sessions/${base.id}/board/clear`, { method: "POST" });
  try {
    expect((await clear()).status).toBe(409);
    expect((await hub.get(base.id)).board.tickets).toHaveLength(2);
    running = false;
    const r = await clear();
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, removed: { tickets: 2 } });
    const after = (await hub.get(base.id)).board;
    expect(after.tickets).toEqual([]);
    expect(after.goal).toBe("the goal");
  } finally {
    server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

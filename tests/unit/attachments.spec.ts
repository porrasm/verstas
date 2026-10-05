import { test, expect } from "@playwright/test";
import { promises as fs } from "node:fs";
import type net from "node:net";
import os from "node:os";
import path from "node:path";
import { emptyBoard } from "../../src/board/board.js";
import { saveBoard, writeJsonAtomic } from "../../src/board/store.js";
import { attachmentLines, inboxSchema, sessionSchema } from "../../src/core/types.js";
import { setupPrompt, verstasMd } from "../../src/harness/prompts.js";
import { SessionHub } from "../../src/sessions/hub.js";
import { sessionPaths } from "../../src/sessions/sessions.js";
import { createUiApi, type UiApiDeps } from "../../src/web/api.js";

/** Attachments carry an optional description, in your words, that every worker sees beside the path. */

const base = { id: "2026-10-05-att", name: "att", createdAt: "2026-10-05T00:00:00.000Z" };
const attachments = [
  { name: "seminar.zip", dir: "plant_generation_seminar", bytes: 10, skipped: [], description: "The spec.\nTickets cite its sections." },
  { name: "ref.zip", dir: "lsystem-plant-generator-main", bytes: 20, skipped: [] },
];

test("workers see each attachment's path with its description; one without a description shows the path alone", () => {
  expect(attachmentLines(attachments)).toBe("- `/workspace/attachments/plant_generation_seminar`: The spec. Tickets cite its sections.\n- `/workspace/attachments/lsystem-plant-generator-main`");
  const session = sessionSchema.parse({ ...base, attachments });
  const md = verstasMd(session, "http://x/agent");
  expect(md).toContain("  - `/workspace/attachments/plant_generation_seminar`: The spec. Tickets cite its sections.");
  expect(setupPrompt(session, emptyBoard("g"), [], "setup")).toContain("# Attachments (what the user said they are)");
  expect(verstasMd(sessionSchema.parse(base), "http://x/agent")).toContain("Attachments the user added: none.");
  expect(setupPrompt(sessionSchema.parse(base), emptyBoard("g"), [], "setup")).not.toContain("# Attachments");
});

test("the session API sets and clears an attachment's description", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "verstas-att-"));
  const paths = sessionPaths(root, base.id);
  await fs.mkdir(paths.workspace, { recursive: true });
  await writeJsonAtomic(paths.session, sessionSchema.parse({ ...base, attachments }));
  await saveBoard(paths.dir, emptyBoard("g"));
  await writeJsonAtomic(paths.inbox, inboxSchema.parse({}));
  const hub = new SessionHub(root);
  const deps = { hub, runs: { status: () => undefined } } as unknown as UiApiDeps;
  const server = createUiApi(deps).listen(0, "127.0.0.1");
  const port = await new Promise<number>((r) => server.on("listening", () => r((server.address() as net.AddressInfo).port)));
  const put = (dir: string, body: unknown) => fetch(`http://127.0.0.1:${port}/api/sessions/${base.id}/attachments/${dir}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    expect((await put("lsystem-plant-generator-main", { description: "  Reference code: port the grammar, not the renderer.  " })).status).toBe(200);
    expect((await hub.get(base.id)).session.attachments[1]!.description).toBe("Reference code: port the grammar, not the renderer.");
    expect((await put("plant_generation_seminar", { description: "   " })).status).toBe(200);
    expect((await hub.get(base.id)).session.attachments[0]!.description).toBeUndefined();
    expect((await put("nope", { description: "x" })).status).toBe(404);
    expect((await put("plant_generation_seminar", { description: "x".repeat(1001) })).status).toBe(400);
  } finally {
    server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

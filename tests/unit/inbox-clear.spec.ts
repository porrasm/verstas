import { test, expect } from "@playwright/test";
import { inboxCleared, inboxSchema } from "../../src/core/types.js";
import { sessionApi } from "./helpers/session-api.js";

/** Clear inbox hides what is settled and deletes nothing; an open request stays. */

const request = (id: string, state: "open" | "resolved", extra: Record<string, unknown> = {}) => ({ id, summary: `${id} summary`, actions: [], state, createdAt: "2026-11-09T08:00:00.000Z", ...extra });
const filled = () => ({
  messages: [
    { id: "M-1", text: "first update", createdAt: "2026-11-09T08:00:00.000Z", progress: true },
    { id: "M-2", text: "a warning", createdAt: "2026-11-09T08:30:00.000Z" },
  ],
  ideas: [{ id: "I-1", title: "An idea", pitch: "Why", createdAt: "2026-11-09T08:10:00.000Z" }],
  requests: [request("R-1", "resolved", { decidedAt: "2026-11-09T08:20:00.000Z" }), request("R-2", "open")],
});

test("nothing is cleared until you clear; then everything settled by that moment is, and later items are not", () => {
  const inbox = inboxSchema.parse(filled());
  expect(inboxCleared(inbox).count).toBe(0);
  const at = inboxSchema.parse({ ...filled(), clearedAt: "2026-11-09T08:15:00.000Z" });
  const c = inboxCleared(at);
  expect([...c.messages]).toEqual(["M-1"]);
  expect([...c.ideas]).toEqual(["I-1"]);
  // R-1 was decided after the clear, and R-2 is open: both stay.
  expect([...c.requests]).toEqual([]);
});

test("the clear route hides messages, ideas and decided requests, keeps the open request and the file's contents", async () => {
  const s = await sessionApi({ inbox: filled() });
  try {
    const r = await s.call("POST", "/inbox/clear");
    expect(r.body).toEqual({ ok: true, cleared: 4 });
    const inbox = (await s.docs()).inbox;
    expect(inbox.messages).toHaveLength(2);
    expect(inbox.ideas).toHaveLength(1);
    expect(inbox.requests).toHaveLength(2);
    const c = inboxCleared(inbox);
    expect(c.count).toBe(4);
    expect(c.requests.has("R-2")).toBe(false);
    // Clearing again with nothing new clears nothing.
    expect((await s.call("POST", "/inbox/clear")).body).toEqual({ ok: true, cleared: 0 });
  } finally {
    await s.close();
  }
});

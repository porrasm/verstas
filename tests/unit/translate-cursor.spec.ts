import { test, expect } from "@playwright/test";
import { createCursorTranslator, cursorToolName } from "../../src/worker/translate-cursor.js";

const ctx = { ticket: "T-7", role: "reviewer" as const, now: () => "2026-10-03T10:00:00.000Z" };
const j = (o: unknown) => JSON.stringify(o);

test("cursor: init, assistant text, tool calls and result go through", () => {
  const t = createCursorTranslator(ctx);
  expect(t.line(j({ type: "system", subtype: "init", model: "sonnet-4.5", cwd: "/workspace", session_id: "s1" })).events).toEqual([{ kind: "status", t: ctx.now(), ticket: "T-7", text: "worker started · model sonnet-4.5" }]);

  const a = t.line(j({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Reading the diff." }] }, session_id: "s1" }));
  expect(a.assistantTurn).toBe(true);
  expect(a.events).toEqual([{ kind: "text", t: ctx.now(), ticket: "T-7", role: "reviewer", text: "Reading the diff." }]);

  const s = t.line(j({ type: "tool_call", subtype: "started", call_id: "c1", tool_call: { readToolCall: { args: { path: "src/engine/cc14.ts" } } } }));
  expect(s.events).toEqual([{ kind: "tool_use", t: ctx.now(), ticket: "T-7", tool: "Read", summary: "src/engine/cc14.ts" }]);

  const c = t.line(j({ type: "tool_call", subtype: "completed", call_id: "c1", tool_call: { readToolCall: { args: { path: "src/engine/cc14.ts" }, result: { success: { content: "export const x = 1" } } } } }));
  expect(c.events).toEqual([{ kind: "tool_result", t: ctx.now(), ticket: "T-7", tool: "Read", ok: true, summary: "export const x = 1" }]);

  const sh = t.line(j({ type: "tool_call", subtype: "completed", call_id: "c2", tool_call: { shellToolCall: { args: { command: "npm test" }, result: { error: "exit 1: 2 failing" } } } }));
  expect(sh.events[0]).toMatchObject({ kind: "tool_result", tool: "Bash", ok: false, summary: "error: exit 1: 2 failing" });

  const r = t.line(j({ type: "result", subtype: "success", is_error: false, duration_ms: 4200, result: "VERDICT: ok\nlooks right", session_id: "s1" }));
  expect(r.result).toEqual({ ok: true, stopReason: "success", costUsd: 0, turns: 0, text: "VERDICT: ok\nlooks right", rateLimited: false });
  expect(t.end()).toBeUndefined();
});

test("cursor: a result without text falls back to the last assistant message; a stream without a result ends as no_result", () => {
  const t = createCursorTranslator(ctx);
  t.line(j({ type: "assistant", message: { content: [{ type: "text", text: "VERDICT: fixable" }] } }));
  expect(t.line(j({ type: "result", subtype: "success", is_error: false })).result).toMatchObject({ ok: true, text: "VERDICT: fixable" });

  // Live shape: the result text is all assistant messages concatenated; the last one is the answer.
  const t3 = createCursorTranslator(ctx);
  t3.line(j({ type: "assistant", message: { content: [{ type: "text", text: "Reading the diff." }] } }));
  t3.line(j({ type: "assistant", message: { content: [{ type: "text", text: "VERDICT: ok" }] } }));
  expect(t3.line(j({ type: "result", subtype: "success", is_error: false, result: "Reading the diff.VERDICT: ok" })).result).toMatchObject({ ok: true, text: "VERDICT: ok" });

  const t2 = createCursorTranslator(ctx);
  t2.line(j({ type: "assistant", message: { content: [{ type: "text", text: "half way" }] } }));
  expect(t2.end()).toMatchObject({ ok: false, stopReason: "no_result", text: "half way" });
});

test("cursor: an error result with usage-limit text is a rate limit", () => {
  const t = createCursorTranslator(ctx);
  const r = t.line(j({ type: "result", subtype: "error", is_error: true, result: "You have reached your usage limit; enable on-demand usage or wait." }));
  expect(r.result).toMatchObject({ ok: false, rateLimited: true });
});

test("cursor: tool names map to the Claude-style names the UI already knows", () => {
  expect(cursorToolName("shellToolCall")).toBe("Bash");
  expect(cursorToolName("writeToolCall")).toBe("Write");
  expect(cursorToolName("grepToolCall")).toBe("Grep");
  expect(cursorToolName("semanticSearchToolCall")).toBe("SemanticSearch");
});

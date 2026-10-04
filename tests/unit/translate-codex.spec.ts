import { test, expect } from "@playwright/test";
import { createCodexTranslator } from "../../src/worker/translate-codex.js";

const ctx = { ticket: "T-7", role: "implementer" as const, now: () => "2026-10-03T10:00:00.000Z", model: "gpt-5.1-codex" };
const j = (o: unknown) => JSON.stringify(o);

test("codex: thread start, a command with its result, a message, and a completed turn", () => {
  const t = createCodexTranslator(ctx);
  expect(t.line(j({ type: "thread.started", thread_id: "th_1" })).events).toEqual([{ kind: "status", t: ctx.now(), ticket: "T-7", text: "worker started · codex · model gpt-5.1-codex" }]);
  expect(t.line(j({ type: "turn.started" })).events).toEqual([]);

  const started = t.line(j({ type: "item.started", item: { id: "i1", type: "command_execution", command: "npm test -- cc14", status: "in_progress" } }));
  expect(started.assistantTurn).toBe(false);
  expect(started.events).toEqual([{ kind: "tool_use", t: ctx.now(), ticket: "T-7", tool: "Bash", summary: "npm test -- cc14" }]);

  const completed = t.line(j({ type: "item.completed", item: { id: "i1", type: "command_execution", command: "npm test -- cc14", aggregated_output: "12 passing\n", exit_code: 0, status: "completed" } }));
  expect(completed.assistantTurn).toBe(true);
  expect(completed.events).toEqual([{ kind: "tool_result", t: ctx.now(), ticket: "T-7", tool: "Bash", ok: true, summary: "12 passing" }]);

  // A tool that never announced a start still shows up once, as use plus result.
  const mcp = t.line(j({ type: "item.completed", item: { id: "i2", type: "mcp_tool_call", server: "board", tool: "board_add_note", arguments: { id: "T-7", text: "found it" }, result: { content: [{ type: "text", text: "ok" }] }, status: "completed" } }));
  expect(mcp.events.map((e) => e.kind)).toEqual(["tool_use", "tool_result"]);
  expect(mcp.events[0]).toMatchObject({ tool: "board_board_add_note", summary: "T-7" });
  expect(mcp.events[1]).toMatchObject({ ok: true });

  const edit = t.line(j({ type: "item.completed", item: { id: "i3", type: "file_change", changes: [{ path: "src/engine/cc14.ts", kind: "update" }], status: "completed" } }));
  expect(edit.events).toEqual([{ kind: "tool_use", t: ctx.now(), ticket: "T-7", tool: "Edit", summary: "update src/engine/cc14.ts" }]);

  expect(t.line(j({ type: "item.completed", item: { id: "i4", type: "reasoning", text: "thinking" } })).events).toEqual([]);

  const msg = t.line(j({ type: "item.completed", item: { id: "i5", type: "agent_message", text: "Done. Report filed." } }));
  expect(msg.assistantTurn).toBe(true);
  expect(msg.events).toEqual([{ kind: "text", t: ctx.now(), ticket: "T-7", role: "implementer", text: "Done. Report filed." }]);

  const end = t.line(j({ type: "turn.completed", usage: { input_tokens: 1200, cached_input_tokens: 800, cache_write_input_tokens: 0, output_tokens: 150, reasoning_output_tokens: 0 } }));
  expect(end.events[0]).toEqual({ kind: "cost", t: ctx.now(), ticket: "T-7", cost: { inputTokens: 1200, outputTokens: 150 } });
  expect(end.events[1]).toMatchObject({ kind: "status" });
  expect(end.result).toEqual({ ok: true, stopReason: "success", costUsd: 0, turns: 4, text: "Done. Report filed.", rateLimited: false });
  expect(t.end()).toBeUndefined();
});

test("codex: a failed command is a failed tool result", () => {
  const t = createCodexTranslator(ctx);
  const out = t.line(j({ type: "item.completed", item: { id: "c", type: "command_execution", command: "npm test", aggregated_output: "2 failing", exit_code: 1, status: "failed" } }));
  expect(out.events[1]).toMatchObject({ kind: "tool_result", ok: false, summary: "exit 1: 2 failing" });
});

test("codex: a usage-limit failure is a rate limit, not the ticket's fault", () => {
  const t = createCodexTranslator(ctx);
  const out = t.line(j({ type: "turn.failed", error: { message: "You've hit your usage limit. Upgrade to Pro or try again in 3 hours 12 minutes." } }));
  expect(out.events[0]).toMatchObject({ kind: "error" });
  expect(out.result).toMatchObject({ ok: false, stopReason: "rate_limited", rateLimited: true, costUsd: 0 });
});

test("codex: another failure is just a failure", () => {
  const t = createCodexTranslator(ctx);
  const out = t.line(j({ type: "turn.failed", error: { message: "stream disconnected before completion" } }));
  expect(out.result).toMatchObject({ ok: false, stopReason: "turn_failed", rateLimited: false });
});

test("codex: a top-level error with no terminal line is classified at the end of the stream", () => {
  const t = createCodexTranslator(ctx);
  expect(t.line(j({ type: "error", message: "Rate limit reached for requests" })).result).toBeUndefined();
  expect(t.end()).toMatchObject({ ok: false, stopReason: "rate_limited", rateLimited: true });
  // An error item during an otherwise successful turn does not fail it.
  const t2 = createCodexTranslator(ctx);
  t2.line(j({ type: "item.completed", item: { id: "e", type: "error", message: "reconnecting…" } }));
  t2.line(j({ type: "item.completed", item: { id: "m", type: "agent_message", text: "ok" } }));
  expect(t2.line(j({ type: "turn.completed", usage: {} })).result).toMatchObject({ ok: true, text: "ok" });
});

test("codex: garbage and unknown lines are dropped", () => {
  const t = createCodexTranslator(ctx);
  expect(t.line("not json").events).toEqual([]);
  expect(t.line("").events).toEqual([]);
  expect(t.line(j({ type: "something.new", payload: 1 })).events).toEqual([]);
  expect(t.end()).toBeUndefined();
});

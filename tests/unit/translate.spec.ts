import { test, expect } from "@playwright/test";
import { translateLine } from "../../src/worker/translate.js";

const ctx = { ticket: "T-7", role: "implementer" as const, now: () => "2026-10-03T10:00:00.000Z" };

test("init line becomes a status with model and mcp servers", () => {
  const out = translateLine(
    JSON.stringify({ type: "system", subtype: "init", model: "claude-fable-5-1", mcp_servers: [{ name: "board", status: "connected" }] }),
    ctx,
  );
  expect(out.assistantTurn).toBe(false);
  expect(out.events).toEqual([{ kind: "status", t: ctx.now(), ticket: "T-7", text: "worker started · model claude-fable-5-1 · mcp board:connected" }]);
});

test("assistant line yields text, tool_use summaries and a cost event, and counts as a turn", () => {
  const out = translateLine(
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Reading the engine first." },
          { type: "tool_use", name: "Bash", input: { command: "npm test -- cc14" } },
          { type: "tool_use", name: "Edit", input: { file_path: "src/engine/cc14.ts" } },
          { type: "tool_use", name: "mcp__board__board_add_note", input: { id: "T-7", text: "found it" } },
        ],
        usage: { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 9 },
      },
    }),
    ctx,
  );
  expect(out.assistantTurn).toBe(true);
  expect(out.events.map((e) => e.kind)).toEqual(["text", "tool_use", "tool_use", "tool_use", "cost"]);
  expect(out.events[1]).toMatchObject({ tool: "Bash", summary: "npm test -- cc14" });
  expect(out.events[2]).toMatchObject({ tool: "Edit", summary: "src/engine/cc14.ts" });
  expect(out.events[3]).toMatchObject({ tool: "mcp__board__board_add_note", summary: "T-7" });
  expect(out.events[4]).toMatchObject({ kind: "cost", cost: { inputTokens: 152, outputTokens: 9 } });
});

test("user line with tool results yields tool_result events, errors flagged", () => {
  const out = translateLine(
    JSON.stringify({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "18 passing" }] },
          { type: "tool_result", tool_use_id: "toolu_2", is_error: true, content: "ENOENT" },
        ],
      },
    }),
    ctx,
  );
  expect(out.events).toEqual([
    { kind: "tool_result", t: ctx.now(), ticket: "T-7", tool: "toolu_1", ok: true, summary: "18 passing" },
    { kind: "tool_result", t: ctx.now(), ticket: "T-7", tool: "toolu_2", ok: false, summary: "error: ENOENT" },
  ]);
});

test("result line reports success, cost and turns", () => {
  const out = translateLine(
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Done.", total_cost_usd: 0.42, num_turns: 12 }),
    ctx,
  );
  expect(out.result).toEqual({ ok: true, stopReason: "success", costUsd: 0.42, turns: 12, text: "Done.", rateLimited: false });
  expect(out.events[0]).toMatchObject({ kind: "status", text: "worker finished · success · $0.42" });
});

test("result line detects rate limits and errors", () => {
  const out = translateLine(
    JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["API Error: 429 rate limit exceeded, resets at 16:00"], total_cost_usd: 0.01 }),
    ctx,
  );
  expect(out.result?.ok).toBe(false);
  expect(out.result?.rateLimited).toBe(true);
  expect(translateLine(JSON.stringify({ type: "result", subtype: "error_max_budget_usd", is_error: true }), ctx).result?.rateLimited).toBe(false);
});

test("garbage and unknown types are dropped", () => {
  expect(translateLine("not json", ctx).events).toEqual([]);
  expect(translateLine("", ctx).events).toEqual([]);
  expect(translateLine(JSON.stringify({ type: "stream_event", event: {} }), ctx).events).toEqual([]);
});

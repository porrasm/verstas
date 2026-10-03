/**
 * Translates `claude -p --output-format stream-json` lines into Verstas
 * events. Pure. The shapes handled are the ones the CLI emits today
 * (system/init, assistant, user with tool results, result); anything
 * unknown is dropped, so a CLI update cannot break the loop, only thin the
 * log. Dependency-free: ships inside the image.
 */
import type { VerstasEvent } from "../core/types.js";

export type StreamContext = { ticket?: string; role?: "implementer" | "reviewer" | "planner"; now?: () => string; maxLen?: number };

export type Translated = {
  events: VerstasEvent[];
  /** Set on the final `result` line. */
  result?: { ok: boolean; stopReason: string; costUsd: number; turns: number; text: string; rateLimited: boolean };
  /** True when the line was an assistant message (counts as a turn). */
  assistantTurn: boolean;
};

let CLIP = 200;
const clip = (s: string, n = CLIP): string => (s.length > n ? s.slice(0, n - 1) + "…" : s);

const summarizeToolUse = (name: string, input: unknown): string => {
  const i = (input ?? {}) as Record<string, unknown>;
  switch (name) {
    case "Bash":
      return clip(String(i.command ?? i.description ?? ""));
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return clip(String(i.file_path ?? i.notebook_path ?? ""));
    case "Glob":
    case "Grep":
      return clip(String(i.pattern ?? ""));
    default: {
      const first = Object.values(i).find((v) => typeof v === "string") as string | undefined;
      return clip(first ?? JSON.stringify(i));
    }
  }
};

const summarizeToolResult = (content: unknown): { ok: boolean; summary: string } => {
  if (typeof content === "string") return { ok: true, summary: clip(content) };
  if (Array.isArray(content)) {
    const text = content.map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : "")).join(" ");
    return { ok: true, summary: clip(text.trim()) };
  }
  return { ok: true, summary: "" };
};

export const translateLine = (line: string, ctx: StreamContext = {}): Translated => {
  const t = (ctx.now ?? (() => new Date().toISOString()))();
  CLIP = ctx.maxLen ?? 200;
  const base = { t, ticket: ctx.ticket };
  const empty: Translated = { events: [], assistantTurn: false };
  if (!line.trim()) return empty;
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return empty;
  }
  const type = msg.type;

  if (type === "system" && msg.subtype === "init") {
    const servers = Array.isArray(msg.mcp_servers) ? (msg.mcp_servers as { name?: string; status?: string }[]) : [];
    const mcp = servers.map((s) => `${s.name ?? "?"}:${s.status ?? "?"}`).join(", ");
    return { events: [{ kind: "status", ...base, text: `worker started · model ${String(msg.model ?? "?")}${mcp ? ` · mcp ${mcp}` : ""}` }], assistantTurn: false };
  }

  if (type === "assistant") {
    const message = (msg.message ?? {}) as { content?: unknown; usage?: Record<string, number> };
    const events: VerstasEvent[] = [];
    for (const block of Array.isArray(message.content) ? (message.content as Record<string, unknown>[]) : []) {
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        events.push({ kind: "text", ...base, role: ctx.role, text: clip(block.text, 2000) });
      } else if (block.type === "tool_use") {
        const name = String(block.name ?? "tool");
        events.push({ kind: "tool_use", ...base, tool: name, summary: summarizeToolUse(name, block.input) });
      }
    }
    const u = message.usage;
    if (u) {
      events.push({
        kind: "cost",
        ...base,
        cost: {
          inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
          outputTokens: u.output_tokens ?? 0,
        },
      });
    }
    return { events, assistantTurn: true };
  }

  if (type === "user") {
    const message = (msg.message ?? {}) as { content?: unknown };
    const events: VerstasEvent[] = [];
    for (const block of Array.isArray(message.content) ? (message.content as Record<string, unknown>[]) : []) {
      if (block.type === "tool_result") {
        const { summary } = summarizeToolResult(block.content);
        const ok = block.is_error !== true;
        events.push({ kind: "tool_result", ...base, tool: String(block.tool_use_id ?? "tool"), ok, summary: ok ? summary : clip(`error: ${summary}`) });
      }
    }
    return { events, assistantTurn: false };
  }

  if (type === "result") {
    const subtype = String(msg.subtype ?? "");
    const ok = subtype === "success" && msg.is_error !== true;
    const text = typeof msg.result === "string" ? msg.result : "";
    const errors = Array.isArray(msg.errors) ? (msg.errors as unknown[]).map(String).join("; ") : "";
    const rateLimited = /rate.?limit|429|usage limit|overloaded/i.test(`${subtype} ${text} ${errors}`);
    const costUsd = typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : 0;
    const turns = typeof msg.num_turns === "number" ? msg.num_turns : 0;
    return {
      events: [{ kind: "status", ...base, text: `worker finished · ${subtype}${errors ? ` · ${clip(errors)}` : ""} · $${costUsd.toFixed(2)}` }],
      result: { ok, stopReason: subtype, costUsd, turns, text, rateLimited },
      assistantTurn: false,
    };
  }

  return empty;
};

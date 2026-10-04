/**
 * Translates `codex exec --json` lines into Verstas events. The shapes
 * handled are the ones the CLI emits today: thread.started, turn.started,
 * item.started/updated/completed with typed items, turn.completed with
 * usage, turn.failed and a top-level error. Anything unknown is dropped.
 *
 * Unlike the Claude stream, Codex puts the final message in an item before
 * the terminal line and reports tokens but no price, so this translator
 * keeps a little state per job and reports a cost of zero USD.
 */
import type { VerstasEvent } from "../core/types.js";
import type { Translated, StreamContext } from "./translate.js";
import type { Translator } from "./driver.js";

const RATE_LIMIT = /usage limit|rate.?limit|\b429\b|quota|too many requests|try again (?:in|at|later)|upgrade to (?:plus|pro)/i;

const clipTo = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + "…" : s);

const firstString = (v: unknown): string => {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const hit = Object.values(v as Record<string, unknown>).find((x) => typeof x === "string") as string | undefined;
    return hit ?? JSON.stringify(v);
  }
  return v === undefined ? "" : String(v);
};

export const createCodexTranslator = (ctx: StreamContext = {}): Translator => {
  const now = ctx.now ?? (() => new Date().toISOString());
  const clip = (s: string) => clipTo(s, ctx.maxLen ?? 200);
  const started = new Set<string>();
  let lastMessage = "";
  let lastError = "";
  let turns = 0;
  let failed = false;
  let finished = false;

  const base = () => ({ t: now(), ticket: ctx.ticket });

  const toolName = (item: Record<string, unknown>): string => {
    switch (item.type) {
      case "command_execution":
        return "Bash";
      case "file_change":
        return "Edit";
      case "mcp_tool_call":
        return `${String(item.server ?? "mcp")}_${String(item.tool ?? "tool")}`;
      case "web_search":
        return "WebSearch";
      default:
        return String(item.type ?? "tool");
    }
  };
  const toolSummary = (item: Record<string, unknown>): string => {
    switch (item.type) {
      case "command_execution":
        return clip(String(item.command ?? ""));
      case "file_change": {
        const changes = Array.isArray(item.changes) ? (item.changes as { path?: unknown; kind?: unknown }[]) : [];
        return clip(changes.map((c) => `${String(c.kind ?? "edit")} ${String(c.path ?? "")}`.trim()).join(", "));
      }
      case "mcp_tool_call":
        return clip(firstString(item.arguments));
      case "web_search":
        return clip(String(item.query ?? ""));
      default:
        return clip(firstString(item));
    }
  };
  const isTool = (type: unknown) => type === "command_execution" || type === "file_change" || type === "mcp_tool_call" || type === "web_search";

  const line = (raw: string): Translated => {
    const empty: Translated = { events: [], assistantTurn: false };
    if (!raw.trim()) return empty;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return empty;
    }
    const type = String(msg.type ?? "");
    const events: VerstasEvent[] = [];

    if (type === "thread.started") {
      events.push({ kind: "status", ...base(), text: `worker started · codex${ctx.model ? ` · model ${ctx.model}` : ""}` });
      return { events, assistantTurn: false };
    }

    if (type === "item.started" || type === "item.updated" || type === "item.completed") {
      const item = (msg.item ?? {}) as Record<string, unknown>;
      const id = String(item.id ?? "");
      const itemType = item.type;
      if (type === "item.started" && isTool(itemType) && itemType !== "file_change") {
        started.add(id);
        events.push({ kind: "tool_use", ...base(), tool: toolName(item), summary: toolSummary(item) });
        return { events, assistantTurn: false };
      }
      if (type !== "item.completed") return empty;
      if (itemType === "agent_message") {
        const text = String(item.text ?? "");
        if (text.trim()) {
          lastMessage = text;
          events.push({ kind: "text", ...base(), role: ctx.role, text: clipTo(text, 2000) });
        }
        turns++;
        return { events, assistantTurn: true };
      }
      if (isTool(itemType)) {
        if (!started.has(id)) events.push({ kind: "tool_use", ...base(), tool: toolName(item), summary: toolSummary(item) });
        started.delete(id);
        if (itemType === "command_execution") {
          const code = typeof item.exit_code === "number" ? item.exit_code : item.status === "failed" ? 1 : 0;
          const out = String(item.aggregated_output ?? "");
          events.push({ kind: "tool_result", ...base(), tool: "Bash", ok: code === 0, summary: code === 0 ? clip(out.trim()) : clip(`exit ${code}: ${out.trim()}`) });
        } else if (itemType === "mcp_tool_call") {
          const ok = item.status !== "failed" && !(item.error && typeof item.error === "object");
          const result = item.result ?? item.error;
          events.push({ kind: "tool_result", ...base(), tool: toolName(item), ok, summary: ok ? clip(firstString(result)) : clip(`error: ${firstString(result)}`) });
        }
        turns++;
        return { events, assistantTurn: true };
      }
      if (itemType === "error") {
        lastError = String(item.message ?? "");
        events.push({ kind: "error", ...base(), text: clipTo(lastError, 2000) });
        return { events, assistantTurn: false };
      }
      return empty; // reasoning, todo_list, unknown
    }

    if (type === "turn.completed") {
      const u = (msg.usage ?? {}) as Record<string, number>;
      if (Object.keys(u).length) {
        // Codex's cached_input_tokens is a subset of input_tokens (seen live: 43355 input, 38656 cached), so it is not added.
        events.push({ kind: "cost", ...base(), cost: { inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0 } });
      }
      finished = true;
      const ok = !failed;
      events.push({ kind: "status", ...base(), text: `worker finished · ${ok ? "success" : "failed"} · ${turns} steps · cost not reported by codex` });
      return { events, assistantTurn: false, result: { ok, stopReason: ok ? "success" : "turn_failed", costUsd: 0, turns, text: lastMessage, rateLimited: false } };
    }

    if (type === "turn.failed" || type === "error") {
      const err = (msg.error ?? {}) as Record<string, unknown>;
      lastError = String(err.message ?? msg.message ?? "turn failed");
      failed = true;
      events.push({ kind: "error", ...base(), text: clipTo(lastError, 2000) });
      if (type === "error") return { events, assistantTurn: false }; // a turn.completed or turn.failed may still follow
      finished = true;
      const rateLimited = RATE_LIMIT.test(lastError);
      events.push({ kind: "status", ...base(), text: `worker finished · turn_failed · ${clip(lastError)}` });
      return { events, assistantTurn: false, result: { ok: false, stopReason: rateLimited ? "rate_limited" : "turn_failed", costUsd: 0, turns, text: lastMessage, rateLimited } };
    }

    return empty;
  };

  const end = (): Translated["result"] | undefined => {
    if (finished) return undefined;
    if (!lastError && !lastMessage) return undefined;
    // The stream stopped without a terminal line: an error we saw, or an answer without a turn.completed.
    const rateLimited = RATE_LIMIT.test(lastError);
    return { ok: false, stopReason: rateLimited ? "rate_limited" : lastError ? "error" : "no_result", costUsd: 0, turns, text: lastMessage, rateLimited };
  };

  return { line, end };
};

export const CODEX_RATE_LIMIT = RATE_LIMIT;

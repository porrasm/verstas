/**
 * Translates `agent -p --output-format stream-json` (Cursor CLI) lines into
 * Verstas events. Cursor's stream is modelled on Claude Code's: system/init,
 * user, assistant and result lines have the same shape and go through the
 * Claude translator unchanged. Cursor adds `tool_call` lines (subtype
 * started/completed) with the call keyed by tool name, handled here.
 *
 * Cursor reports no price, so the cost is zero USD; token counts appear
 * when the stream carries usage, which today it does not.
 */
import type { VerstasEvent } from "../core/types.js";
import { translateLine, type StreamContext, type Translated } from "./translate.js";
import type { Translator } from "./driver.js";

const clipTo = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + "…" : s);

const firstString = (v: unknown): string => {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    for (const x of Object.values(v as Record<string, unknown>)) {
      const s = firstString(x);
      if (s) return s;
    }
  }
  return "";
};

/** `readToolCall` → `Read`, `shellToolCall` → `Bash`, `writeToolCall` → `Write`, `editToolCall` → `Edit`. */
export const cursorToolName = (key: string): string => {
  const stem = key.replace(/ToolCall$/, "");
  const map: Record<string, string> = { shell: "Bash", read: "Read", write: "Write", edit: "Edit", delete: "Delete", grep: "Grep", glob: "Glob", ls: "Ls", mcp: "mcp" };
  return map[stem] ?? (stem ? stem[0]!.toUpperCase() + stem.slice(1) : "tool");
};

export const createCursorTranslator = (ctx: StreamContext = {}): Translator => {
  const now = ctx.now ?? (() => new Date().toISOString());
  const clip = (s: string) => clipTo(s, ctx.maxLen ?? 200);
  let lastText = "";
  let finished = false;

  const line = (raw: string): Translated => {
    const empty: Translated = { events: [], assistantTurn: false };
    if (!raw.trim()) return empty;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return empty;
    }
    if (msg.type === "tool_call") {
      const call = (msg.tool_call ?? {}) as Record<string, Record<string, unknown>>;
      const key = Object.keys(call)[0];
      if (!key) return empty;
      const name = cursorToolName(key);
      const body = call[key] ?? {};
      const base = { t: now(), ticket: ctx.ticket };
      const events: VerstasEvent[] = [];
      if (msg.subtype === "started") {
        events.push({ kind: "tool_use", ...base, tool: name, summary: clip(firstString(body.args)) });
      } else if (msg.subtype === "completed") {
        const result = (body.result ?? {}) as Record<string, unknown>;
        const failed = "error" in result || "rejected" in result || body.status === "failed";
        const text = firstString(result);
        events.push({ kind: "tool_result", ...base, tool: name, ok: !failed, summary: failed ? clip(`error: ${text}`) : clip(text) });
      } else return empty;
      return { events, assistantTurn: false };
    }
    const out = translateLine(raw, ctx);
    if (msg.type === "system") {
      // The Claude translator says "model ?" when the init line names none; Cursor's init may carry it under `model` already.
      return out;
    }
    if (msg.type === "assistant") {
      for (const e of out.events) if (e.kind === "text") lastText = e.text;
    }
    if (out.result) {
      finished = true;
      // Cursor's result text is every assistant message of the run run together (seen live); the last message is the answer.
      if (!out.result.text || (lastText && out.result.text !== lastText && out.result.text.endsWith(lastText))) out.result.text = lastText;
    }
    return out;
  };

  const end = (): Translated["result"] | undefined => (finished || !lastText ? undefined : { ok: false, stopReason: "no_result", costUsd: 0, turns: 0, text: lastText, rateLimited: false });

  return { line, end };
};

import { test, expect } from "@playwright/test";
import { emptyBoard, importBoard, parseBoardPaste } from "../../src/board/board.js";
import { agentFor, boardDrivers, describeAgent, sessionDrivers, ticketSchema } from "../../src/core/types.js";

/** A ticket's own agent: the field, the import forms, and who it applies to. */

test("a ticket may name its own agent; imports carry it in JSON and markdown; the reviewer ignores it", () => {
  const r = importBoard(emptyBoard(), { tickets: [{ id: "T-1", title: "Judge the galleries", agent: { driver: "codex", model: "gpt-5.1" } }, { id: "T-2", title: "Plain" }] });
  expect(r.board.tickets[0]!.agent).toEqual({ driver: "codex", model: "gpt-5.1" });
  expect(r.board.tickets[1]!.agent).toBeUndefined();
  expect(() => ticketSchema.parse(r.board.tickets[0])).not.toThrow();
  expect(() => importBoard(emptyBoard(), { tickets: [{ title: "x", agent: { driver: "gemini" } }] })).toThrow();
  // Re-import keeps the agent unless the import names another.
  const again = importBoard(r.board, { tickets: [{ id: "T-1", title: "Judge the galleries, again" }] });
  expect(again.board.tickets[0]!.agent).toEqual({ driver: "codex", model: "gpt-5.1" });
  const session = { agents: { worker: { driver: "claude" as const, model: "opus" }, reviewer: { driver: "claude" as const } } };
  expect(agentFor(session, "implementer", r.board.tickets[0])).toEqual({ driver: "codex", model: "gpt-5.1" });
  expect(agentFor(session, "reviewer", r.board.tickets[0])).toEqual({ driver: "claude" });
  expect(agentFor(session, "implementer", r.board.tickets[1])).toEqual({ driver: "claude", model: "opus" });
  expect(boardDrivers(r.board)).toEqual(["codex"]);
  expect(sessionDrivers(session, r.board)).toEqual(["claude", "codex"]);
  expect(describeAgent({ driver: "codex", model: "gpt-5.1" })).toBe("codex · gpt-5.1");

  const md = parseBoardPaste(`## T-3 · Visual pass (S)
Repo: app · Agent: codex/gpt-5.1
Look at the renders.

## T-4 · Another
Agent: cursor
`);
  expect(md.tickets[0]!.agent).toEqual({ driver: "codex", model: "gpt-5.1" });
  expect(md.tickets[1]!.agent).toEqual({ driver: "cursor", model: undefined });
});

test("a markdown paste carries a ticket's review mode", () => {
  const p = parseBoardPaste("## T-1 · Fix the README typo (S)\nReview: none · Kind: chore\n\nOne word.\n\n## T-2 · Other\nReview: sloppy\n");
  expect(p.tickets[0]!.review).toBe("none");
  expect(p.tickets[1]!.review).toBeUndefined();
});

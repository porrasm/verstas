import { test, expect } from "@playwright/test";
import { sessionSchema, TICKET_SIZE_GUIDE } from "../../src/core/types.js";
import { systemMd, terminalMd, ticketSizeRule } from "../../src/harness/prompts.js";
import { cleanPlanning } from "../../src/web/api.js";
import { buildContext } from "../../src/context/context.js";
import { draftSchema } from "../../src/drafts/draft.js";

test("a session without a ticket size reads as before: no planning block, the planner's old wording", () => {
  const s = sessionSchema.parse({ id: "abc-1", name: "x", createdAt: "2026-10-07T00:00:00.000Z" });
  expect(s.planning).toBeUndefined();
  expect(ticketSizeRule(undefined)).toBe("");
  expect(ticketSizeRule({})).toBe("");
  const planner = systemMd("planner");
  expect(planner).toContain("small (S) or medium (M) where possible, each with a clear spec");
  expect(planner).not.toContain("Ticket size for this session");
  expect(systemMd("planner", undefined, {})).toBe(planner);
});

test("a ticket size steers the planner and the terminal agent; guidance alone keeps the old size wording", () => {
  const planner = systemMd("planner", undefined, { ticketSize: "L", guidance: "one species per ticket" });
  expect(planner).toContain("sized for this session's target (below)");
  expect(planner).not.toContain("small (S) or medium (M)");
  expect(planner).toContain(`Aim for L: ${TICKET_SIZE_GUIDE.L}.`);
  expect(planner).toContain("How the user wants the work cut: one species per ticket");
  const guidanceOnly = systemMd("planner", undefined, { guidance: "by module" });
  expect(guidanceOnly).toContain("small (S) or medium (M) where possible");
  expect(guidanceOnly).toContain("How the user wants the work cut: by module");
  expect(guidanceOnly).not.toContain("Aim for");
  // Other roles never carry it.
  expect(systemMd("implementer", undefined, { ticketSize: "L" })).not.toContain("Ticket size for this session");
  expect(terminalMd({ planning: { ticketSize: "M" } }, "claude")).toContain(`Aim for M: ${TICKET_SIZE_GUIDE.M}.`);
  expect(terminalMd({}, "codex")).not.toContain("Ticket size for this session");
});

test("an empty planning block is stored as none", () => {
  expect(cleanPlanning(null)).toBeUndefined();
  expect(cleanPlanning({ guidance: "   " })).toBeUndefined();
  expect(cleanPlanning({ ticketSize: "M", guidance: "  by module " })).toEqual({ ticketSize: "M", guidance: "by module" });
  expect(cleanPlanning({ guidance: "x" })).toEqual({ guidance: "x" });
});

test("drafts carry an optional ticket size, and the drafting context explains it", () => {
  const base = { verstasDraft: 1, id: "nuppi-3f2a", name: "n", createdAt: "x", updatedAt: "x" };
  expect(draftSchema.parse(base).planning).toBeUndefined();
  expect(draftSchema.parse({ ...base, planning: { ticketSize: "L" } }).planning).toEqual({ ticketSize: "L" });
  const ctx = buildContext({ tail: "draft", config: { workTargets: [], sessionsRoot: "/s", uiPort: 4700, agentApiPort: 4701, devboxImage: "img", linuxHost: false } as never, facts: null, scripts: [], repoNames: [] });
  expect(ctx).toContain("planning.ticketSize");
});

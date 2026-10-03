import { test, expect } from "@playwright/test";
import {
  agentAddDep,
  agentSetPriority,
  assertAgentMayCreate,
  BoardError,
  emptyBoard,
  importBoard,
  nextReady,
  nextTicketId,
  parseBoardPaste,
  parseMarkdownBoard,
  transition,
  validateDeps,
  validateRepos,
} from "../../src/board/board.js";
import { boardSchema, type Board } from "../../src/core/types.js";

const seeded = (): Board =>
  importBoard(emptyBoard("Test goal"), {
    tickets: [
      { id: "T-1", title: "Schema", size: "S", priority: 10, state: "ready" },
      { id: "T-2", title: "Engine", size: "M", priority: 20, deps: ["T-1"], state: "ready" },
      { id: "T-3", title: "UI", size: "L", priority: 5, deps: ["T-2"] },
    ],
  }).board;

test("import assigns ids, defaults and validates against the schema", () => {
  const r = importBoard(emptyBoard(), {
    goal: "G",
    tickets: [{ title: "A" }, { title: "B", id: "T-7", state: "ready" }, { title: "C" }],
  });
  expect(r.created).toEqual(["T-1", "T-7", "T-8"]);
  expect(r.board.goal).toBe("G");
  expect(() => boardSchema.parse(r.board)).not.toThrow();
  const a = r.board.tickets[0]!;
  expect(a.state).toBe("backlog");
  expect(a.kind).toBe("feature");
  expect(a.size).toBe("M");
  expect(a.priority).toBe(100);
});

test("import merges by id and only changes state when the ticket is not in flight", () => {
  let b = seeded();
  b = transition(b, "T-1", "in_progress");
  const r = importBoard(b, {
    tickets: [
      { id: "T-1", title: "Schema v2", state: "backlog", notes: ["renamed"] },
      { id: "T-3", title: "UI", state: "ready" },
    ],
  });
  expect(r.updated).toEqual(["T-1", "T-3"]);
  const t1 = r.board.tickets.find((t) => t.id === "T-1")!;
  expect(t1.title).toBe("Schema v2");
  expect(t1.state).toBe("in_progress"); // in flight: state untouched
  expect(t1.notes.at(-1)?.text).toBe("renamed");
  expect(r.board.tickets.find((t) => t.id === "T-3")!.state).toBe("ready");
});

test("import rejects unknown dependencies and cycles", () => {
  expect(() => importBoard(emptyBoard(), { tickets: [{ title: "A", deps: ["T-9"] }] })).toThrow(BoardError);
  expect(() =>
    importBoard(emptyBoard(), {
      tickets: [
        { id: "T-1", title: "A", deps: ["T-2"] },
        { id: "T-2", title: "B", deps: ["T-1"] },
      ],
    }),
  ).toThrow(/cycle/);
});

test("nextReady honours deps, priority and creation order", () => {
  const b = seeded();
  // T-3 has the lowest priority number but depends on T-2 which is not done.
  expect(nextReady(b)?.id).toBe("T-1");
  const afterOne = transition(transition(b, "T-1", "in_progress"), "T-1", "review");
  expect(nextReady(afterOne)?.id).toBeUndefined(); // T-2 waits on T-1 (review, not done)
  const done = transition(afterOne, "T-1", "done");
  expect(nextReady(done)?.id).toBe("T-2");
});

test("transition enforces the state machine and counts attempts", () => {
  let b = seeded();
  expect(() => transition(b, "T-1", "done")).toThrow(/Cannot move/);
  b = transition(b, "T-1", "in_progress");
  expect(b.tickets[0]!.attempts).toBe(1);
  b = transition(b, "T-1", "ready", { by: "harness", text: "reviewer: fixable" });
  b = transition(b, "T-1", "in_progress");
  expect(b.tickets[0]!.attempts).toBe(2);
  expect(b.tickets[0]!.notes.map((n) => n.text)).toEqual(["reviewer: fixable"]);
  expect(() => transition(b, "T-99", "ready")).toThrow(/No ticket/);
});

test("agents may file bugs, followups and chores, never features", () => {
  expect(() => assertAgentMayCreate("bug", "worker")).not.toThrow();
  expect(() => assertAgentMayCreate("feature", "worker")).toThrow(/idea/);
  expect(() => assertAgentMayCreate("feature", "planner")).not.toThrow();
  const r = importBoard(emptyBoard(), { tickets: [{ title: "Cool feature" }, { title: "Fix", kind: "bug" }] }, { by: "agent", role: "worker" });
  expect(r.created).toHaveLength(1);
  expect(r.skipped[0]?.title).toBe("Cool feature");
});

test("agent reprioritization respects pins and records a reason", () => {
  let b = seeded();
  b = agentSetPriority(b, "T-2", 1, "unblocks the UI work");
  expect(b.tickets[1]!.priority).toBe(1);
  expect(b.tickets[1]!.notes.at(-1)?.text).toContain("20 -> 1");
  const pinned = { ...b, tickets: b.tickets.map((t) => (t.id === "T-1" ? { ...t, pinned: true } : t)) };
  expect(() => agentSetPriority(pinned, "T-1", 0, "x")).toThrow(/pinned/);
  expect(() => agentAddDep(b, "T-1", "T-3", "x")).toThrow(/cycle/);
  expect(agentAddDep(b, "T-3", "T-1", "needs schema").tickets[2]!.deps).toEqual(["T-2", "T-1"]);
});

test("nextTicketId skips ids reserved in the same import", () => {
  expect(nextTicketId(emptyBoard(), ["T-4"])).toBe("T-5");
  validateDeps([]);
});

test("markdown import reads headings, key lines and checklists", () => {
  const md = `# Build the mapping engine

## T-3 · Mapping engine: CC and notes (M)
Repo: nuppi · Deps: T-1, T-2 · Priority: 20
Pure module in src/engine.
Input is a 0..1 value.
- [ ] 7-bit and 14-bit CC covered by tests
- [x] no Electron imports

### Mock MIDI port
Kind: chore | State: ready
Emit events to an injected sink.
`;
  const r = parseMarkdownBoard(md);
  expect(r.goal).toBe("Build the mapping engine");
  expect(r.tickets).toHaveLength(2);
  const a = r.tickets[0]!;
  expect(a).toMatchObject({ id: "T-3", title: "Mapping engine: CC and notes", size: "M", repo: "nuppi", deps: ["T-1", "T-2"], priority: 20 });
  expect(a.acceptance).toEqual(["7-bit and 14-bit CC covered by tests", "no Electron imports"]);
  expect(a.spec).toBe("Pure module in src/engine.\nInput is a 0..1 value.");
  expect(r.tickets[1]).toMatchObject({ title: "Mock MIDI port", kind: "chore", state: "ready", spec: "Emit events to an injected sink." });
});

test("paste detection accepts JSON objects, JSON arrays and markdown", () => {
  expect(parseBoardPaste('{"tickets":[{"title":"A"}]}').tickets[0]!.title).toBe("A");
  expect(parseBoardPaste('[{"title":"B"}]').tickets[0]!.title).toBe("B");
  expect(parseBoardPaste("## C\nspec").tickets[0]).toMatchObject({ title: "C", spec: "spec" });
});

test("validateRepos names the offending tickets and the repos the session has", () => {
  const b = seeded();
  const withRepos = { ...b, tickets: b.tickets.map((t, i) => ({ ...t, repo: i === 0 ? "app" : "capability" })) };
  expect(() => validateRepos(withRepos.tickets, ["app"])).toThrow(/T-2, T-3 name repo "capability", but the session's repositories are: app/);
  expect(() => validateRepos(withRepos.tickets, ["app", "capability"])).not.toThrow();
  expect(() => validateRepos(b.tickets, [])).not.toThrow(); // no repo field: fine
  const done = withRepos.tickets.map((t) => ({ ...t, state: "done" as const }));
  expect(() => validateRepos(done, ["app"], { ignoreDone: true })).not.toThrow();
});

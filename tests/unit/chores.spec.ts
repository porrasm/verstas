import { test, expect } from "@playwright/test";
import { addChore, beginSweep, emptyBoard, importBoard, openChores, parseBoardPaste, promoteChore, releaseSweep, setChoreState, settleSweep, sweepInFlight, sweepToJudging } from "../../src/board/board.js";
import { boardSchema, globToRegExp, matchesAnyGlob, SWEEP_PROTECTED_GLOBS } from "../../src/core/types.js";

/**
 * Chores: the pure board logic. Small fixes filed by anyone, swept by a
 * lead in batches, settled by the harness as one commit or a refusal.
 */

const withChores = () => {
  let b = emptyBoard("g");
  b = addChore(b, { text: "Rename tmp to pending", where: "src/loop.ts" }, "agent", { fromTicket: "T-3" }).board;
  b = addChore(b, { text: "Doc the exit codes" }, "user").board;
  b = addChore(b, { text: "Guard the empty list" }, "agent", { state: "proposed" }).board;
  return b;
};

test("chores get C-n ids, keep who filed them and from which ticket, and only open ones are sweepable", () => {
  const b = withChores();
  expect(b.chores.map((c) => c.id)).toEqual(["C-1", "C-2", "C-3"]);
  expect(b.chores[0]).toMatchObject({ by: "agent", fromTicket: "T-3", where: "src/loop.ts", state: "open" });
  expect(b.chores[2]!.state).toBe("proposed");
  expect(openChores(b).map((c) => c.id)).toEqual(["C-1", "C-2"]);
  expect(() => boardSchema.parse(b)).not.toThrow();
  // An old board without a chores array still parses.
  expect(boardSchema.parse({ verstas: 1, goal: "", tickets: [] }).chores).toEqual([]);
});

test("your moves: approve a proposed chore, drop an open one, promote one to a backlog followup", () => {
  let b = withChores();
  b = setChoreState(b, "C-3", "open");
  expect(openChores(b)).toHaveLength(3);
  expect(() => setChoreState(b, "C-3", "open")).toThrow(/Cannot move C-3 from open to open/);
  b = setChoreState(b, "C-2", "dropped", "not worth it");
  expect(b.chores[1]).toMatchObject({ state: "dropped", outcome: "not worth it" });
  const p = promoteChore(b, "C-1", "user", { note: "touches three modules" });
  expect(p.ticketId).toBe("T-1");
  const t = p.board.tickets[0]!;
  expect(t).toMatchObject({ kind: "followup", state: "backlog", title: "Rename tmp to pending" });
  expect(t.spec).toContain("Where: src/loop.ts");
  expect(t.spec).toContain("touches three modules");
  expect(t.notes[0]!.text).toContain("From chore C-1 (found while on T-3)");
  expect(p.board.chores[0]).toMatchObject({ state: "promoted", promotedTo: "T-1" });
  expect(() => promoteChore(p.board, "C-1", "user")).toThrow(/only an open chore/);
});

test("a sweep takes a batch, one at a time; settling applies each result and releases the rest", () => {
  let b = withChores();
  b = addChore(b, { text: "Fourth" }, "user").board;
  const sw = beginSweep(b, { max: 2 });
  expect(sw.sweep).toMatchObject({ n: 1, ids: ["C-1", "C-2"], state: "working" });
  expect(sw.chores.map((c) => c.text)).toEqual(["Rename tmp to pending", "Doc the exit codes"]);
  b = sw.board;
  expect(b.chores.filter((c) => c.state === "sweeping").map((c) => c.id)).toEqual(["C-1", "C-2"]);
  expect(() => beginSweep(b)).toThrow(/Sweep 1 is working/);
  expect(() => beginSweep(withChores(), { ids: ["C-3"] })).toThrow(/C-3 is proposed, not open/);
  expect(() => beginSweep(emptyBoard())).toThrow(/No open chores/);
  b = sweepToJudging(b);
  expect(sweepInFlight(b)?.state).toBe("judging");
  const out = settleSweep(b, [{ id: "C-1", outcome: "done", note: "renamed" }, { id: "C-9", outcome: "done" }], { accepted: true, note: "Chores (sweep 1): 1 done", diff: { added: 3, removed: 1, files: 1 } });
  expect(out.done).toEqual(["C-1"]);
  expect(out.board.chores.find((c) => c.id === "C-1")).toMatchObject({ state: "done", outcome: "renamed", sweep: 1 });
  // Said nothing about C-2: back to open, not lost.
  expect(out.board.chores.find((c) => c.id === "C-2")!.state).toBe("open");
  expect(out.board.sweep).toMatchObject({ n: 1, state: "accepted", diff: { added: 3, removed: 1, files: 1 } });
  // The next sweep counts up and may take what was released.
  expect(beginSweep(out.board).sweep).toMatchObject({ n: 2, ids: ["C-2", "C-4"] });
});

test("a refused sweep puts every chore back; promoted results make backlog tickets; release is a refusal with a note", () => {
  let b = withChores();
  b = sweepToJudging(beginSweep(b).board);
  const refused = settleSweep(b, [{ id: "C-1", outcome: "done" }], { accepted: false, note: "too large" });
  expect(refused.done).toEqual([]);
  expect(refused.board.chores.map((c) => c.state)).toEqual(["open", "open", "proposed"]);
  expect(refused.board.sweep).toMatchObject({ state: "refused", note: "too large" });

  b = sweepToJudging(beginSweep(withChores()).board);
  const ok = settleSweep(b, [{ id: "C-1", outcome: "promoted", note: "needs a design change" }, { id: "C-2", outcome: "dropped", note: "already documented" }], { accepted: true, note: "done" });
  expect(ok.promoted).toEqual([{ chore: "C-1", ticket: "T-1" }]);
  expect(ok.board.tickets[0]).toMatchObject({ id: "T-1", kind: "followup", state: "backlog" });
  expect(ok.board.chores.find((c) => c.id === "C-2")).toMatchObject({ state: "dropped", outcome: "already documented", sweep: 1 });

  const released = releaseSweep(beginSweep(withChores()).board, "host restarted");
  expect(released.chores.filter((c) => c.state === "sweeping")).toHaveLength(0);
  expect(released.sweep).toMatchObject({ state: "refused", note: "host restarted" });
  expect(releaseSweep(released, "again")).toBe(released);
});

test("imports carry chores: JSON and a markdown '## Chores' list; known ids update while open", () => {
  const r = importBoard(emptyBoard(), { chores: [{ text: "Fix the typo", where: "README.md" }, { id: "C-7", text: "Seven" }] });
  expect(r.created).toEqual([]);
  expect(r.chores).toEqual(["C-1", "C-7"]);
  expect(r.board.chores.map((c) => [c.id, c.state, c.by])).toEqual([["C-1", "open", "user"], ["C-7", "open", "user"]]);
  const again = importBoard(r.board, { chores: [{ id: "C-7", text: "Seven, reworded" }] });
  expect(again.chores).toEqual([]);
  expect(again.board.chores[1]!.text).toBe("Seven, reworded");
  // An agent's import keeps proposed chores proposed and does not revive settled ones.
  const settled = setChoreState(r.board, "C-1", "dropped");
  expect(importBoard(settled, { chores: [{ id: "C-1", text: "Revived?" }] }, { by: "agent" }).board.chores[0]!.text).toBe("Fix the typo");
  expect(() => importBoard(emptyBoard(), { tickets: [] })).toThrow(/Nothing to import/);

  const md = parseBoardPaste(`# Goal

## T-1 · Engine (S)
Spec here.
- [ ] tested

## Chores
- Rename tmp to pending — src/loop.ts
- Doc the exit codes (docs/CLI.md)
- Plain one

## Docs
Another ticket.
`);
  expect(md.tickets.map((t) => t.title)).toEqual(["Engine", "Docs"]);
  expect(md.chores).toEqual([{ text: "Rename tmp to pending", where: "src/loop.ts" }, { text: "Doc the exit codes", where: "docs/CLI.md" }, { text: "Plain one" }]);
});

test("the protected-path globs catch contract documents and fixtures, and nothing else", () => {
  for (const p of ["docs/DESIGN.md", "DESIGN.md", "tests/fixtures/a.txt", "fixtures/x/y", "a/b/c.snap", "src/__snapshots__/x.js.snap", "spec/ARCHITECTURE.md"]) expect(matchesAnyGlob(p, SWEEP_PROTECTED_GLOBS), p).toBe(true);
  for (const p of ["src/design.ts", "docs/DESIGN.md.bak", "src/fixtures.ts", "a/b/c.snapx", "README.md"]) expect(matchesAnyGlob(p, SWEEP_PROTECTED_GLOBS), p).toBe(false);
  expect(globToRegExp("src/*.ts").test("src/a.ts")).toBe(true);
  expect(globToRegExp("src/*.ts").test("src/x/a.ts")).toBe(false);
  expect(globToRegExp("a.b").test("axb")).toBe(false);
});

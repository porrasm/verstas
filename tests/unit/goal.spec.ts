import { test, expect } from "@playwright/test";
import { emptyBoard, importBoard } from "../../src/board/board.js";
import { now, reviseGoal, sessionSchema } from "../../src/core/types.js";
import { leadContinuePrompt, leadPrompt, reviewFacts, systemMd, verstasMd } from "../../src/harness/prompts.js";

/** The goal's pure parts: the goal history on the session and what the lead's prompts say about it. */

const session = (over: Record<string, unknown> = {}) => sessionSchema.parse({ id: "2026-10-09-g", name: "g", createdAt: "2026-10-01T00:00:00.000Z", goal: "A CLI that greets", ...over });

test("reviseGoal keeps the history: the old goal goes in as revised, or as met with the lead's note; the same text changes nothing; an empty old goal leaves no record", () => {
  const s = session();
  expect(reviseGoal(s, "  A CLI that greets ")).toBe(s);
  const revised = reviseGoal(s, "A CLI that greets in Finnish", "2026-10-02T00:00:00.000Z");
  expect(revised.goal).toBe("A CLI that greets in Finnish");
  expect(revised.goalSince).toBe("2026-10-02T00:00:00.000Z");
  expect(revised.goals).toEqual([{ text: "A CLI that greets", from: "2026-10-01T00:00:00.000Z", until: "2026-10-02T00:00:00.000Z", outcome: "revised", note: undefined }]);

  const met = reviseGoal({ ...revised, goalMet: { at: "2026-10-03T00:00:00.000Z", runId: 3, note: "Greets in Finnish; tests pass." } }, "Add a GUI", "2026-10-04T00:00:00.000Z");
  expect(met.goalMet).toBeUndefined();
  expect(met.goals).toHaveLength(2);
  expect(met.goals[1]).toMatchObject({ text: "A CLI that greets in Finnish", from: "2026-10-02T00:00:00.000Z", until: "2026-10-04T00:00:00.000Z", outcome: "met", note: "Greets in Finnish; tests pass." });
  expect(sessionSchema.parse(JSON.parse(JSON.stringify(met))).goals).toHaveLength(2);

  const fresh = reviseGoal(session({ goal: "" }), "First goal", now());
  expect(fresh.goals).toEqual([]);
  expect(fresh.goal).toBe("First goal");
});

test("the lead's prompts: the first lead, a next goal after a met one, a revised goal, the claim made before, no goal, and the continue prompt", () => {
  const board = importBoard(emptyBoard("g"), { tickets: [{ id: "T-1", title: "Schema", state: "ready" }, { id: "T-2", title: "Engine", state: "backlog" }] }).board;
  const first = leadPrompt(board, { goal: "A CLI that greets", round: 1, history: [{ repo: "app", log: "" }] });
  expect(first).toContain("# The session");
  expect(first).toContain("Lead life 1 of this run");
  expect(first).toContain("## Goal\nA CLI that greets");
  expect(first).toContain("you are the first lead here");
  expect(first).toContain("(no commits since the clone)");
  expect(first).toContain("T-1 [ready] Schema");
  expect(first).not.toContain("The goal was revised");

  const next = leadPrompt(board, { goal: "Add a GUI", round: 1, stateNote: "# Plan\n- CLI done", goalChange: { kind: "next", at: "2026-10-04T00:00:00.000Z", previous: "A CLI that greets", note: "Greets; tests pass." }, history: [{ repo: "app", log: "abc123 Lead 3.2: greet\n" }] });
  expect(next).toContain("The previous goal was met");
  expect(next).toContain("Greets; tests pass.");
  expect(next).toContain("abc123 Lead 3.2: greet");
  expect(next).toContain("# Plan\n- CLI done");

  const revised = leadPrompt(board, { goal: "A CLI that greets in Finnish", round: 2, stateNote: "# Plan", goalChange: { kind: "revised", at: "2026-10-02T00:00:00.000Z", previous: "A CLI that greets" }, history: [], lastWords: "(stopped at time_cap) writing tests", answers: ["R-1: Which language? Answer: Finnish"] });
  expect(revised).toContain("The goal was revised at 2026-10-02T00:00");
  expect(revised).toContain("stopped at a cap before it updated the note");
  expect(revised).toContain("writing tests");
  expect(revised).toContain("Requests the user decided");
  expect(revised).toContain("Answer: Finnish");

  const again = leadPrompt(board, { goal: "A CLI that greets", round: 1, metBefore: { at: "2026-10-03T00:00:00.000Z", note: "Done." }, history: [] });
  expect(again).toContain("said this goal was met");
  expect(again).toContain("That means not yet");

  const boardOnly = leadPrompt(board, { goal: "", round: 1, handoff: "T-1 half done", holds: [board.tickets[0]!] });
  expect(boardOnly).toContain("(No goal is written: the board is the work.)");
  expect(boardOnly).toContain("Note from the previous lead\nT-1 half done");
  expect(boardOnly).toContain("## In progress: T-1");
  expect(boardOnly).not.toContain("## Goal");

  const cont = leadContinuePrompt(board, { round: 3, committed: ["app", "docs"] });
  expect(cont).toContain("life 3 of this run");
  expect(cont).toContain("left in app, docs");
  expect(cont).toContain("T-1 [ready] Schema");
  expect(cont).not.toContain("revised");
  const contRevised = leadContinuePrompt(board, { round: 4, committed: [], goal: "New text", goalChangedAt: "2026-10-05T00:00:00.000Z", holds: [board.tickets[0]!] });
  expect(contRevised).toContain("no repository (nothing had changed)");
  expect(contRevised).toContain("The goal was revised at 2026-10-05T00:00");
  expect(contRevised).toContain("New text");
  expect(contRevised).toContain("In progress: T-1 (ready)");
});

test("the lead is told facts, not how to work: its role, the review contract, its caps; your rules file adds to it", () => {
  const sys = systemMd("lead");
  expect(sys).toContain("Role: lead");
  expect(sys).toContain("how you work is yours to decide");
  expect(sys).toContain("`done`");
  expect(sys).toContain("`handoff`");
  // No procedure: no checks to run, no definition of done, no reading order.
  for (const word of ["must", "Definition of done", "run the tests", "Read /workspace/notes/brief.md"]) expect(sys).not.toContain(word);
  expect(systemMd("lead", "Always write a test first.")).toContain("Always write a test first.");
  // The reviewer keeps its procedure and verdict contract.
  const rev = systemMd("reviewer");
  expect(rev).toContain("Two passes, both required");
  expect(rev).toContain("VERDICT: ok");
  expect(rev).toContain("Never commit");

  const box = verstasMd(session({ repos: [{ name: "app", sourcePath: "/x", branch: "main", runBranch: "verstas/g" }] }), "http://x/agent");
  expect(box).toContain("/workspace/app");
  expect(box).toContain("board_*");
  expect(box).toContain("Commits are yours");
  expect(box).toContain("carry its id");
  expect(box).toContain("A lead life has no time or turn cap");
  for (const gone of ["setup.sh", "brief.md", "env.md says", "chore", "Caps per worker", "USD"]) expect(box).not.toContain(gone);
  expect(verstasMd(session({ caps: { leadMinutes: 90 } }), "http://x/agent")).toContain("A lead life ends at 90 minutes");
  expect(reviewFacts({ caps: session().caps })).toContain("independent reviewer");
  expect(reviewFacts({ caps: { ...session().caps, reviewer: false } })).toContain("You move tickets to `done`");
});

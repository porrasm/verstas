import { test, expect } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { now, reviseGoal, sessionSchema } from "../../src/core/types.js";
import { goalContinuePrompt, goalPrompt, readGoalRules, systemMd, verifyRule, verstasMd } from "../../src/harness/prompts.js";

/** Goal mode's pure parts: the goal history on the session and the goal worker's prompts. */

const session = (over: Record<string, unknown> = {}) => sessionSchema.parse({ id: "2026-10-09-g", name: "g", createdAt: "2026-10-01T00:00:00.000Z", mode: "goal", goal: "A CLI that greets", ...over });

test("reviseGoal keeps the history: the old goal goes in as revised, or as met with the worker's note; the same text changes nothing; an empty old goal leaves no record", () => {
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

test("the goal worker's prompts: the first worker, a next goal after a met one, a revised goal, the claim made before, and the continue prompt", () => {
  const first = goalPrompt({ goal: "A CLI that greets", round: 1, history: [{ repo: "app", log: "" }] });
  expect(first).toContain("# Work toward the goal");
  expect(first).toContain("Round 1 of this run");
  expect(first).toContain("you are the first worker on this goal");
  expect(first).toContain("(no commits since the clone)");
  expect(first).not.toContain("The goal was revised");

  const next = goalPrompt({ goal: "Add a GUI", round: 1, stateNote: "# Plan\n- CLI done", goalChange: { kind: "next", at: "2026-10-04T00:00:00.000Z", previous: "A CLI that greets", note: "Greets; tests pass." }, history: [{ repo: "app", log: "abc123 Goal round 3.2: greet\n" }] });
  expect(next).toContain("The previous goal was met");
  expect(next).toContain("Greets; tests pass.");
  expect(next).toContain("Rewrite notes/state.md for the new goal");
  expect(next).toContain("abc123 Goal round 3.2: greet");

  const revised = goalPrompt({ goal: "A CLI that greets in Finnish", round: 2, stateNote: "# Plan", goalChange: { kind: "revised", at: "2026-10-02T00:00:00.000Z", previous: "A CLI that greets" }, history: [], lastWords: "(stopped at time_cap) writing tests", answers: ["R-1: Which language? Answer: Finnish"] });
  expect(revised).toContain("The goal was revised at 2026-10-02T00:00");
  expect(revised).toContain("Reconcile notes/state.md");
  expect(revised).toContain("stopped at a cap before it updated the note");
  expect(revised).toContain("writing tests");
  expect(revised).toContain("Requests the user decided");
  expect(revised).toContain("Answer: Finnish");

  const again = goalPrompt({ goal: "A CLI that greets", round: 1, metBefore: { at: "2026-10-03T00:00:00.000Z", note: "Done." }, history: [] });
  expect(again).toContain("said this goal was met");
  expect(again).toContain("That means not yet");

  const cont = goalContinuePrompt({ round: 3, committed: ["app", "docs"] });
  expect(cont).toContain("round 3 of this run");
  expect(cont).toContain("left in app, docs");
  expect(cont).not.toContain("revised");
  const contRevised = goalContinuePrompt({ round: 4, committed: [], goal: "New text", goalChangedAt: "2026-10-05T00:00:00.000Z" });
  expect(contRevised).toContain("no repository (nothing had changed)");
  expect(contRevised).toContain("The goal was revised at 2026-10-05T00:00");
  expect(contRevised).toContain("New text");
});

test("the goal worker's rules: no board tools, goal_done and handoff; replaceable by a file; VERSTAS.md says there is no board and that every round is committed", async () => {
  const sys = systemMd("goal");
  expect(sys).toContain("Role: goal worker");
  expect(sys).toContain("goal_done");
  expect(sys).toContain("handoff");
  expect(sys).toContain("notes/state.md");
  expect(sys).not.toContain("board_create_ticket");
  expect(sys).not.toContain("`chore`");
  expect(systemMd("implementer")).toContain("board_create_ticket");
  expect(systemMd("lead")).toContain("Claim a ticket with");

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "verstas-goal-rules-"));
  try {
    const file = path.join(dir, "goal.md");
    expect(await readGoalRules(file)).toBeUndefined();
    await fs.writeFile(file, "Ship a demo every round.");
    const rules = await readGoalRules(file);
    const replaced = systemMd("goal", rules);
    expect(replaced).toContain("Ship a demo every round.");
    expect(replaced).not.toContain("Plan in writing");
    expect(replaced).toContain("Read /workspace/VERSTAS.md first");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }

  const goalBox = verstasMd(session({ repos: [{ name: "app", sourcePath: "/x", branch: "main", runBranch: "verstas/g" }] }), "http://x/agent");
  expect(goalBox).toContain("This session has no board");
  expect(goalBox).toContain("after every round of yours");
  expect(goalBox).toContain("nobody checks your work but you");
  expect(goalBox).not.toContain("board_*");
  const boardBox = verstasMd(session({ mode: "lead" }), "http://x/agent");
  expect(boardBox).toContain("board_*");
  expect(boardBox).toContain("one per ticket");
  expect(verifyRule({ repos: [], caps: session().caps, mode: "loop" })).toContain("independent reviewer");
});

import { test, expect } from "@playwright/test";
import { emptyBoard, importBoard, transition } from "../../src/board/board.js";
import { sessionApi } from "./helpers/session-api.js";

/** Importing onto a used board: the paste's tickets are added, never written over the board's own. */

const used = () => {
  let b = importBoard(emptyBoard("old goal"), {
    tickets: [
      { id: "T-1", title: "Schema", state: "ready" },
      { id: "T-2", title: "Engine", deps: ["T-1"], state: "ready" },
    ],
  }).board;
  b = transition(transition(b, "T-1", "in_progress"), "T-1", "done");
  return b;
};

test("add mode renumbers a paste whose ids are taken and remaps its dependencies", () => {
  const r = importBoard(
    used(),
    {
      tickets: [
        { id: "T-1", title: "New schema" },
        { id: "T-2", title: "New engine", deps: ["T-1"] },
        { title: "No id", deps: ["T-2"] },
      ],
    },
    { by: "user", defaultState: "ready", mode: "add" },
  );
  expect(r.created).toEqual(["T-3", "T-4", "T-5"]);
  expect(r.updated).toEqual([]);
  expect(r.matching).toEqual(["T-1", "T-2"]);
  expect(r.renumbered).toEqual([{ from: "T-1", to: "T-3" }, { from: "T-2", to: "T-4" }]);
  const byId = Object.fromEntries(r.board.tickets.map((t) => [t.id, t]));
  // The board's own tickets are untouched.
  expect(byId["T-1"]).toMatchObject({ title: "Schema", state: "done" });
  expect(byId["T-2"]).toMatchObject({ title: "Engine", deps: ["T-1"] });
  expect(byId["T-4"]).toMatchObject({ title: "New engine", deps: ["T-3"], state: "ready" });
  expect(byId["T-5"]).toMatchObject({ title: "No id", deps: ["T-4"] });
});

test("add mode keeps free ids, lets a dependency name a ticket already on the board, and never updates", () => {
  const r = importBoard(used(), { tickets: [{ title: "First" }, { id: "T-7", title: "Kept", deps: ["T-2"] }, { title: "Last" }] }, { by: "user", mode: "add" });
  // A ticket without an id goes past every id the paste keeps, so it cannot land on one.
  expect(r.created).toEqual(["T-8", "T-7", "T-9"]);
  expect(r.renumbered).toEqual([]);
  expect(r.board.tickets.find((t) => t.id === "T-7")!.deps).toEqual(["T-2"]);
  // The same id twice in one paste is two tickets.
  const twice = importBoard(emptyBoard(), { tickets: [{ id: "T-1", title: "A" }, { id: "T-1", title: "B" }] }, { by: "user", mode: "add" });
  expect(twice.board.tickets.map((t) => [t.id, t.title])).toEqual([["T-1", "A"], ["T-2", "B"]]);
  expect(() => importBoard(used(), { tickets: [{ title: "x", deps: ["T-40"] }] }, { by: "user", mode: "add" })).toThrow(/unknown T-40/);
});

test("the import route adds by default, previews without saving, merges on request and sets the goal only when asked", async () => {
  const s = await sessionApi({ board: used(), session: { goal: "old goal" } });
  const text = JSON.stringify({ goal: "new goal", tickets: [{ id: "T-1", title: "New schema" }, { id: "T-2", title: "New engine", deps: ["T-1"] }] });
  try {
    const dry = await s.call("POST", "/board/import", { text, dryRun: true });
    expect(dry.body).toMatchObject({ ok: true, mode: "add", created: ["T-3", "T-4"], updated: [], matching: ["T-1", "T-2"], goal: "new goal", goalChanged: false });
    expect(dry.body.tickets.created[1]).toMatchObject({ id: "T-4", title: "New engine", deps: ["T-3"], state: "ready" });
    expect((await s.docs()).board.tickets).toHaveLength(2);

    const bad = await s.call("POST", "/board/import", { text: "{ nope", dryRun: true });
    expect(bad.body).toMatchObject({ ok: false });
    expect(bad.body.error).toMatch(/Not valid JSON/);

    const added = await s.call("POST", "/board/import", { text });
    expect(added.body).toMatchObject({ ok: true, created: ["T-3", "T-4"], goalChanged: false });
    let docs = await s.docs();
    expect(docs.board.tickets.map((t) => t.title)).toEqual(["Schema", "Engine", "New schema", "New engine"]);
    expect(docs.session.goal).toBe("old goal");
    expect(docs.board.goal).toBe("old goal");

    // Merge is the old behaviour: known ids are updated in place. With setGoal the paste's goal becomes the session's, and a running lead hears it.
    s.state.running = true;
    const merged = await s.call("POST", "/board/import", { text: JSON.stringify({ goal: "new goal", tickets: [{ id: "T-2", title: "Engine v2" }] }), mode: "merge", setGoal: true });
    expect(merged.body).toMatchObject({ ok: true, created: [], updated: ["T-2"], goalChanged: true, told: "lead" });
    docs = await s.docs();
    expect(docs.board.tickets.find((t) => t.id === "T-2")!.title).toBe("Engine v2");
    expect(docs.session.goal).toBe("new goal");
    expect(docs.session.goals.at(-1)).toMatchObject({ text: "old goal", outcome: "revised" });
    expect(s.state.messages[0]).toMatch(/goal was revised/);
  } finally {
    await s.close();
  }
});

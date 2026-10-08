import { test, expect } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  addTickets,
  DRAFT_FORMAT_VERSION,
  DraftError,
  draftBoard,
  draftSchema,
  importIntoDraft,
  makeDraftId,
  removeTickets,
  updateTicket,
  validateDraft,
  type Draft,
} from "../../src/drafts/draft.js";
import { DraftStore, type DraftChange } from "../../src/drafts/store.js";
import { emptyBoard, importBoard, validateRepos } from "../../src/board/board.js";
import { buildContext } from "../../src/context/context.js";
import { configSchema } from "../../src/config.js";

const at = "2026-10-04T10:00:00.000Z";
const blank = (over: Partial<Draft> = {}): Draft => draftSchema.parse({ verstasDraft: DRAFT_FORMAT_VERSION, id: "nuppi-mvp-ab12", name: "Nuppi MVP", createdAt: at, updatedAt: at, ...over });
const env = { workTargets: [{ name: "nuppi" }, { name: "kapula" }], recipes: ["chromium"] };

test("a new draft has the form's defaults: packs without the Claude API, no tickets", () => {
  const d = blank();
  expect(d.packs).toEqual(["node", "python", "debian", "github"]);
  expect(d.tickets).toEqual([]);
  expect(d.createdBy).toBe("agent");
  expect(() => blank({ packs: ["anthropic"] as never })).toThrow();
  expect(() => blank({ extraHosts: ["10.0.0.1"] })).toThrow();
  expect(blank({ extraHosts: ["Fonts.GoogleApis.com"] }).extraHosts).toEqual(["fonts.googleapis.com"]);
});

test("draft ids are slugs with a random suffix", () => {
  expect(makeDraftId("Nuppi MVP!", () => "ab12")).toBe("nuppi-mvp-ab12");
  expect(makeDraftId("ä", () => "ab12")).toBe("draft-a-ab12");
  expect(makeDraftId("***", () => "ab12")).toBe("draft-ab12");
});

test("addTickets keeps free ids, numbers the rest, defaults state to ready, refuses a taken id", () => {
  const one = addTickets(blank(), [{ title: "Toolchain" }, { id: "T-5", title: "Fader", deps: ["T-1"] }, { title: "Knob", deps: ["T-5"] }]);
  expect(one.ids).toEqual(["T-1", "T-5", "T-6"]);
  expect(one.draft.tickets.map((t) => t.state)).toEqual(["ready", "ready", "ready"]);
  expect(() => addTickets(one.draft, [{ id: "T-5", title: "again" }])).toThrow(DraftError);
  expect(() => addTickets(one.draft, [{ id: "T-9", title: "a" }, { id: "T-9", title: "b" }])).toThrow(/same id/);
  expect(() => addTickets(one.draft, [{ title: "" }])).toThrow();
});

test("updateTicket replaces only the given fields", () => {
  const { draft } = addTickets(blank(), [{ title: "A", spec: "old", acceptance: ["x"] }]);
  const next = updateTicket(draft, "T-1", { spec: "new" });
  expect(next.tickets[0]).toMatchObject({ title: "A", spec: "new", acceptance: ["x"] });
  expect(() => updateTicket(draft, "T-9", { spec: "x" })).toThrow(/No ticket T-9/);
});

test("removeTickets drops the tickets and the deps that pointed at them", () => {
  const { draft } = addTickets(blank(), [{ title: "A" }, { title: "B", deps: ["T-1"] }, { title: "C", deps: ["T-1", "T-2"] }]);
  const r = removeTickets(draft, ["T-1"]);
  expect(r.draft.tickets.map((t) => [t.id, t.deps])).toEqual([["T-2", []], ["T-3", ["T-2"]]]);
  expect(r.depsDropped).toEqual(["T-2 no longer depends on T-1", "T-3 no longer depends on T-1"]);
  expect(() => removeTickets(draft, ["T-7"])).toThrow(/No ticket T-7/);
});

test("importIntoDraft merges by id or replaces, and takes the goal from the paste", () => {
  const base = addTickets(blank({ goal: "old" }), [{ title: "A" }, { title: "B" }]).draft;
  const merged = importIntoDraft(base, JSON.stringify({ goal: "new goal", tickets: [{ id: "T-2", title: "B2" }, { title: "C" }] }), "merge");
  expect(merged.updated).toEqual(["T-2"]);
  expect(merged.created).toEqual(["T-3"]);
  expect(merged.draft.goal).toBe("new goal");
  expect(merged.draft.tickets.map((t) => t.title)).toEqual(["A", "B2", "C"]);
  const replaced = importIntoDraft(base, "# Goal here\n\n## T-1 · First (S)\nRepo: nuppi\nDo it.\n- [ ] works\n", "replace");
  expect(replaced.draft.tickets).toHaveLength(1);
  expect(replaced.draft.tickets[0]).toMatchObject({ id: "T-1", title: "First", size: "S", repos: ["nuppi"], acceptance: ["works"] });
  expect(() => importIntoDraft(base, "{ not json", "merge")).toThrow(DraftError);
});

test("validateDraft reports what creation would refuse as errors", () => {
  const d = addTickets(blank({ repos: [{ target: "nuppi" }, { target: "ghost" }], recipes: ["chromium", "postgres"] }), [
    { title: "A", repo: "nuppi", spec: "s", acceptance: ["a"], deps: ["T-2"] },
    { title: "B", repo: "kapula", spec: "s", acceptance: ["a"], deps: ["T-1"] },
    { title: "C", repo: "nuppi", spec: "s", acceptance: ["a"], deps: ["T-9"] },
  ]).draft;
  const p = validateDraft(d, env);
  expect(p.errors).toEqual(
    expect.arrayContaining([
      expect.stringContaining('"ghost" is not a work target'),
      'Recipe "postgres" is not in the library',
      expect.stringContaining('T-2 names repo "kapula"'),
      "T-3 depends on T-9, which is not in the draft",
      expect.stringContaining("Dependency cycle"),
    ]),
  );
  expect(validateDraft(blank(), env).errors).toEqual(["Nothing to work on: add tickets, or a goal the planner can draft tickets from"]);
  expect(validateDraft(blank({ repos: [{ target: "nuppi", name: "notes" }], goal: "g" }), env).errors[0]).toContain('"notes" is reserved');
});

test("validateDraft warns about weak tickets without blocking", () => {
  const d = addTickets(blank({ repos: [{ target: "nuppi" }, { target: "kapula" }] }), [{ title: "Big", size: "L", state: "backlog" }]).draft;
  const p = validateDraft(d, env);
  expect(p.errors).toEqual([]);
  expect(p.warnings.join("\n")).toMatch(/No acceptance criteria: T-1/);
  expect(p.warnings.join("\n")).toMatch(/No spec: T-1/);
  expect(p.warnings.join("\n")).toMatch(/Size L: T-1/);
  expect(p.warnings.join("\n")).toMatch(/No repo on T-1/);
  expect(p.warnings.join("\n")).toMatch(/Every ticket is in backlog/);
});

test("a draft without errors imports through the normal board path", () => {
  const d = addTickets(blank({ repos: [{ target: "nuppi" }], goal: "Ship it" }), [
    { title: "A", repo: "nuppi", spec: "s", acceptance: ["a"] },
    { title: "B", repo: "nuppi", spec: "s", acceptance: ["a"], deps: ["T-1"], state: "backlog" },
  ]).draft;
  expect(validateDraft(d, env).errors).toEqual([]);
  const r = importBoard(emptyBoard(), draftBoard(d), { by: "user", defaultState: "ready" });
  validateRepos(r.board.tickets, ["nuppi"]);
  expect(r.board.goal).toBe("Ship it");
  expect(r.board.tickets.map((t) => [t.id, t.state, t.deps])).toEqual([["T-1", "ready", []], ["T-2", "backlog", ["T-1"]]]);
});

test("the store creates, serialises edits, refuses edits after promotion, and emits changes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "verstas-drafts-"));
  try {
    const store = new DraftStore(dir);
    const seen: DraftChange[] = [];
    store.on("change", (c: DraftChange) => seen.push(c));
    const d = await store.create({ name: "Nuppi MVP", goal: "g", createdBy: "agent" });
    expect(d.id).toMatch(/^nuppi-mvp-[0-9a-f]{4}$/);
    expect((await fs.stat(path.join(dir, `${d.id}.json`))).mode & 0o777).toBe(0o600);

    // Twenty concurrent edits, none lost.
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.mutate(d.id, (x) => ({ draft: addTickets(x, [{ title: `t${i}` }]).draft }))));
    expect((await store.get(d.id)).tickets).toHaveLength(20);

    // A failing edit leaves the file as it was and the chain usable.
    await expect(store.mutate(d.id, () => { throw new DraftError("nope", "invalid"); })).rejects.toThrow("nope");
    await store.mutate(d.id, (x) => ({ draft: { ...x, notes: "hi" } }));
    expect((await store.get(d.id)).notes).toBe("hi");

    await store.markPromoted(d.id, "2026-10-04-nuppi-mvp");
    await expect(store.mutate(d.id, (x) => ({ draft: { ...x, notes: "late" } }))).rejects.toThrow(/already became the session 2026-10-04-nuppi-mvp/);

    expect((await store.list()).map((x) => x.id)).toEqual([d.id]);
    await fs.writeFile(path.join(dir, "broken-one.json"), "{");
    expect((await store.list()).map((x) => x.id)).toEqual([d.id]);
    await expect(store.get("../etc")).rejects.toThrow(/No draft/);

    await store.remove(d.id);
    await expect(store.get(d.id)).rejects.toThrow(/No draft/);
    expect(seen.at(-1)).toEqual({ draftId: d.id, deleted: true });
    expect(seen.length).toBeGreaterThan(20);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("the draft context explains the workflow instead of asking for a pasted board", () => {
  const md = buildContext({ tail: "draft", config: configSchema.parse({}), facts: null, scripts: [], repoNames: ["nuppi", "kapula"] });
  expect(md).toContain("## Drafts");
  expect(md).toContain("`draft_add_tickets`");
  expect(md).toContain("repo` must be one of: nuppi, kapula");
  expect(md).toContain("`playwright`");
  expect(md).toContain("You cannot create, start or change a session");
  expect(md).not.toContain("Output only the JSON");
  // The paste flow keeps its own ending.
  expect(buildContext({ tail: "board", config: configSchema.parse({}), facts: null, scripts: [], repoNames: ["nuppi"] })).toContain("Output only the JSON");
});

import { test, expect } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { deleteTemplate, getTemplate, listTemplates, saveTemplate, templatesDir } from "../../src/templates/library.js";
import { sessionApi } from "./helpers/session-api.js";

/** Goal templates: files in the library, a name on the session, and the routes between them. */

test("the library keeps one markdown file per template, lists them by name, and refuses names that are not file names", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "verstas-templates-"));
  try {
    expect(await listTemplates(home)).toEqual([]);
    await saveTemplate({ name: "Research", text: "Be thorough.\n" }, home);
    await saveTemplate({ name: "R&D prototype", text: "Rough code is fine." }, home);
    expect((await listTemplates(home)).map((t) => t.name)).toEqual(["R&D prototype", "Research"]);
    expect(await fs.readFile(path.join(templatesDir(home), "Research.md"), "utf8")).toBe("Be thorough.\n");
    expect(await getTemplate("Research", home)).toMatchObject({ name: "Research", text: "Be thorough." });
    // Saving again replaces the text; a file edited outside is read as it is.
    await saveTemplate({ name: "Research", text: "No time limit." }, home);
    await fs.writeFile(path.join(templatesDir(home), "R&D prototype.md"), "Edited in an editor.\n");
    expect((await getTemplate("Research", home))!.text).toBe("No time limit.");
    expect((await getTemplate("R&D prototype", home))!.text).toBe("Edited in an editor.");
    await expect(saveTemplate({ name: "../escape", text: "x" }, home)).rejects.toThrow();
    await expect(saveTemplate({ name: "Trailing ", text: "x" }, home)).rejects.toThrow();
    await expect(saveTemplate({ name: "Empty", text: "   " }, home)).rejects.toThrow(/empty/);
    expect(await getTemplate("../escape", home)).toBeNull();
    await deleteTemplate("Research", home);
    expect(await getTemplate("Research", home)).toBeNull();
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("the routes save and list templates with the sessions that use them, and a session picks one by name", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "verstas-templates-"));
  const before = process.env.VERSTAS_HOME;
  process.env.VERSTAS_HOME = home;
  const s = await sessionApi({ session: { initializedAt: "2026-11-08T00:00:00.000Z", goal: "old" } });
  // The helper's routes are under /sessions/:id; the library's are beside them.
  const lib = (method: string, route: string, body?: unknown) => s.call(method, `/../..${route}`, body);
  try {
    expect((await lib("PUT", "/templates/Research", { text: "Be thorough." })).body).toMatchObject({ name: "Research", text: "Be thorough." });
    expect((await lib("PUT", "/templates/Nope", { text: "" })).status).toBeGreaterThanOrEqual(400);

    // A name with nothing behind it is refused; a real one is stored on the session, and null clears it.
    expect((await s.call("PUT", "/goal-template", { template: "Missing" })).status).toBe(404);
    s.state.running = true;
    expect((await s.call("PUT", "/goal-template", { template: "Research" })).body).toEqual({ ok: true, template: "Research", running: true });
    expect((await s.docs()).session.goalTemplate).toBe("Research");
    expect((await lib("GET", "/templates")).body).toMatchObject([{ name: "Research", usedBy: [{ id: s.id, name: "test", running: true }] }]);
    s.state.running = false;

    // New work keeps the session's template unless the call names another, or none.
    await s.call("POST", "/new-work", { goal: "next" });
    expect((await s.docs()).session).toMatchObject({ goal: "next", goalTemplate: "Research" });
    expect((await s.call("POST", "/new-work", { goal: "next", template: "Missing" })).status).toBe(400);
    await s.call("POST", "/new-work", { goal: "third", template: null });
    expect((await s.docs()).session.goalTemplate).toBeUndefined();

    await s.call("PUT", "/goal-template", { template: "Research" });
    expect((await lib("DELETE", "/templates/Research")).body).toEqual({ ok: true });
    // The session keeps the name; the run works without it (tests/unit/run.spec.ts).
    expect((await s.docs()).session.goalTemplate).toBe("Research");
    expect((await lib("GET", "/templates")).body).toEqual([]);
    await s.call("PUT", "/goal-template", { template: null });
    expect((await s.docs()).session.goalTemplate).toBeUndefined();
  } finally {
    if (before === undefined) delete process.env.VERSTAS_HOME;
    else process.env.VERSTAS_HOME = before;
    await s.close();
    await fs.rm(home, { recursive: true, force: true });
  }
});

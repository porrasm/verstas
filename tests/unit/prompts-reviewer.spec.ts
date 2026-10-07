import { test, expect } from "@playwright/test";
import { systemMd, verstasMd } from "../../src/harness/prompts.js";
import { sessionSchema } from "../../src/core/types.js";

test("the reviewer is told to read the code, not only to check acceptance", () => {
  const md = systemMd("reviewer");
  expect(md).toContain("Role: reviewer");
  expect(md).toContain("read every hunk of the diff");
  expect(md).toContain("at least one concrete finding with file and line");
  expect(md).toContain("board_create_ticket");
  // Small findings are chores, not tickets: the one rule that keeps the board from filling with nits.
  expect(md).toContain("anything smaller becomes a `chore`");
  for (const v of ["VERDICT: ok", "VERDICT: fixable", "VERDICT: blocked"]) expect(md).toContain(v);
  // The implementer's rules are untouched by the reviewer wording.
  expect(systemMd("implementer")).not.toContain("read every hunk");
});

test("VERSTAS.md tells workers to bump the minor version by default, the patch version or nothing when the session says so", () => {
  const md = (versionBump?: "minor" | "patch" | "none") => verstasMd(sessionSchema.parse({ id: "2026-10-07-v", name: "v", createdAt: "2026-10-07T00:00:00.000Z", caps: versionBump ? { versionBump } : {} }), "http://x/agent");
  expect(md()).toContain("bumps the app's minor version once");
  expect(md()).toContain("Docs-only and test-only tickets and chore sweeps do not bump");
  expect(md("patch")).toContain("bumps the app's patch version once");
  expect(md("none")).not.toContain("Versioning:");
});

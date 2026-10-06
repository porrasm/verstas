import { test, expect } from "@playwright/test";
import { systemMd } from "../../src/harness/prompts.js";

test("the reviewer is told to read the code, not only to check acceptance", () => {
  const md = systemMd("reviewer");
  expect(md).toContain("Role: reviewer");
  expect(md).toContain("read every hunk of the diff");
  expect(md).toContain("at least one concrete finding with file and line");
  expect(md).toContain("board_create_ticket");
  for (const v of ["VERDICT: ok", "VERDICT: fixable", "VERDICT: blocked"]) expect(md).toContain(v);
  // The implementer's rules are untouched by the reviewer wording.
  expect(systemMd("implementer")).not.toContain("read every hunk");
});

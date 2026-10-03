import { defineConfig } from "@playwright/test";

/**
 * Unit specs are pure: no Docker, no network, no model calls. Anything that
 * needs a running Docker daemon lives under tests/docker and is run by hand
 * (`npm run test:docker`, added when the first such spec exists).
 */
export default defineConfig({
  testDir: "tests",
  timeout: 20_000,
  fullyParallel: true,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  projects: [{ name: "unit", testDir: "tests/unit" }],
});

import { test, expect } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { deleteScript, getScript, hostsFromScript, listScripts, saveScript } from "../../src/scripts/library.js";
import { buildContext } from "../../src/context/context.js";
import { configSchema } from "../../src/config.js";

test("the script library saves two files per script and lists them in name order", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "verstas-scripts-"));
  try {
    await saveScript({ name: "postgres", description: "Postgres 16 as a process", script: "#!/usr/bin/env bash\n# needs-hosts: deb.debian.org\napt-get install -y postgresql\n", hosts: ["security.debian.org"] }, home);
    await saveScript({ name: "chromium", script: "apt-get install -y chromium" }, home);
    const all = await listScripts(home);
    expect(all.map((s) => s.name)).toEqual(["chromium", "postgres"]);
    const pg = await getScript("postgres", home);
    expect(pg.hosts).toEqual(["security.debian.org"]);
    expect(pg.script.endsWith("\n")).toBe(true);
    expect(await fs.readFile(path.join(home, "scripts", "postgres.sh"), "utf8")).toContain("apt-get install -y postgresql");
    await expect(saveScript({ name: "../evil", script: "x" }, home)).rejects.toThrow();
    await deleteScript("chromium", home);
    expect((await listScripts(home)).map((s) => s.name)).toEqual(["postgres"]);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("needs-hosts header is read from the first lines", () => {
  expect(hostsFromScript("#!/usr/bin/env bash\n# needs-hosts: a.com, b.org  c.net\necho")).toEqual(["a.com", "b.org", "c.net"]);
  expect(hostsFromScript("echo nothing")).toEqual([]);
});

test("context builder: tails and facts", () => {
  const config = configSchema.parse({ workTargets: [{ name: "nuppi", path: "/x" }] });
  const facts = { image: "verstas-devbox:local", os: "Debian 12", arch: "aarch64", node: "v22.23.3", npm: "10.9.9", python: "Python 3.11.2", git: "git version 2.39", claude: "2.1.287", packages: ["git", "curl"] };
  const script = buildContext({ tail: "script", config, facts, scripts: [{ name: "postgres", description: "pg", hosts: ["deb.debian.org"], note: "", script: "x" }] });
  expect(script).toContain("Debian 12, aarch64");
  expect(script).toContain("`postgres`: pg · needs deb.debian.org");
  expect(script).toContain("# needs-hosts:");
  expect(script).toContain("Output only the script");
  const board = buildContext({ tail: "board", config, facts: null, scripts: [], repoNames: ["nuppi", "kapula"] });
  expect(board).toContain("Versions not probed");
  expect(board).toContain("`repo` must be one of: nuppi, kapula");
  expect(board).toContain('"verstas": 1');
  const free = buildContext({ tail: "free", config, facts, scripts: [] });
  expect(free).toContain("(Ask your question here.)");
});

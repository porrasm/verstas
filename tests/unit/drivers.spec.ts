import { test, expect } from "@playwright/test";
import { PassThrough } from "node:stream";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentFor, sessionDrivers, sessionSchema, type VerstasEvent } from "../../src/core/types.js";
import { codexAuthRefreshedAt, secretValues } from "../../src/config.js";
import { codexAuthAgeDays, configuredDrivers, credentialFor, DRIVERS, missingCredentials, whyDriverNeeded } from "../../src/harness/drivers.js";
import { parseCredentialLine, readWorkerStream } from "../../src/harness/run.js";
import { allowlistFor, driverPack, NETWORK_PACKS } from "../../src/network/packs.js";
import { withAgentPacks } from "../../src/sessions/sessions.js";
import { codexArgs, codexConfigToml, codexDriver } from "../../src/worker/driver-codex.js";
import { cursorArgs, cursorDriver, cursorMcpConfig } from "../../src/worker/driver-cursor.js";
import { claudeArgs, DRIVER_IMPLS, runJob, type Job } from "../../src/worker/worker.js";
import { combinedPrompt, findBinary } from "../../src/worker/driver.js";

const base = { id: "s-1", name: "s", goal: "", createdAt: "2026-10-03T00:00:00.000Z" };

test("agentFor: no agents means Claude with the legacy model for every role; a reviewer agent applies to the reviewer only", () => {
  const legacy = sessionSchema.parse({ ...base, model: "sonnet" });
  expect(agentFor(legacy, "implementer")).toEqual({ driver: "claude", model: "sonnet" });
  expect(agentFor(legacy, "reviewer")).toEqual({ driver: "claude", model: "sonnet" });
  expect(agentFor(legacy, "planner")).toEqual({ driver: "claude", model: "sonnet" });
  expect(sessionDrivers(legacy)).toEqual(["claude"]);

  const mixed = sessionSchema.parse({ ...base, agents: { worker: { driver: "codex", model: "gpt-5.1-codex" }, reviewer: { driver: "claude" } } });
  expect(agentFor(mixed, "implementer")).toEqual({ driver: "codex", model: "gpt-5.1-codex" });
  expect(agentFor(mixed, "setup").driver).toBe("codex");
  expect(agentFor(mixed, "reviewer")).toEqual({ driver: "claude", model: undefined });
  expect(sessionDrivers(mixed)).toEqual(["codex", "claude"]);
  expect(sessionDrivers({ ...mixed, caps: { ...mixed.caps, reviewer: false } })).toEqual(["codex"]);

  // A session written before `agents` existed parses with an empty block.
  expect(sessionSchema.parse({ ...base }).agents).toEqual({});
});

test("credentials: each driver reads its own secret; missing ones are named per session", () => {
  const secrets = { claudeToken: "sk-ant-oat01-" + "x".repeat(40), cursorApiKey: "key_" + "y".repeat(30) };
  expect(credentialFor(secrets, "claude")).toBe(secrets.claudeToken);
  expect(credentialFor(secrets, "codex")).toBeUndefined();
  expect(configuredDrivers(secrets)).toEqual({ claude: true, codex: false, cursor: true });
  expect(missingCredentials(secrets, { agents: { worker: { driver: "claude" } } })).toEqual([]);
  expect(missingCredentials(secrets, { agents: { worker: { driver: "claude" }, reviewer: { driver: "codex" } } })).toEqual(["codex"]);
  expect(missingCredentials(secrets, { agents: { worker: { driver: "claude" }, reviewer: { driver: "codex" } }, caps: { reviewer: false } })).toEqual([]);
  // A ticket's own agent counts while the ticket is live; a done ticket's does not.
  const board = { tickets: [{ id: "T-4", state: "ready" as const, agent: { driver: "codex" as const, model: "gpt-5.1" } }, { id: "T-5", state: "done" as const, agent: { driver: "codex" as const } }] };
  expect(missingCredentials(secrets, { agents: { worker: { driver: "claude" } } }, board)).toEqual(["codex"]);
  expect(whyDriverNeeded({ agents: { worker: { driver: "claude" } } }, board, "codex")).toContain("T-4 names it");
  expect(whyDriverNeeded({ agents: { worker: { driver: "codex" } } }, board, "codex")).toBeUndefined();
  expect(missingCredentials(secrets, { agents: { worker: { driver: "claude" } } }, { tickets: [board.tickets[1]!] })).toEqual([]);
  expect(withAgentPacks(["node"], { agents: { worker: { driver: "claude" } } }, board)).toEqual(["node", "anthropic", "openai"]);
  for (const d of Object.values(DRIVERS)) expect(d.hint).toContain("Settings");
});

test("secretValues: the Codex auth file's tokens are scanned for, not its JSON wrapper", () => {
  const auth = JSON.stringify({ OPENAI_API_KEY: null, tokens: { id_token: "id." + "a".repeat(40), access_token: "acc." + "b".repeat(40), refresh_token: "ref." + "c".repeat(30), account_id: "short" }, last_refresh: "2026-10-01T00:00:00.000Z" });
  const values = secretValues({ claudeToken: "tok_" + "z".repeat(20), codexAuth: auth, cursorApiKey: "k".repeat(20) });
  expect(values).toContain("tok_" + "z".repeat(20));
  expect(values).toContain("acc." + "b".repeat(40));
  expect(values).toContain("ref." + "c".repeat(30));
  expect(values).not.toContain("short");
  expect(values).not.toContain(auth);
  expect(codexAuthRefreshedAt(auth)?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
  expect(codexAuthAgeDays({ codexAuth: auth }, new Date("2026-10-09T00:00:00.000Z"))).toBe(8);
  expect(codexAuthAgeDays({})).toBeUndefined();
});

test("packs: each driver has a pack; choosing an agent adds its pack and hosts", () => {
  expect(driverPack("claude")).toBe("anthropic");
  expect(driverPack("codex")).toBe("openai");
  expect(driverPack("cursor")).toBe("cursor");
  expect(NETWORK_PACKS.filter((p) => "agent" in p && p.agent).map((p) => p.name)).toEqual(["anthropic", "openai", "cursor"]);
  expect(withAgentPacks(["node"], { agents: { worker: { driver: "codex" }, reviewer: { driver: "cursor" } } })).toEqual(["node", "openai", "cursor"]);
  expect(withAgentPacks(["node", "anthropic"], {})).toEqual(["node", "anthropic"]);
  expect(allowlistFor(withAgentPacks([], { agents: { worker: { driver: "codex" } } }))).toContain("chatgpt.com");
});

test("credential lines are stored, never logged; everything else flows as before", async () => {
  const stream = new PassThrough();
  const events: VerstasEvent[] = [];
  const stored: { driver: string; value: string }[] = [];
  const raw: string[] = [];
  const reading = readWorkerStream(stream, (e) => events.push(e), { onCredential: (c) => void stored.push(c), onRaw: (l) => raw.push(l) });
  stream.write(JSON.stringify({ kind: "status", t: "t", text: "hi" }) + "\n");
  stream.write(JSON.stringify({ kind: "credential", driver: "codex", value: '{"tokens":{"access_token":"new"}}' }) + "\n");
  stream.write(JSON.stringify({ kind: "credential", driver: "nope", value: "x" }) + "\n"); // unknown driver: dropped
  stream.write(JSON.stringify({ kind: "worker_done", t: "t", role: "implementer", ok: true, stopReason: "success", rateLimited: false, costUsd: 0, turns: 1, seconds: 1, text: "", stderr: "" }) + "\n");
  stream.end();
  const done = await reading;
  expect(done?.ok).toBe(true);
  expect(events.map((e) => e.kind)).toEqual(["status"]);
  expect(stored).toEqual([{ kind: "credential", driver: "codex", value: '{"tokens":{"access_token":"new"}}' }]);
  expect(raw.some((l) => l.includes("credential"))).toBe(false);
  expect(parseCredentialLine('{"kind":"credential","driver":"codex","value":""}')).toBeNull();
});

test("codex driver: config.toml declares the board server with the env it needs, args read the prompt from stdin", () => {
  const toml = codexConfigToml({ mcpServers: { board: { command: "node", args: ["/opt/verstas/mcp-server.js"] } } }, { VERSTAS_AGENT_API: "http://host.docker.internal:4701/agent", VERSTAS_RUN_TOKEN: "run-1", HTTP_PROXY: "http://proxy:3128", HOME: "/home/agent" });
  expect(toml).toContain('approval_policy = "never"');
  expect(toml).toContain('sandbox_mode = "danger-full-access"');
  expect(toml).toContain("[mcp_servers.board]\ncommand = \"node\"\nargs = [\"/opt/verstas/mcp-server.js\"]");
  expect(toml).toContain("[mcp_servers.board.env]\nVERSTAS_AGENT_API = \"http://host.docker.internal:4701/agent\"\nVERSTAS_RUN_TOKEN = \"run-1\"\nHTTP_PROXY = \"http://proxy:3128\"");
  expect(toml).not.toContain("HOME");
  const job: Job = { role: "implementer", driver: "codex", promptFile: "p", systemPromptFile: "s", caps: { minutes: 1, turns: 1, budgetUsd: 1 }, mcpConfigFile: "m", model: "gpt-5.1-codex" };
  expect(codexArgs(job)).toEqual(["exec", "--json", "--skip-git-repo-check", "-m", "gpt-5.1-codex", "-"]);
  expect(codexArgs({ ...job, model: undefined })).toEqual(["exec", "--json", "--skip-git-repo-check", "-"]);
  expect(cursorArgs({ ...job, driver: "cursor", model: "auto" }, "do it")).toEqual(["-p", "--output-format", "stream-json", "--force", "--model", "auto", "do it"]);
  expect(claudeArgs({ ...job, driver: "claude" })).toContain("--append-system-prompt");
  expect(combinedPrompt("rules\n", "task")).toBe("rules\n\n---\n\ntask");
});

test("codex driver: writes the login into a private home, hands back a rotated one, removes the home", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "verstas-drv-"));
  const mcp = path.join(dir, "mcp.json");
  await fs.writeFile(mcp, JSON.stringify({ mcpServers: { board: { command: "node", args: ["x.js"] } } }));
  const job: Job = { role: "implementer", driver: "codex", promptFile: "p", systemPromptFile: "s", caps: { minutes: 1, turns: 1, budgetUsd: 1 }, mcpConfigFile: mcp, cwd: dir };
  const before = process.env.VERSTAS_CODEX_AUTH;
  process.env.VERSTAS_CODEX_AUTH = '{"tokens":{"access_token":"old"}}';
  try {
    const sp = await codexDriver.prepare(job, "task", "rules", "/usr/bin/codex");
    const home = sp.env.CODEX_HOME!;
    expect(sp.env.VERSTAS_CODEX_AUTH).toBeUndefined();
    expect(sp.env.OPENAI_API_KEY).toBeUndefined();
    expect(sp.stdin).toBe("rules\n\n---\n\ntask");
    expect(await fs.readFile(path.join(home, "auth.json"), "utf8")).toBe('{"tokens":{"access_token":"old"}}');
    expect((await fs.stat(path.join(home, "auth.json"))).mode & 0o777).toBe(0o600);
    expect(await fs.readFile(path.join(home, "config.toml"), "utf8")).toContain("[mcp_servers.board]");
    // Codex rotated the token during the run.
    await fs.writeFile(path.join(home, "auth.json"), '{"tokens":{"access_token":"new"}}');
    expect(await codexDriver.finish!(job)).toEqual({ credential: '{"tokens":{"access_token":"new"}}' });
    expect(await fs.stat(home).catch(() => null)).toBeNull();

    // Unchanged: nothing handed back.
    const sp2 = await codexDriver.prepare(job, "task", "rules", "/usr/bin/codex");
    expect(await codexDriver.finish!(job)).toEqual({ credential: undefined });
    expect(await fs.stat(sp2.env.CODEX_HOME!).catch(() => null)).toBeNull();
  } finally {
    if (before === undefined) delete process.env.VERSTAS_CODEX_AUTH;
    else process.env.VERSTAS_CODEX_AUTH = before;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("cursor driver: the board server goes into the user-level mcp.json for the run, with its env, and the old file comes back", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "verstas-cur-"));
  const mcp = path.join(dir, "mcp.json");
  await fs.writeFile(mcp, JSON.stringify({ mcpServers: { board: { command: "node", args: ["/opt/verstas/mcp-server.js"] } } }));
  const job: Job = { role: "reviewer", driver: "cursor", promptFile: "p", systemPromptFile: "s", caps: { minutes: 1, turns: 1, budgetUsd: 1 }, mcpConfigFile: mcp, cwd: dir };
  const saved = { HOME: process.env.HOME, VERSTAS_AGENT_API: process.env.VERSTAS_AGENT_API, VERSTAS_RUN_TOKEN: process.env.VERSTAS_RUN_TOKEN };
  process.env.HOME = dir;
  process.env.VERSTAS_AGENT_API = "http://host.docker.internal:4701/agent";
  process.env.VERSTAS_RUN_TOKEN = "run-9";
  try {
    const userFile = path.join(dir, ".cursor", "mcp.json");
    await fs.mkdir(path.dirname(userFile), { recursive: true });
    await fs.writeFile(userFile, '{"mcpServers":{"mine":{"command":"x"}}}');
    const sp = await cursorDriver.prepare(job, "task", "rules", "/usr/local/bin/agent");
    expect(sp.args.slice(0, 4)).toEqual(["-p", "--output-format", "stream-json", "--force"]);
    expect(sp.args.at(-1)).toBe("rules\n\n---\n\ntask");
    const written = JSON.parse(await fs.readFile(userFile, "utf8")) as { mcpServers: Record<string, { env: Record<string, string> }> };
    expect(Object.keys(written.mcpServers)).toEqual(["board"]);
    // Proxy variables of the host running the tests may ride along; nothing else does.
    expect(written.mcpServers.board!.env).toMatchObject({ VERSTAS_AGENT_API: "http://host.docker.internal:4701/agent", VERSTAS_RUN_TOKEN: "run-9" });
    expect(Object.keys(written.mcpServers.board!.env).every((k) => /^(VERSTAS_AGENT_API|VERSTAS_RUN_TOKEN|VERSTAS_ROLE|VERSTAS_BUDGET_FILE|https?_proxy|HTTPS?_PROXY|no_proxy|NO_PROXY)$/.test(k))).toBe(true);
    await cursorDriver.finish!(job);
    expect(await fs.readFile(userFile, "utf8")).toBe('{"mcpServers":{"mine":{"command":"x"}}}');
    // No previous file: it is removed again.
    await fs.rm(userFile);
    await cursorDriver.prepare(job, "task", "rules", "/usr/local/bin/agent");
    expect(await fs.stat(userFile).catch(() => null)).not.toBeNull();
    await cursorDriver.finish!(job);
    expect(await fs.stat(userFile).catch(() => null)).toBeNull();
    expect(cursorMcpConfig({}, {})).toEqual({ mcpServers: {} });
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("worker: a driver whose CLI is not installed ends with driver_missing instead of crashing", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "verstas-wk-"));
  await fs.writeFile(path.join(dir, "p.md"), "task");
  await fs.writeFile(path.join(dir, "s.md"), "rules");
  const job: Job = { role: "reviewer", ticket: "T-1", driver: "cursor", promptFile: path.join(dir, "p.md"), systemPromptFile: path.join(dir, "s.md"), caps: { minutes: 1, turns: 1, budgetUsd: 1 }, mcpConfigFile: path.join(dir, "none.json"), cwd: dir };
  const lines: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  const origPath = process.env.PATH;
  process.env.PATH = dir; // nothing installed here
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    lines.push(String(s));
    return true;
  };
  try {
    expect(await runJob(job)).toBe(1);
  } finally {
    (process.stdout as unknown as { write: typeof orig }).write = orig;
    process.env.PATH = origPath;
    await fs.rm(dir, { recursive: true, force: true });
  }
  const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  expect(parsed[0]).toMatchObject({ kind: "error" });
  expect(parsed[1]).toMatchObject({ kind: "worker_done", ok: false, stopReason: "driver_missing", role: "reviewer", ticket: "T-1" });
  expect(String(parsed[1]!.text)).toContain("agent or cursor-agent");
  expect(await findBinary(["definitely-not-a-binary-xyz"])).toBeUndefined();
  expect(Object.keys(DRIVER_IMPLS)).toEqual(["claude", "codex", "cursor"]);
});

test("claude keeps a conversation only when the job names one: a new id, or a resume", () => {
  const base = { role: "implementer", promptFile: "/p", systemPromptFile: "/s", caps: { minutes: 1, turns: 1, budgetUsd: 1 }, mcpConfigFile: "/m" } as Job;
  const throwaway = claudeArgs(base);
  expect(throwaway).toContain("--no-session-persistence");
  expect(throwaway).not.toContain("--resume");
  const fresh = claudeArgs({ ...base, agentSession: { id: "0b6c-new", resume: false } });
  expect(fresh).not.toContain("--no-session-persistence");
  expect(fresh.slice(fresh.indexOf("--session-id"), fresh.indexOf("--session-id") + 2)).toEqual(["--session-id", "0b6c-new"]);
  const resumed = claudeArgs({ ...base, agentSession: { id: "0b6c-old", resume: true } });
  expect(resumed.slice(resumed.indexOf("--resume"), resumed.indexOf("--resume") + 2)).toEqual(["--resume", "0b6c-old"]);
  expect(resumed).not.toContain("--session-id");
});

test("worker: the budget file tracks turns and the context size, and the agent is told where it is", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "verstas-budget-"));
  await fs.writeFile(path.join(dir, "p.md"), "task");
  await fs.writeFile(path.join(dir, "s.md"), "rules");
  const budgetFile = path.join(dir, "budget.json");
  const assistant = (input: number) => JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }], usage: { input_tokens: 10, cache_read_input_tokens: input, output_tokens: 5 } } });
  const bin = path.join(dir, "fake-claude");
  await fs.writeFile(
    bin,
    // Streaming input: the prompt is the first line; the worker closes stdin after the result, which ends the `cat`.
    `#!/bin/sh\nread -r first\necho '${assistant(1000)}'\necho '${assistant(4000)}'\necho "{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\",\\"result\\":\\"$VERSTAS_BUDGET_FILE\\",\\"total_cost_usd\\":0.2,\\"num_turns\\":2}"\ncat >/dev/null\n`,
    { mode: 0o755 },
  );
  const job: Job = { role: "implementer", ticket: "T-1", promptFile: path.join(dir, "p.md"), systemPromptFile: path.join(dir, "s.md"), caps: { minutes: 5, turns: 20, budgetUsd: 1 }, mcpConfigFile: path.join(dir, "m.json"), cwd: dir, binary: bin, budgetFile };
  const lines: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    lines.push(String(s));
    return true;
  };
  try {
    const savedEnv = { role: process.env.VERSTAS_ROLE, budget: process.env.VERSTAS_BUDGET_FILE };
    expect(await runJob(job)).toBe(0);
    expect(process.env.VERSTAS_ROLE).toBe("implementer");
    if (savedEnv.role === undefined) delete process.env.VERSTAS_ROLE; else process.env.VERSTAS_ROLE = savedEnv.role;
    if (savedEnv.budget === undefined) delete process.env.VERSTAS_BUDGET_FILE; else process.env.VERSTAS_BUDGET_FILE = savedEnv.budget;
    const budget = JSON.parse(await fs.readFile(budgetFile, "utf8")) as Record<string, unknown>;
    expect(budget).toMatchObject({ turns: 2, contextTokens: 4010, outputTokens: 10, caps: { turns: 20 }, resumed: false });
  } finally {
    (process.stdout as unknown as { write: typeof orig }).write = orig;
    await fs.rm(dir, { recursive: true, force: true });
  }
  const done = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((e) => e.kind === "worker_done")!;
  expect(done).toMatchObject({ ok: true, text: budgetFile });
});

/** Runs a job with stdout captured; returns the worker's event lines. The role variables the worker sets are put back (other tests read them). */
const captureRun = async (job: Job, io?: { input?: NodeJS.ReadableStream }) => {
  const lines: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  const saved = { role: process.env.VERSTAS_ROLE, budget: process.env.VERSTAS_BUDGET_FILE };
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    lines.push(String(s));
    return true;
  };
  try {
    const code = await runJob(job, io);
    return { code, events: lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
  } finally {
    (process.stdout as unknown as { write: typeof orig }).write = orig;
    if (saved.role === undefined) delete process.env.VERSTAS_ROLE; else process.env.VERSTAS_ROLE = saved.role;
    if (saved.budget === undefined) delete process.env.VERSTAS_BUDGET_FILE; else process.env.VERSTAS_BUDGET_FILE = saved.budget;
  }
};

test("claude streams its input: the prompt is the first user message and stdin stays open", async () => {
  const job = { role: "implementer", promptFile: "/p", systemPromptFile: "/s", caps: { minutes: 1, turns: 1, budgetUsd: 1 }, mcpConfigFile: "/m" } as Job;
  const args = claudeArgs(job);
  expect(args.slice(args.indexOf("--input-format"), args.indexOf("--input-format") + 2)).toEqual(["--input-format", "stream-json"]);
  const spawned = await DRIVER_IMPLS.claude.prepare(job, "do the ticket", "rules", "/usr/bin/claude");
  expect(spawned.streaming).toBe(true);
  expect(JSON.parse(spawned.stdin!.trim())).toEqual({ type: "user", message: { role: "user", content: "do the ticket" } });
  expect(JSON.parse(DRIVER_IMPLS.claude.message!("why so slow?").trim())).toMatchObject({ type: "user", message: { content: "why so slow?" } });
  // Long commands and messages from the user are allowed for by the Bash limits the driver sets.
  expect(spawned.env.BASH_DEFAULT_TIMEOUT_MS).toBe(String(10 * 60_000));
  expect(spawned.env.BASH_MAX_TIMEOUT_MS).toBe(String(30 * 60_000));
});

test("worker: a turn that ends with a background command running keeps the session open until the agent is re-invoked; a message from the user is forwarded; every turn's text is the reply", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "verstas-stream-"));
  await fs.writeFile(path.join(dir, "p.md"), "task");
  await fs.writeFile(path.join(dir, "s.md"), "rules");
  const j = (o: unknown) => JSON.stringify(o).replace(/'/g, "'\\''");
  const assistant = (text: string) => j({ type: "assistant", message: { content: [{ type: "text", text }], usage: { input_tokens: 1, output_tokens: 1 } } });
  const result = (text: string, cost: number) => j({ type: "result", subtype: "success", result: text, total_cost_usd: cost, num_turns: 1 });
  // A fake Claude Code on streaming input: reads one line per turn from stdin and answers it. Turn 1 starts a
  // background command and ends; the command "finishes" on its own, which re-invokes the agent (turn 2) with
  // no new input; a message from the user then makes turn 3; the agent exits when stdin closes.
  const bin = path.join(dir, "fake-claude");
  await fs.writeFile(
    bin,
    `#!/bin/sh
read -r first
echo '${assistant("STARTED")}'
echo '${j({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "bg1" }] })}'
echo '${result("VERDICT: ok, started the suite", 0.1)}'
sleep 0.3
echo '${j({ type: "system", subtype: "task_notification", task_id: "bg1", status: "completed", description: "the suite" })}'
echo '${j({ type: "system", subtype: "background_tasks_changed", tasks: [] })}'
echo '${assistant("FINISHED")}'
echo '${result("the suite passed", 0.2)}'
read -r second
printf '%s' "$second" > received.txt
echo '${assistant("got it")}'
echo '${result("HELLO", 0.3)}'
cat >/dev/null
`,
    { mode: 0o755 },
  );
  const job: Job = { role: "reviewer", ticket: "T-1", promptFile: path.join(dir, "p.md"), systemPromptFile: path.join(dir, "s.md"), caps: { minutes: 5, turns: 20, budgetUsd: 1 }, mcpConfigFile: path.join(dir, "m.json"), cwd: dir, binary: bin };
  const input = new PassThrough();
  // The message arrives while the first turn's background command still runs (the only time one can land: once a
  // turn ends with nothing pending the session is closed); it is written to the agent as a user message.
  setTimeout(() => input.write(JSON.stringify({ kind: "message", text: "why so slow?" }) + "\n"), 100);
  try {
    const { code, events } = await captureRun(job, { input });
    expect(code).toBe(0);
    const texts = events.filter((e) => e.kind === "text").map((e) => String(e.text));
    expect(texts[0]).toBe("STARTED");
    expect(texts[1]).toBe("FINISHED");
    expect(texts[2]).toBe("got it");
    expect(JSON.parse(await fs.readFile(path.join(dir, "received.txt"), "utf8"))).toMatchObject({ type: "user", message: { role: "user", content: "Message from the user: why so slow?" } });
    const statuses = events.filter((e) => e.kind === "status").map((e) => String(e.text));
    expect(statuses).toContain("turn ended with 1 background command running; the agent is re-invoked when one finishes");
    expect(statuses).toContain("background command completed: the suite");
    const done = events.find((e) => e.kind === "worker_done")!;
    expect(done).toMatchObject({ ok: true, stopReason: "success", costUsd: 0.3, turns: 3 });
    expect(String(done.text)).toBe("VERDICT: ok, started the suite\n\nthe suite passed\n\nHELLO");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("worker: a turn that ends with nothing in the background closes the session at once", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "verstas-stream2-"));
  await fs.writeFile(path.join(dir, "p.md"), "task");
  await fs.writeFile(path.join(dir, "s.md"), "rules");
  const bin = path.join(dir, "fake-claude");
  // Without a closed stdin the fake would hang on `cat`; the worker closes it after the result.
  await fs.writeFile(bin, `#!/bin/sh
read -r first
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"done"}]}}'
echo '{"type":"result","subtype":"success","result":"done","total_cost_usd":0.05,"num_turns":1}'
cat >/dev/null
`, { mode: 0o755 });
  const job: Job = { role: "implementer", ticket: "T-1", promptFile: path.join(dir, "p.md"), systemPromptFile: path.join(dir, "s.md"), caps: { minutes: 5, turns: 20, budgetUsd: 1 }, mcpConfigFile: path.join(dir, "m.json"), cwd: dir, binary: bin };
  try {
    const t0 = Date.now();
    const { code, events } = await captureRun(job, { input: new PassThrough() });
    expect(code).toBe(0);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(events.find((e) => e.kind === "worker_done")).toMatchObject({ ok: true, text: "done", costUsd: 0.05, turns: 1 });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

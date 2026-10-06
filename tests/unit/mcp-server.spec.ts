import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import readline from "node:readline";

/**
 * Drives the real stdio MCP server against a fake agent API, the way
 * `claude -p --mcp-config` would: initialize, tools/list, tools/call.
 */

type Rpc = { jsonrpc: "2.0"; id?: number; method?: string; params?: unknown; result?: Record<string, unknown>; error?: { code: number; message: string } };

test("board MCP server speaks JSON-RPC and forwards tool calls with the run token", async () => {
  test.setTimeout(20_000);
  const seen: { method: string; url: string; auth: string | undefined; body: string }[] = [];
  const api = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization, body });
      if (req.url === "/agent/tickets/T-1") {
        res.setHeader("content-type", "application/json").end(JSON.stringify({ id: "T-1", title: "Schema" }));
      } else if (req.url === "/agent/tickets" && req.method === "POST") {
        res.statusCode = 403;
        res.setHeader("content-type", "application/json").end(JSON.stringify({ error: "A worker may not create feature tickets; file an idea instead" }));
      } else {
        res.setHeader("content-type", "application/json").end(JSON.stringify({ ok: true, url: req.url }));
      }
    });
  });
  const port = await new Promise<number>((r) => api.listen(0, "127.0.0.1", () => r((api.address() as net.AddressInfo).port)));

  const child = spawn(process.execPath, ["--import", "tsx", "src/worker/mcp-server.ts"], {
    env: { ...process.env, VERSTAS_AGENT_API: `http://127.0.0.1:${port}/agent`, VERSTAS_RUN_TOKEN: "tok-123", HTTP_PROXY: "", http_proxy: "" },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const rl = readline.createInterface({ input: child.stdout });
  const pending = new Map<number, (r: Rpc) => void>();
  rl.on("line", (line) => {
    const msg = JSON.parse(line) as Rpc;
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
  });
  let nextId = 1;
  const call = (method: string, params?: unknown): Promise<Rpc> =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });

  try {
    const init = await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    expect(init.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "verstas-board" } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

    const list = await call("tools/list");
    const names = (list.result!.tools as { name: string; inputSchema: { required: string[] } }[]).map((t) => t.name);
    expect(names).toEqual([
      "budget", "board_list_tickets", "board_get_ticket", "board_add_note", "board_report", "board_create_ticket",
      "chore", "chores_list", "board_set_priority", "board_add_dep", "request", "halt", "message", "idea",
    ]);

    const got = await call("tools/call", { name: "board_get_ticket", arguments: { id: "T-1" } });
    expect(got.result).toEqual({ content: [{ type: "text", text: JSON.stringify({ id: "T-1", title: "Schema" }, null, 2) }] });
    expect(seen.at(-1)).toMatchObject({ method: "GET", url: "/agent/tickets/T-1", auth: "Bearer tok-123" });

    const req = await call("tools/call", { name: "request", arguments: { summary: "fonts", actions: [{ kind: "network", host: "fonts.googleapis.com" }] } });
    expect(req.result).toMatchObject({ content: [{ type: "text" }] });
    expect(JSON.parse(seen.at(-1)!.body)).toEqual({ summary: "fonts", actions: [{ kind: "network", host: "fonts.googleapis.com" }] });

    const denied = await call("tools/call", { name: "board_create_ticket", arguments: { title: "x", kind: "feature", spec: "y" } });
    expect(denied.result).toMatchObject({ isError: true, content: [{ type: "text", text: "Error: A worker may not create feature tickets; file an idea instead (HTTP 403)" }] });

    const unknown = await call("tools/call", { name: "nope", arguments: {} });
    expect(unknown.error?.code).toBe(-32602);

    expect((await call("ping")).result).toEqual({});
    expect((await call("resources/list")).error?.code).toBe(-32601);
  } finally {
    child.stdin.end();
    child.kill();
    api.close();
  }
});

test("the budget tool turns the worker's totals into what is left, and says so when there are none", async () => {
  const { readBudget } = await import("../../src/worker/mcp-server.js");
  const os = await import("node:os");
  const path = await import("node:path");
  const { promises: fs } = await import("node:fs");
  expect(await readBudget("")).toMatchObject({ available: false });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "verstas-budget-"));
  try {
    const file = path.join(dir, "budget.json");
    expect(await readBudget(file)).toMatchObject({ available: false });
    await fs.writeFile(file, JSON.stringify({ turns: 12, seconds: 600, contextTokens: 84_000, outputTokens: 9_000, caps: { minutes: 25, turns: 60, budgetUsd: 5 }, resumed: true }));
    expect(await readBudget(file)).toEqual({ available: true, turns: 12, turnsLeft: 48, minutes: 10, minutesLeft: 15, contextTokens: 84_000, outputTokens: 9_000, budgetUsd: 5, resumedConversation: true });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("claim, submit and handoff are shown to a lead only", async () => {
  const { visibleTools } = await import("../../src/worker/mcp-server.js");
  const lead = visibleTools("lead").map((t) => t.name);
  const worker = visibleTools("implementer").map((t) => t.name);
  for (const name of ["board_claim", "board_run", "board_submit", "handoff", "chores_sweep", "chores_submit"]) {
    expect(lead).toContain(name);
    expect(worker).not.toContain(name);
  }
  for (const name of ["chore", "chores_list"]) {
    expect(lead).toContain(name);
    expect(worker).toContain(name);
  }
  expect(worker).toContain("board_report");
  expect(lead).toContain("board_report");
});

test("board_submit submits, waits for the verdict, and returns the harness's notes since the submit", async () => {
  test.setTimeout(20_000);
  let state = "in_progress";
  let polls = 0;
  const notes = [{ by: "agent", text: "my own note", at: "1" }];
  const api = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/agent/tickets/T-1/submit") {
        state = "review";
        notes.push({ by: "agent", text: "Submitted for review by the lead", at: "2" });
        return res.end(JSON.stringify({ ok: true }));
      }
      if (req.url === "/agent/tickets/T-1") {
        if (state === "review" && ++polls === 2) {
          state = "ready";
          notes.push({ by: "harness", text: "Not done yet (missing test for the null case); attempt 1 of 2", at: "3" });
        }
        return res.end(JSON.stringify({ id: "T-1", state, attempts: polls >= 2 ? 1 : 0, notes }));
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "no" }));
    });
  });
  const port = await new Promise<number>((r) => api.listen(0, "127.0.0.1", () => r((api.address() as net.AddressInfo).port)));
  const child = spawn(process.execPath, ["--import", "tsx", "-e", `import("./src/worker/mcp-server.ts").then(async (m) => { process.stdout.write(JSON.stringify(await m.submitAndWait("T-1", 5000, 20)) + "\\n"); const late = await m.submitAndWait("T-1", 60, 20); process.stdout.write(JSON.stringify(late) + "\\n"); })`], {
    env: { ...process.env, VERSTAS_AGENT_API: `http://127.0.0.1:${port}/agent`, VERSTAS_RUN_TOKEN: "t", HTTP_PROXY: "", http_proxy: "" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  try {
    const lines: string[] = [];
    for await (const line of readline.createInterface({ input: child.stdout })) lines.push(line);
    const first = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(first).toEqual({ id: "T-1", state: "ready", verdict: expect.stringContaining("not done yet"), attempts: 1, notes: ["Not done yet (missing test for the null case); attempt 1 of 2"] });
    // A verdict that takes longer than the wait comes back as "still in review" (the fake judges only once).
    expect(JSON.parse(lines[1]!)).toMatchObject({ id: "T-1", state: "review", verdict: "still in review" });
  } finally {
    child.kill();
    api.close();
  }
});

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
      "board_list_tickets", "board_get_ticket", "board_add_note", "board_report", "board_create_ticket",
      "board_set_priority", "board_add_dep", "request", "message", "idea",
    ]);

    const got = await call("tools/call", { name: "board_get_ticket", arguments: { id: "T-1" } });
    expect(got.result).toEqual({ content: [{ type: "text", text: JSON.stringify({ id: "T-1", title: "Schema" }, null, 2) }] });
    expect(seen.at(-1)).toMatchObject({ method: "GET", url: "/agent/tickets/T-1", auth: "Bearer tok-123" });

    const req = await call("tools/call", { name: "request", arguments: { kind: "network", host: "fonts.googleapis.com", why: "fonts" } });
    expect(req.result).toMatchObject({ content: [{ type: "text" }] });
    expect(JSON.parse(seen.at(-1)!.body)).toEqual({ detail: { kind: "network", host: "fonts.googleapis.com" }, why: "fonts" });

    const denied = await call("tools/call", { name: "board_create_ticket", arguments: { title: "x", kind: "feature", spec: "y" } });
    expect(denied.result).toMatchObject({ isError: true, content: [{ type: "text", text: "Error: A worker may not create feature tickets; file an idea instead" }] });

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

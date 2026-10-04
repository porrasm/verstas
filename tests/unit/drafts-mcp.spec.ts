import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import type net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import express from "express";
import { DraftStore } from "../../src/drafts/store.js";
import { createDraftTools, DRAFT_SERVER_INSTRUCTIONS } from "../../src/drafts/tools.js";
import { createMcpHandler, createMcpRouter } from "../../src/drafts/mcp.js";
import { mcpSetup } from "../../src/drafts/setup.js";
import { setupScriptSchema } from "../../src/scripts/library.js";

/**
 * The draft MCP server end to end: a real Express app on a loopback port
 * with the tools over a temporary draft store, called the way an MCP client
 * calls it (Streamable HTTP, and stdio through the bridge).
 */

type Rpc = { jsonrpc: "2.0"; id?: number | null; result?: { content?: { type: string; text: string }[]; isError?: boolean; tools?: { name: string }[]; [k: string]: unknown }; error?: { code: number; message: string } };

const setup = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "verstas-mcp-"));
  const store = new DraftStore(dir);
  const tools = createDraftTools({
    store,
    workTargets: () => [{ name: "nuppi", path: "/repos/nuppi" }, { name: "kapula", path: "/repos/kapula" }],
    recipes: async () => [setupScriptSchema.parse({ name: "chromium", description: "Chromium deps", script: "#!/bin/sh\ntrue\n" })],
    branches: async () => ({ current: "main", branches: ["main", "feature"] }),
    detectPacks: async (p) => (p.endsWith("nuppi") ? ["node", "playwright"] : ["node"]),
    context: async () => "# Verstas sandbox: context for an assistant\n",
    reviewUrl: (id) => `http://127.0.0.1:4700/#/d/${id}`,
  });
  const app = express();
  app.use("/mcp", createMcpRouter(createMcpHandler({ name: "verstas-drafts", version: "0.0.0", instructions: DRAFT_SERVER_INSTRUCTIONS }, tools)));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as net.AddressInfo).port;
  const url = `http://127.0.0.1:${port}/mcp`;
  let nextId = 1;
  const rpc = async (method: string, params?: unknown): Promise<Rpc> => {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }) });
    return (await res.json()) as Rpc;
  };
  /** tools/call; returns the parsed JSON text, or the error text with isError. */
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; text: string; json: any }> => {
    const r = await rpc("tools/call", { name, arguments: args });
    const text = r.result?.content?.[0]?.text ?? "";
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      // markdown or an error line
    }
    return { isError: Boolean(r.result?.isError), text, json };
  };
  /** Raw request with headers fetch would not let us set (Host). */
  const raw = (opts: { method?: string; headers?: Record<string, string>; body?: string }) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path: "/mcp", method: opts.method ?? "POST", headers: { "content-type": "application/json", ...opts.headers } }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on("error", reject);
      req.end(opts.body ?? "");
    });
  const close = async () => {
    await new Promise((r) => server.close(r));
    await fs.rm(dir, { recursive: true, force: true });
  };
  return { store, url, port, rpc, call, raw, close };
};

test("initialize, instructions and a tool list with nothing that creates or starts a session", async () => {
  const s = await setup();
  try {
    const init = await s.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    expect(init.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "verstas-drafts" } });
    expect(String(init.result!.instructions)).toContain("You cannot create, start or run sessions");
    const note = await fetch(s.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    expect(note.status).toBe(202);

    const names = (await s.rpc("tools/list")).result!.tools!.map((t) => t.name);
    expect(names).toEqual([
      "verstas_context", "list_repositories", "list_recipes", "draft_list", "draft_get", "draft_get_ticket", "draft_create", "draft_update",
      "draft_set_repositories", "draft_set_network", "draft_set_recipes", "draft_add_tickets", "draft_update_ticket", "draft_remove_tickets", "draft_import_board", "draft_validate",
    ]);
    // The boundary is the surface: no tool may finalize, start, run, promote or delete.
    for (const n of names) expect(n).not.toMatch(/session|start|run|promot|finali[sz]e|delete|confirm|approve/);

    expect((await s.rpc("ping")).result).toEqual({});
    expect((await s.rpc("resources/list")).error?.code).toBe(-32601);
    expect((await s.rpc("tools/call", { name: "create_session", arguments: {} })).error?.code).toBe(-32602);
  } finally {
    await s.close();
  }
});

test("a draft is built step by step and every edit answers with its problems", async () => {
  const s = await setup();
  try {
    expect((await s.call("verstas_context")).text).toContain("context for an assistant");
    const repos = await s.call("list_repositories");
    expect(repos.json).toEqual([
      { name: "nuppi", currentBranch: "main", branches: ["main", "feature"], impliedPacks: ["node", "playwright"] },
      { name: "kapula", currentBranch: "main", branches: ["main", "feature"], impliedPacks: ["node"] },
    ]);
    expect((await s.call("list_recipes")).json).toEqual([{ name: "chromium", description: "Chromium deps", hosts: [], note: "", runAs: "root" }]);

    const created = await s.call("draft_create", { name: "Nuppi MVP", goal: "Headless core with mock MIDI" });
    const id = created.json.id as string;
    expect(created.json).toMatchObject({ ok: true, tickets: 0, reviewUrl: `http://127.0.0.1:4700/#/d/${id}` });

    expect((await s.call("draft_set_repositories", { id, repos: [{ target: "ghost" }] })).text).toMatch(/^Error: "ghost" is not a work target. Known: nuppi, kapula/);
    expect((await s.call("draft_set_repositories", { id, repos: [{ target: "nuppi", branch: "nope" }] })).text).toMatch(/has no branch "nope"/);
    const set = await s.call("draft_set_repositories", { id, repos: [{ target: "nuppi" }, { target: "kapula", branch: "feature" }] });
    expect(set.json).toMatchObject({ directories: ["nuppi", "kapula"], impliedPacks: ["node", "playwright"], hint: expect.stringContaining("playwright") });

    expect((await s.call("draft_set_network", { id, packs: ["anthropic"] })).isError).toBe(true);
    expect((await s.call("draft_set_network", { id, packs: ["node", "playwright", "debian"], extraHosts: ["fonts.googleapis.com"] })).json.ok).toBe(true);
    expect((await s.call("draft_set_recipes", { id, recipes: ["postgres"] })).text).toMatch(/Not in the library: postgres. Known: chromium/);
    expect((await s.call("draft_set_recipes", { id, recipes: ["chromium"] })).json.ok).toBe(true);
    await s.call("draft_update", { id, requirements: "Chromium for Playwright launches", notes: "Free tier is one device" });

    // A dependency on a ticket that is not there yet is allowed and reported.
    const first = await s.call("draft_add_tickets", { id, tickets: [{ title: "Toolchain", repo: "nuppi", spec: "npm ci", acceptance: ["gates pass"], deps: ["T-2"] }] });
    expect(first.json.added).toEqual(["T-1"]);
    expect(first.json.problems.errors).toEqual(["T-1 depends on T-2, which is not in the draft"]);
    const second = await s.call("draft_add_tickets", { id, tickets: [{ title: "Fader", repo: "kapula", spec: "add fader", acceptance: ["tests"] }] });
    expect(second.json.problems.errors).toEqual([]);
    expect((await s.call("draft_update_ticket", { id, ticketId: "T-2", deps: ["T-1"] })).json.problems.errors).toEqual(["Dependency cycle: T-1 -> T-2 -> T-1"]);
    await s.call("draft_update_ticket", { id, ticketId: "T-1", deps: [] });
    await s.call("draft_update_ticket", { id, ticketId: "T-2", deps: ["T-1"], size: "S" });
    expect((await s.call("draft_update_ticket", { id, ticketId: "T-1", repo: "elsewhere" })).json.problems.errors[0]).toContain('names repo "elsewhere"');
    await s.call("draft_update_ticket", { id, ticketId: "T-1", repo: "nuppi" });

    const v = await s.call("draft_validate", { id });
    expect(v.json).toMatchObject({ id, ready: true, errors: [] });

    const got = await s.call("draft_get", { id });
    expect(got.json).toMatchObject({ name: "Nuppi MVP", requirements: "Chromium for Playwright launches", packs: ["node", "playwright", "debian"], recipes: ["chromium"], repos: [{ target: "nuppi" }, { target: "kapula", branch: "feature" }] });
    expect(got.json.tickets[1]).toEqual({ id: "T-2", title: "Fader", kind: "feature", repo: "kapula", size: "S", priority: 100, deps: ["T-1"], state: "ready", pinned: false, acceptance: 1, specChars: 9 });
    expect((await s.call("draft_get_ticket", { id, ticketId: "T-2" })).json).toMatchObject({ spec: "add fader", acceptance: ["tests"] });

    const removed = await s.call("draft_remove_tickets", { id, ticketIds: ["T-1"] });
    expect(removed.json.depsDropped).toEqual(["T-2 no longer depends on T-1"]);
    const imported = await s.call("draft_import_board", { id, mode: "replace", board: JSON.stringify({ tickets: [{ title: "Only", repo: "nuppi", spec: "s", acceptance: ["a"] }] }) });
    expect(imported.json).toMatchObject({ created: ["T-1"], updated: [], tickets: 1 });

    const list = await s.call("draft_list");
    expect(list.json).toEqual([expect.objectContaining({ id, name: "Nuppi MVP", tickets: 1, errors: 0 })]);

    // Once a person creates the session, the draft is read-only to the assistant.
    await s.store.markPromoted(id, "2026-10-04-nuppi-mvp");
    const late = await s.call("draft_update", { id, notes: "more" });
    expect(late).toMatchObject({ isError: true, text: expect.stringContaining("already became the session 2026-10-04-nuppi-mvp") });
    expect((await s.call("draft_validate", { id })).json.promotedTo).toBe("2026-10-04-nuppi-mvp");

    expect((await s.call("draft_get", { id: "nope-nope" })).text).toBe("Error: No draft nope-nope");
    expect((await s.call("draft_add_tickets", { id, tickets: [] })).text).toMatch(/^Error: Invalid arguments: tickets/);
  } finally {
    await s.close();
  }
});

test("the endpoint answers loopback hosts and loopback origins only", async () => {
  const s = await setup();
  try {
    const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
    expect((await s.raw({ body: init, headers: { host: "evil.example" } })).status).toBe(403);
    expect((await s.raw({ body: init, headers: { host: `127.0.0.1:${s.port}`, origin: "https://evil.example" } })).status).toBe(403);
    expect((await s.raw({ body: init, headers: { host: `127.0.0.1:${s.port}`, origin: "null" } })).status).toBe(403);
    expect((await s.raw({ body: init, headers: { host: `localhost:${s.port}`, origin: "http://127.0.0.1:4710" } })).status).toBe(200);
    expect((await s.raw({ body: init, headers: { host: `[::1]:${s.port}` } })).status).toBe(200);
    expect((await s.raw({ method: "GET", headers: { host: `127.0.0.1:${s.port}` } })).status).toBe(405);
    const bad = await s.raw({ body: "{ nope", headers: { host: `127.0.0.1:${s.port}` } });
    expect(bad.status).toBe(400);
    expect(JSON.parse(bad.body).error.code).toBe(-32700);
    const batch = await s.raw({ body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }]), headers: { host: `127.0.0.1:${s.port}` } });
    expect(JSON.parse(batch.body)).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }]);
  } finally {
    await s.close();
  }
});

test("the stdio bridge forwards to the endpoint and says so when Verstas is down", async () => {
  test.setTimeout(30_000);
  const s = await setup();
  const bridge = (url: string) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/drafts/mcp-stdio.ts"], { env: { ...process.env, VERSTAS_URL: url }, stdio: ["pipe", "pipe", "inherit"] });
    const lines: Rpc[] = [];
    const waiters: (() => void)[] = [];
    readline.createInterface({ input: child.stdout }).on("line", (l) => {
      lines.push(JSON.parse(l) as Rpc);
      waiters.splice(0).forEach((w) => w());
    });
    const next = async (): Promise<Rpc> => {
      while (!lines.length) await new Promise<void>((r) => waiters.push(r));
      return lines.shift()!;
    };
    const send = (msg: unknown) => child.stdin.write(JSON.stringify(msg) + "\n");
    return { child, next, send };
  };
  try {
    const b = bridge(`http://127.0.0.1:${s.port}`);
    b.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    expect((await b.next()).result).toMatchObject({ serverInfo: { name: "verstas-drafts" } });
    b.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    b.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "draft_create", arguments: { name: "Via stdio" } } });
    const created = await b.next();
    expect(created.id).toBe(2);
    expect(JSON.parse(created.result!.content![0]!.text)).toMatchObject({ ok: true });
    b.child.stdin.end();
    await new Promise((r) => b.child.on("exit", r));

    // Nothing listens on this port any more once the server closes; use a fresh closed one.
    const closed = http.createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const deadPort = (closed.address() as net.AddressInfo).port;
    await new Promise((r) => closed.close(r));
    const down = bridge(`http://127.0.0.1:${deadPort}`);
    down.send({ jsonrpc: "2.0", id: 7, method: "tools/list" });
    const err = await down.next();
    expect(err).toMatchObject({ id: 7, error: { code: -32000 } });
    expect(err.error!.message).toContain("Verstas is not reachable");
    down.child.stdin.end();
    await new Promise((r) => down.child.on("exit", r));
  } finally {
    await s.close();
  }
});

test("setup instructions use this machine's port and paths, and Electron runs as Node", () => {
  const plain = mcpSetup({ url: "http://127.0.0.1:4700/mcp", stdioScript: "/v/dist/src/drafts/mcp-stdio.js", stdioBuilt: true, node: { command: "/usr/local/bin/node", electron: false } });
  expect(plain.claudeCode).toBe("claude mcp add --scope user --transport http verstas http://127.0.0.1:4700/mcp");
  expect(JSON.parse(plain.desktopConfig)).toEqual({ mcpServers: { verstas: { command: "/usr/local/bin/node", args: ["/v/dist/src/drafts/mcp-stdio.js"] } } });
  expect(plain.prompt).toContain("verstas_context");
  const electron = mcpSetup({ url: "http://127.0.0.1:4700/mcp", stdioScript: "/v/x.js", stdioBuilt: false, node: { command: "/Applications/Verstas.app/Contents/MacOS/Electron", electron: true } });
  expect(JSON.parse(electron.desktopConfig).mcpServers.verstas.env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
});

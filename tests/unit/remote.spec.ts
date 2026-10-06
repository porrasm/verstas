import { test, expect } from "@playwright/test";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { importBoard, emptyBoard } from "../../src/board/board.js";
import { saveBoard, writeJsonAtomic } from "../../src/board/store.js";
import { configSchema } from "../../src/config.js";
import { inboxSchema, now, requestSchema, sessionSchema, type VerstasEvent } from "../../src/core/types.js";
import { RemoteClient, type RemoteClientDeps } from "../../src/remote/client.js";
import { remoteCommandSchema, toApiCall } from "../../src/remote/commands.js";
import { flattenEvent, remoteSession } from "../../src/remote/view.js";
import { SessionHub } from "../../src/sessions/hub.js";
import { sessionPaths } from "../../src/sessions/sessions.js";

/**
 * The remote dashboard from this side: what leaves the machine (only ticked
 * sessions, never tool output), which commands are accepted, and the client
 * against a fake relay.
 */

const T = "2026-10-04T10:00:00.000Z";

const ALL_EVENTS: VerstasEvent[] = [
  { kind: "text", t: T, text: "x".repeat(1000) },
  { kind: "tool_use", t: T, tool: "Bash", summary: "npm test" },
  { kind: "tool_result", t: T, tool: "Bash", ok: true, summary: "SECRET FILE CONTENTS" },
  { kind: "status", t: T, text: "picked T-1" },
  { kind: "gate", t: T, ticket: "T-1", name: "tests", ok: false, summary: "2 failing" },
  { kind: "ticket", t: T, ticket: "T-1", from: "ready", to: "in_progress" },
  { kind: "denied_network", t: T, host: "evil.example", port: 443 },
  { kind: "request", t: T, requestId: "R-1", summary: "need playwright" },
  { kind: "cost", t: T, cost: { inputTokens: 1, outputTokens: 1, usd: 0.1 } },
  { kind: "run", t: T, state: "paused", reason: "user" },
  { kind: "error", t: T, text: "boom" },
  { kind: "worker_done", t: T, role: "implementer", ok: true, stopReason: "end_turn", rateLimited: false, costUsd: 0.2, turns: 5, seconds: 30, text: "FULL REPORT", stderr: "STDERR" },
];

test("events: tool results and cost never leave; every line is short and has only display fields", () => {
  const out = ALL_EVENTS.map(flattenEvent);
  expect(out.filter((e) => e === null)).toHaveLength(2);
  const flat = out.filter((e) => e !== null);
  for (const e of flat) {
    expect(Object.keys(e).every((k) => ["t", "kind", "ticket", "text", "ok"].includes(k))).toBe(true);
    expect(e.text.length).toBeLessThanOrEqual(400);
  }
  const all = JSON.stringify(flat);
  expect(all).not.toContain("SECRET FILE CONTENTS");
  expect(all).not.toContain("FULL REPORT");
  expect(all).not.toContain("STDERR");
  expect(flat.find((e) => e.kind === "tool_use")?.text).toBe("Bash: npm test");
});

const makeRoot = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "verstas-remote-"));
  const add = async (id: string, remote: boolean, initialized = true) => {
    const paths = sessionPaths(root, id);
    await fs.mkdir(paths.runs, { recursive: true });
    await writeJsonAtomic(paths.session, sessionSchema.parse({ id, name: id, goal: "g", createdAt: now(), initializedAt: initialized ? T : null, remote, repos: [{ name: "app", sourcePath: "/x", branch: "main", runBranch: "verstas/x" }] }));
    await saveBoard(paths.dir, importBoard(emptyBoard("g"), { tickets: [{ id: "T-1", title: "First", state: "ready", spec: "s".repeat(10_000) }] }).board);
    await writeJsonAtomic(
      paths.inbox,
      inboxSchema.parse({ requests: [requestSchema.parse({ id: "R-1", summary: "need a pack", createdAt: now(), actions: [{ id: "a1", detail: { kind: "pack", pack: "playwright" } }] })] }),
    );
  };
  await add("shared-one", true);
  await add("private-one", false);
  // Ticked but still a plan: nothing to run or watch, so it is not sent.
  await add("plan-one", true, false);
  return { root, hub: new SessionHub(root), ids: ["shared-one", "private-one", "plan-one"] };
};

test("a session's view caps long text and names the hosts a pack would add", async () => {
  const { hub } = await makeRoot();
  const h = await hub.get("shared-one");
  const v = remoteSession({ ...h.snapshot(), run: undefined, active: false, totals: { usd: 0, runs: 0, lastActivityAt: T }, events: [] });
  expect(v.tickets[0]!.spec.length).toBeLessThanOrEqual(4000);
  // Only what the dashboard shows: nothing about setup, agents, settings or messages.
  expect(Object.keys(v).sort()).toEqual(["active", "events", "id", "name", "prompts", "requests", "state", "tickets", "totals"]);
  const detail = v.requests[0]!.actions[0]!.detail as { kind: string; hosts?: string[] };
  expect(detail.kind).toBe("pack");
  expect(detail.hosts?.length).toBeGreaterThan(0);
});

test("commands: known kinds map to the UI API; anything else is refused", () => {
  const ok = remoteCommandSchema.parse({ kind: "decide", payload: { sessionId: "shared-one", requestId: "R-1", actions: [{ id: "a1", decision: "approve" }] } });
  expect(toApiCall(ok)).toEqual({ method: "POST", path: "/sessions/shared-one/requests/R-1", body: { answer: undefined, actions: [{ id: "a1", decision: "approve" }], declineAll: false } });
  const approve = remoteCommandSchema.parse({ kind: "ticket.approve", payload: { sessionId: "shared-one", ticketId: "T-1" } });
  expect(toApiCall(approve)).toEqual({ method: "POST", path: "/sessions/shared-one/tickets/T-1/state", body: { state: "ready" } });
  for (const bad of [
    { kind: "session.delete", payload: { sessionId: "shared-one" } },
    // Gone from the dashboard: editing, moving anywhere but ready, setup and planning stay in the app.
    { kind: "ticket.move", payload: { sessionId: "shared-one", ticketId: "T-1", state: "done" } },
    { kind: "ticket.update", payload: { sessionId: "shared-one", ticketId: "T-1", title: "x" } },
    { kind: "setup.confirm", payload: { sessionId: "shared-one", start: true } },
    { kind: "run", payload: { sessionId: "shared-one", action: "setup" } },
    { kind: "run", payload: { sessionId: "shared-one", action: "plan" } },
    { kind: "run", payload: { sessionId: "../../config", action: "start" } },
    { kind: "decide", payload: { sessionId: "shared-one", requestId: "R-1/../x", actions: [] } },
  ]) {
    expect(remoteCommandSchema.safeParse(bad).success).toBe(false);
  }
});

/** A relay that records what it gets and hands out queued commands. */
const fakeRelay = async () => {
  const pushes: { sessions: { id: string }[] }[] = [];
  const results: { id: string; body: unknown }[] = [];
  const deletes: number[] = [];
  let queue: { id: string; kind: string; payload: unknown }[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (req.headers.authorization !== "Bearer vst_test") return void res.writeHead(404).end();
      const json = (o: unknown) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(o));
      };
      const url = req.url ?? "";
      if (req.method === "POST" && url === "/api/verstas/host/state") {
        pushes.push(JSON.parse(raw));
        return json({ ok: true });
      }
      if (req.method === "DELETE" && url === "/api/verstas/host/state") {
        deletes.push(Date.now());
        return json({ ok: true });
      }
      if (req.method === "GET" && url.startsWith("/api/verstas/host/commands")) {
        const out = queue;
        queue = [];
        // A short poll keeps the test quick.
        return setTimeout(() => json({ commands: out, needState: false }), out.length ? 0 : 50);
      }
      if (req.method === "POST" && url.startsWith("/api/verstas/host/commands/")) {
        results.push({ id: url.split("/").pop()!, body: JSON.parse(raw) });
        return json({ ok: true });
      }
      if (url === "/api/verstas/host/hello") return json({ ok: true, protocol: 2, name: "test mac" });
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, pushes, results, deletes, enqueue: (c: { id: string; kind: string; payload: unknown }) => queue.push(c), close: () => server.close() };
};

const waitFor = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

test("client: pushes only ticked, initialized sessions, carries out commands for them, refuses the rest, says goodbye", async () => {
  const { hub, ids } = await makeRoot();
  const relay = await fakeRelay();
  const calls: { method: string; path: string; body: unknown }[] = [];
  const deps: RemoteClientDeps = {
    hub,
    runs: { status: () => undefined },
    listSessionIds: async () => ids,
    getConfig: () => configSchema.parse({ remote: { enabled: true, baseUrl: relay.base } }),
    getToken: async () => "vst_test",
    localApi: async (call) => {
      calls.push(call);
      return { status: 200, body: { ok: true } };
    },
    version: "0.0.0-test",
  };
  const client = new RemoteClient(deps);
  try {
    await client.apply();
    await waitFor(() => relay.pushes.length > 0);
    const first = relay.pushes[0]!;
    expect(first.sessions.map((s) => s.id)).toEqual(["shared-one"]);
    expect(JSON.stringify(first)).not.toContain("private-one");
    await waitFor(() => client.status().state === "connected");

    relay.enqueue({ id: "c1", kind: "run", payload: { sessionId: "shared-one", action: "start" } });
    relay.enqueue({ id: "c2", kind: "run", payload: { sessionId: "private-one", action: "start" } });
    relay.enqueue({ id: "c3", kind: "settings.change", payload: { sessionId: "shared-one" } });
    relay.enqueue({ id: "c4", kind: "run", payload: { sessionId: "plan-one", action: "start" } });
    await waitFor(() => relay.results.length === 4);
    expect(relay.results.map((r) => [r.id, (r.body as { ok: boolean }).ok])).toEqual([
      ["c1", true],
      ["c2", false],
      ["c3", false],
      ["c4", false],
    ]);
    expect((relay.results[1]!.body as { error: string }).error).toContain("not shared");
    expect(calls).toEqual([{ method: "POST", path: "/sessions/shared-one/run", body: { action: "start", prompt: undefined } }]);

    // Unticking a session takes it off the dashboard with the next push.
    const before = relay.pushes.length;
    const h = await hub.get("shared-one");
    await h.mutate((d) => ({ next: { session: { ...d.session, remote: false } } }));
    await waitFor(() => relay.pushes.length > before && relay.pushes[relay.pushes.length - 1]!.sessions.length === 0);
  } finally {
    await client.stop();
    relay.close();
  }
  expect(relay.deletes).toHaveLength(1);
  expect(client.status().state).toBe("off");
});

test("client: off by default, and does nothing without a URL and token", async () => {
  const { hub, ids } = await makeRoot();
  const base: Omit<RemoteClientDeps, "getConfig" | "getToken"> = { hub, runs: { status: () => undefined }, listSessionIds: async () => ids, localApi: async () => ({ status: 200, body: {} }), version: "t" };
  const off = new RemoteClient({ ...base, getConfig: () => configSchema.parse({}), getToken: async () => "vst_test" });
  await off.apply();
  expect(off.status().state).toBe("off");
  const noToken = new RemoteClient({ ...base, getConfig: () => configSchema.parse({ remote: { enabled: true, baseUrl: "https://example.com" } }), getToken: async () => undefined });
  await noToken.apply();
  expect(noToken.status()).toMatchObject({ state: "unconfigured", error: "No token" });
});

test("test connection reports the dashboard's name for a known token and a clear error otherwise", async () => {
  const relay = await fakeRelay();
  try {
    expect(await RemoteClient.test(relay.base, "vst_test")).toEqual({ ok: true, name: "test mac" });
    expect((await RemoteClient.test(relay.base, "wrong")).error).toContain("does not know this token");
  } finally {
    relay.close();
  }
});

test("a fresh session is not shared", () => {
  expect(sessionSchema.parse({ id: "abc-1", name: "n", goal: "", createdAt: T }).remote).toBe(false);
});

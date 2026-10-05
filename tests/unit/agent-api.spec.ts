import { test, expect } from "@playwright/test";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createAgentApi, RunTokens } from "../../src/agent-api/agent-api.js";
import { importBoard, emptyBoard, transition } from "../../src/board/board.js";
import { saveBoard, writeJsonAtomic } from "../../src/board/store.js";
import { SessionHub } from "../../src/sessions/hub.js";
import { sessionPaths } from "../../src/sessions/sessions.js";
import { inboxSchema, sessionSchema } from "../../src/core/types.js";

const setup = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "verstas-api-"));
  const id = "2026-10-03-t";
  const paths = sessionPaths(root, id);
  await fs.mkdir(paths.workspace, { recursive: true });
  await writeJsonAtomic(paths.session, sessionSchema.parse({ id, name: "t", goal: "g", createdAt: "2026-10-03T00:00:00.000Z" }));
  let board = importBoard(emptyBoard("g"), {
    tickets: [
      { id: "T-1", title: "Schema", state: "ready", pinned: true },
      { id: "T-2", title: "Engine", state: "ready", deps: ["T-1"] },
    ],
  }).board;
  board = transition(board, "T-2", "in_progress");
  await saveBoard(paths.dir, board);
  await writeJsonAtomic(paths.inbox, inboxSchema.parse({}));
  const hub = new SessionHub(root);
  const tokens = new RunTokens();
  const token = tokens.issue({ sessionId: id, runId: 1, role: "worker", currentTicket: "T-2" });
  const app = createAgentApi(hub, tokens);
  const server = app.listen(0, "127.0.0.1");
  const port = await new Promise<number>((r) => server.on("listening", () => r((server.address() as net.AddressInfo).port)));
  const call = async (method: string, p: string, body?: unknown, auth = `Bearer ${token}`) => {
    const res = await fetch(`http://127.0.0.1:${port}/agent${p}`, {
      method,
      headers: { ...(auth ? { authorization: auth } : {}), "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  const close = async () => {
    await new Promise((r) => server.close(r));
    await fs.rm(root, { recursive: true, force: true });
  };
  return { hub, tokens, token, call, close, id };
};

test("rejects missing or unknown tokens and unknown routes", async () => {
  const s = await setup();
  try {
    expect((await s.call("GET", "/board", undefined, "")).status).toBe(401);
    expect((await s.call("GET", "/board", undefined, "Bearer nope")).status).toBe(401);
    expect((await s.call("GET", "/sessions")).status).toBe(404);
  } finally {
    await s.close();
  }
});

test("reads the board and tickets, with the current ticket in the summary", async () => {
  const s = await setup();
  try {
    const b = await s.call("GET", "/board");
    expect(b.status).toBe(200);
    expect(b.json.currentTicket).toBe("T-2");
    expect((b.json.tickets as { id: string }[]).map((t) => t.id)).toEqual(["T-1", "T-2"]);
    expect(((await s.call("GET", "/board?state=in_progress")).json.tickets as unknown[]).length).toBe(1);
    const t = await s.call("GET", "/tickets/T-1");
    expect(t.json).toMatchObject({ id: "T-1", title: "Schema", pinned: true });
    expect((await s.call("GET", "/tickets/T-9")).status).toBe(404);
    expect((await s.call("GET", "/tickets/evil")).status).toBe(400);
  } finally {
    await s.close();
  }
});

test("workers may file bugs, not features; notes, reports, priorities and deps follow the board rules", async () => {
  const s = await setup();
  try {
    const bug = await s.call("POST", "/tickets", { title: "Fix off-by-one", kind: "bug", spec: "in cc14" });
    expect(bug.status).toBe(201);
    expect(bug.json).toMatchObject({ id: "T-3", state: "backlog" });
    const feat = await s.call("POST", "/tickets", { title: "Shiny", kind: "feature", spec: "x" });
    expect(feat.status).toBe(403);
    expect(String(feat.json.error)).toContain("idea");

    expect((await s.call("POST", "/tickets/T-2/notes", { text: "found the cause" })).status).toBe(200);
    expect((await s.call("POST", "/tickets/T-2/report", { report: "did it" })).status).toBe(200);
    expect((await s.call("POST", "/tickets/T-1/priority", { priority: 1, reason: "x" })).status).toBe(403); // pinned
    expect((await s.call("POST", "/tickets/T-3/priority", { priority: 1, reason: "urgent" })).status).toBe(200);
    expect((await s.call("POST", "/tickets/T-3/deps", { dep: "T-2", reason: "needs engine" })).status).toBe(200);
    expect((await s.call("POST", "/tickets/T-1/deps", { dep: "T-2", reason: "cycle?" })).status).toBe(403); // pinned (and would cycle)
    expect((await s.call("POST", "/tickets/T-3/notes", { text: "" })).status).toBe(400);

    const h = await s.hub.get(s.id);
    const t3 = h.board.tickets.find((t) => t.id === "T-3")!;
    expect(t3.priority).toBe(1);
    expect(t3.deps).toEqual(["T-2"]);
    expect(t3.notes.map((n) => n.by)).toEqual(["harness", "agent", "agent"]);
    expect(h.board.tickets.find((t) => t.id === "T-2")!.report).toBe("did it");
  } finally {
    await s.close();
  }
});

test("requests carry a summary and typed actions; halt is its own tool; messages and ideas land in the inbox", async () => {
  const s = await setup();
  try {
    const r = await s.call("POST", "/requests", {
      summary: "Need Postgres and two decisions before the tests can run.",
      actions: [
        { kind: "pack", pack: "playwright" },
        { kind: "network", host: "fonts.googleapis.com" },
        { kind: "question", text: "Fresh empty database, or restore a dump?", options: ["fresh", "dump"] },
        { kind: "instruction", text: "Place real OPENAI_API_KEY in /workspace/secrets/apps.env if you want LLM features." },
      ],
    });
    expect(r.status).toBe(201);
    expect(r.json.id).toBe("R-1");
    expect(r.json.actions).toEqual(["a1", "a2", "a3", "a4"]);
    expect(String(r.json.next)).toContain("Stop working");
    // A pure question: zero actions is fine.
    expect((await s.call("POST", "/requests", { summary: "Is dev login acceptable here?" })).json.id).toBe("R-2");
    const halt = await s.call("POST", "/halt", { reason: "spec contradiction", severity: "critical" });
    expect(halt.json.id).toBe("R-3");
    expect(String(halt.json.next)).toContain("pause");
    // Validation still bites per action.
    expect((await s.call("POST", "/requests", { summary: "x", actions: [{ kind: "network", host: "10.0.0.1" }] })).status).toBe(400);
    expect((await s.call("POST", "/requests", { summary: "x", actions: [{ kind: "install", manager: "apt", packages: ["tree"] }] })).status).toBe(400);
    // root_script is retired, with a message that says what to do instead.
    const retired = await s.call("POST", "/requests", { summary: "x", actions: [{ kind: "root_script", script: "apt-get install -y tree" }] });
    expect(retired.status).toBe(400);
    expect(String(retired.json.error)).toContain("sudo");
    expect((await s.call("POST", "/messages", { text: "tests are slow" })).json.id).toBe("M-1");
    expect((await s.call("POST", "/ideas", { title: "Per-track pages", pitch: "would sell" })).json.id).toBe("I-1");

    const h = await s.hub.get(s.id);
    expect(h.inbox.requests.map((r) => [r.id, r.ticketId, r.state, r.actions.length, Boolean(r.halt)])).toEqual([["R-1", "T-2", "open", 4, false], ["R-2", "T-2", "open", 0, false], ["R-3", "T-2", "open", 0, true]]);
    expect(h.inbox.requests[0]!.actions.map((a) => a.detail.kind)).toEqual(["pack", "network", "question", "instruction"]);
    expect(h.inbox.messages[0]).toMatchObject({ ticketId: "T-2", read: false });
    expect(h.inbox.ideas[0]).toMatchObject({ ticketId: "T-2", title: "Per-track pages" });
    expect(h.board.tickets.find((t) => t.id === "T-2")!.notes.map((n) => n.text).join("\n")).toContain("Halt requested (critical)");
    const onDisk = JSON.parse(await fs.readFile(h.paths.inbox, "utf8")) as { requests: unknown[] };
    expect(onDisk.requests).toHaveLength(3);
  } finally {
    await s.close();
  }
});

test("a revoked token stops working at once", async () => {
  const s = await setup();
  try {
    s.tokens.revokeRun(s.id, 1);
    expect((await s.call("GET", "/board")).status).toBe(401);
  } finally {
    await s.close();
  }
});

test("a lead claims a ready ticket, submits it with a report, and hands off; workers and missing runs are refused", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "verstas-api-lead-"));
  const id = "2026-10-05-lead";
  const paths = sessionPaths(root, id);
  await fs.mkdir(paths.workspace, { recursive: true });
  await writeJsonAtomic(paths.session, sessionSchema.parse({ id, name: "l", goal: "g", createdAt: "2026-10-05T00:00:00.000Z" }));
  await saveBoard(
    paths.dir,
    importBoard(emptyBoard("g"), {
      tickets: [
        { id: "T-1", title: "Schema", state: "ready" },
        { id: "T-2", title: "Engine", state: "ready", deps: ["T-1"] },
        { id: "T-3", title: "Docs", state: "ready" },
        { id: "T-4", title: "Later", state: "backlog" },
      ],
    }).board,
  );
  await writeJsonAtomic(paths.inbox, inboxSchema.parse({}));
  const hub = new SessionHub(root);
  const tokens = new RunTokens();
  const submitted: string[] = [];
  const handoffs: string[] = [];
  const lead = tokens.issue({ sessionId: id, runId: 1, role: "lead" });
  const worker = tokens.issue({ sessionId: id, runId: 1, role: "worker", currentTicket: "T-3" });
  const servers = [createAgentApi(hub, tokens, { submitted: (_r, t) => submitted.push(t), handoff: (_r, n) => handoffs.push(n) }), createAgentApi(hub, tokens)].map((app) => app.listen(0, "127.0.0.1"));
  const ports = await Promise.all(servers.map((s) => new Promise<number>((r) => (s.listening ? r((s.address() as net.AddressInfo).port) : s.on("listening", () => r((s.address() as net.AddressInfo).port))))));
  const call = async (method: string, p: string, body: unknown, token: string, port = ports[0]) => {
    const res = await fetch(`http://127.0.0.1:${port}/agent${p}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  const state = async (t: string) => (await hub.get(id)).board.tickets.find((x) => x.id === t)!.state;
  try {
    // Workers do not drive the board, and without a run nothing can judge.
    expect((await call("POST", "/tickets/T-3/claim", {}, worker)).status).toBe(403);
    expect((await call("POST", "/tickets/T-1/claim", {}, lead, ports[1])).status).toBe(409);
    // Only ready tickets with their dependencies done.
    expect((await call("POST", "/tickets/T-4/claim", {}, lead)).json.error).toContain("backlog, not ready");
    expect((await call("POST", "/tickets/T-2/claim", {}, lead)).json.error).toContain("waits on T-1");
    expect(await call("POST", "/tickets/T-1/claim", {}, lead)).toMatchObject({ status: 200, json: { state: "in_progress" } });
    expect(tokens.lookup(lead)!.currentTicket).toBe("T-1");
    expect((await hub.get(id)).board.tickets[0]!.notes.at(-1)).toMatchObject({ by: "agent", text: expect.stringContaining("Claimed by the lead") });
    // One at a time.
    expect((await call("POST", "/tickets/T-3/claim", {}, lead)).json.error).toContain("You hold T-1");
    // Submit needs the ticket held and a report.
    expect((await call("POST", "/tickets/T-3/submit", {}, lead)).json.error).toContain("do not hold T-3");
    expect((await call("POST", "/tickets/T-1/submit", {}, lead)).json.error).toContain("board_report");
    await call("POST", "/tickets/T-1/report", { report: "schema added, tests pass" }, lead);
    expect(await call("POST", "/tickets/T-1/submit", {}, lead)).toMatchObject({ status: 200, json: { state: "review" } });
    expect(submitted).toEqual(["T-1"]);
    expect(await state("T-1")).toBe("review");
    // Still held while in review: no second claim until the verdict.
    expect((await call("POST", "/tickets/T-3/claim", {}, lead)).json.error).toContain("You hold T-1 (review)");
    // The judge settles it; the lead may claim again.
    const h = await hub.get(id);
    await h.mutate((d) => ({ next: { board: transition(d.board, "T-1", "done") } }));
    expect((await call("POST", "/tickets/T-3/claim", {}, lead)).status).toBe(200);
    // Handoff passes the note to the run.
    expect((await call("POST", "/handoff", { note: "T-3 half done: see notes/state.md" }, lead)).json.next).toContain("Stop now");
    expect(handoffs).toEqual(["T-3 half done: see notes/state.md"]);
    expect((await call("POST", "/handoff", { note: "x" }, worker)).status).toBe(403);
  } finally {
    for (const s of servers) s.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a lead may propose feature tickets; they land in the backlog", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "verstas-api-feat-"));
  const id = "2026-10-05-feat";
  const paths = sessionPaths(root, id);
  await fs.mkdir(paths.workspace, { recursive: true });
  await writeJsonAtomic(paths.session, sessionSchema.parse({ id, name: "f", goal: "g", createdAt: "2026-10-05T00:00:00.000Z" }));
  await saveBoard(paths.dir, emptyBoard("g"));
  await writeJsonAtomic(paths.inbox, inboxSchema.parse({}));
  const hub = new SessionHub(root);
  const tokens = new RunTokens();
  const lead = tokens.issue({ sessionId: id, runId: 1, role: "lead" });
  const worker = tokens.issue({ sessionId: id, runId: 1, role: "worker" });
  const server = createAgentApi(hub, tokens).listen(0, "127.0.0.1");
  const port = await new Promise<number>((r) => server.on("listening", () => r((server.address() as net.AddressInfo).port)));
  const create = (token: string) => fetch(`http://127.0.0.1:${port}/agent/tickets`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ title: "Export as CSV", kind: "feature", spec: "x" }) });
  try {
    expect((await create(worker)).status).toBe(403);
    const res = await create(lead);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ state: "backlog" });
  } finally {
    server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("what a lead files after its ticket is settled is not attached to that ticket", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "verstas-api-held-"));
  const id = "2026-10-05-held";
  const paths = sessionPaths(root, id);
  await fs.mkdir(paths.workspace, { recursive: true });
  await writeJsonAtomic(paths.session, sessionSchema.parse({ id, name: "h", goal: "g", createdAt: "2026-10-05T00:00:00.000Z" }));
  await saveBoard(paths.dir, transition(transition(importBoard(emptyBoard("g"), { tickets: [{ id: "T-1", title: "Schema", state: "ready" }] }).board, "T-1", "in_progress"), "T-1", "review"));
  await writeJsonAtomic(paths.inbox, inboxSchema.parse({}));
  const hub = new SessionHub(root);
  const tokens = new RunTokens();
  const lead = tokens.issue({ sessionId: id, runId: 1, role: "lead", currentTicket: "T-1" });
  const parked: string[] = [];
  const server = createAgentApi(hub, tokens, { submitted: () => undefined, handoff: () => undefined, requested: (_r, t) => parked.push(t) }).listen(0, "127.0.0.1");
  const port = await new Promise<number>((r) => server.on("listening", () => r((server.address() as net.AddressInfo).port)));
  const post = (p: string, body: unknown) => fetch(`http://127.0.0.1:${port}/agent${p}`, { method: "POST", headers: { authorization: `Bearer ${lead}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const h = await hub.get(id);
    await h.mutate((d) => ({ next: { board: transition(d.board, "T-1", "done") } }));
    expect((await post("/requests", { summary: "which license?", actions: [{ kind: "question", text: "MIT or Apache?" }] })).status).toBe(201);
    expect((await post("/messages", { text: "fyi" })).status).toBe(201);
    const after = await hub.get(id);
    expect(after.inbox.requests[0]!.ticketId).toBeUndefined();
    expect(after.inbox.messages[0]!.ticketId).toBeUndefined();
    expect(parked).toEqual([]);
  } finally {
    server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

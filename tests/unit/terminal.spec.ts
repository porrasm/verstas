import { test, expect } from "@playwright/test";
import { promises as fs } from "node:fs";
import http from "node:http";
import type net from "node:net";
import os from "node:os";
import path from "node:path";
import { createAgentApi, RunTokens, type RunToken } from "../../src/agent-api/agent-api.js";
import { deleteTicket, editTicket, emptyBoard, getTicket, importBoard, transition } from "../../src/board/board.js";
import { saveBoard, writeJsonAtomic } from "../../src/board/store.js";
import { inboxSchema, now, sessionSchema } from "../../src/core/types.js";
import { driverInfo } from "../../src/harness/drivers.js";
import { RunManager, type Shell, type WorkerRunner } from "../../src/harness/run.js";
import { LiveTerminal, terminalUpgrade, type TerminalNotice, type TerminalProcess, type TerminalRunner } from "../../src/harness/terminal.js";
import { dockerSocketPath, execTty } from "../../src/sandbox/docker-api.js";
import type { DockerRunner } from "../../src/sandbox/docker.js";
import { SessionHub } from "../../src/sessions/hub.js";
import { sessionPaths } from "../../src/sessions/sessions.js";
import { visibleTools } from "../../src/worker/mcp-server.js";
import { claudeTerminalArgs, codexTerminalArgs, skipClaudeOnboarding, type TerminalJob } from "../../src/worker/terminal.js";

// --- LiveTerminal ------------------------------------------------------------

const fakeProc = () => {
  const written: string[] = [];
  const sizes: [number, number][] = [];
  let emit: (b: Buffer) => void = () => undefined;
  let exit: (code: number | null) => void = () => undefined;
  const exited = new Promise<number | null>((r) => (exit = r));
  let killed = false;
  const proc: TerminalProcess = {
    write: (d) => void written.push(String(d)),
    resize: (c, r) => void sizes.push([c, r]),
    onData: (fn) => (emit = fn),
    exited,
    kill: async () => {
      killed = true;
      exit(null);
    },
  };
  return { proc, written, sizes, emit: (s: string) => emit(Buffer.from(s)), exit: (c: number | null) => exit(c), killed: () => killed };
};

const recorder = () => {
  const data: string[] = [];
  const notices: TerminalNotice[] = [];
  return { data, notices, client: { data: (b: Buffer) => void data.push(b.toString()), notice: (n: TerminalNotice) => void notices.push(n) } };
};

test("a live terminal replays its screen to a page that attaches late, and passes input and size once bound", () => {
  const live = new LiveTerminal(3, "claude", { cols: 100, rows: 30 });
  live.status("Starting the box…");
  const early = recorder();
  live.attach(early.client);
  expect(early.notices).toEqual([{ type: "status", text: "Starting the box…" }]);
  live.input("ignored before the process runs");
  const p = fakeProc();
  live.bind(p.proc);
  p.emit("hello ");
  p.emit("world");
  expect(early.data.join("")).toBe("hello world");
  const late = recorder();
  live.attach(late.client);
  expect(late.data.join("")).toBe("hello world");
  expect(late.notices).toEqual([]);
  live.input("ls\r");
  live.resize(5, 5000);
  expect(p.written).toEqual(["ls\r"]);
  expect(p.sizes).toEqual([[10, 1000]]);
  live.end(0, false);
  live.end(1, true);
  expect(late.notices).toEqual([{ type: "exit", code: 0, stopped: false }]);
  expect(live.running).toBe(false);
});

test("a detached page gets nothing more", () => {
  const live = new LiveTerminal(1, "codex");
  const p = fakeProc();
  live.bind(p.proc);
  const r = recorder();
  const detach = live.attach(r.client);
  p.emit("a");
  detach();
  p.emit("b");
  expect(r.data).toEqual(["a"]);
});

// --- who may attach ------------------------------------------------------------

test("only a same-origin page on a loopback host with the terminal's key attaches", () => {
  const live = new LiveTerminal(1, "claude");
  const find = (id: string) => (id === "s1" ? live : undefined);
  const url = (key: string, session = "s1") => new URL(`http://127.0.0.1:4700/ws/terminal?session=${session}&key=${key}`);
  const req = (host: string, origin?: string) => ({ headers: { host, ...(origin ? { origin } : {}) } });
  expect(terminalUpgrade(req("127.0.0.1:4700", "http://127.0.0.1:4700"), url(live.key), find)).toBe(live);
  expect(terminalUpgrade(req("localhost:4710", "http://localhost:4710"), url(live.key), find)).toBe(live);
  // Another site's page (WebSockets carry no CORS).
  expect(terminalUpgrade(req("127.0.0.1:4700", "https://evil.example"), url(live.key), find)).toBeUndefined();
  // A page that rebound its own name to 127.0.0.1.
  expect(terminalUpgrade(req("evil.example:4700", "http://evil.example:4700"), url(live.key), find)).toBeUndefined();
  expect(terminalUpgrade(req("127.0.0.1:4700", "http://127.0.0.1:4700"), url("wrong"), find)).toBeUndefined();
  expect(terminalUpgrade(req("127.0.0.1:4700", "http://127.0.0.1:4700"), url(live.key, "other"), find)).toBeUndefined();
});

// --- the Engine API exec, against a fake daemon ----------------------------------

test("execTty creates a TTY exec with the env in the body, streams both ways, resizes and reads the exit code", async () => {
  const sock = path.join(os.tmpdir(), `vt-${process.pid}-${Date.now()}.sock`);
  const seen: { create?: Record<string, unknown>; resize?: string } = {};
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/containers/verstas-s1/exec") {
        seen.create = JSON.parse(body) as Record<string, unknown>;
        res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ Id: "e1" }));
      } else if (req.method === "POST" && req.url?.startsWith("/exec/e1/resize")) {
        seen.resize = req.url;
        res.writeHead(201).end();
      } else if (req.method === "GET" && req.url === "/exec/e1/json") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ Running: false, ExitCode: 3 }));
      } else res.writeHead(404).end(JSON.stringify({ message: "no such route" }));
    });
  });
  server.on("upgrade", (req, socket: net.Socket) => {
    expect(req.url).toBe("/exec/e1/start");
    socket.write("HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n");
    socket.write("$ ");
    socket.on("data", (d) => {
      const s = d.toString();
      if (s.includes("exit")) socket.end();
      else socket.write(s.toUpperCase());
    });
  });
  await new Promise<void>((r) => server.listen(sock, r));
  try {
    const ex = await execTty(sock, { container: "verstas-s1", cmd: ["node", "/opt/verstas/terminal.js"], env: { SECRET: "x1", TERM: "xterm-256color" }, workdir: "/workspace", cols: 120, rows: 40 });
    expect(seen.create).toMatchObject({ Tty: true, AttachStdin: true, Cmd: ["node", "/opt/verstas/terminal.js"], Env: ["SECRET=x1", "TERM=xterm-256color"], WorkingDir: "/workspace", ConsoleSize: [40, 120] });
    let out = "";
    ex.stream.on("data", (d: Buffer) => (out += d.toString()));
    const closed = new Promise((r) => ex.stream.once("close", r));
    ex.stream.write("hi");
    await expect.poll(() => out).toBe("$ HI");
    await ex.resize(80, 24);
    expect(seen.resize).toBe("/exec/e1/resize?h=24&w=80");
    ex.stream.write("exit");
    await closed;
    expect(await ex.exitCode()).toBe(3);
  } finally {
    await new Promise((r) => server.close(r));
    await fs.rm(sock, { force: true });
  }
});

test("the daemon socket comes from DOCKER_HOST, else the docker context, else the default", async () => {
  const docker = (stdout: string, code = 0): DockerRunner => ({ run: async () => ({ code, stdout, stderr: "" }), spawn: () => { throw new Error("unused"); } });
  expect(await dockerSocketPath(docker("unix:///ctx.sock"), { DOCKER_HOST: "unix:///env.sock" })).toBe("/env.sock");
  await expect(dockerSocketPath(docker(""), { DOCKER_HOST: "tcp://1.2.3.4:2375" })).rejects.toThrow(/unix socket/);
  expect(await dockerSocketPath(docker("unix:///Users/me/.docker/run/docker.sock\n"), {})).toBe("/Users/me/.docker/run/docker.sock");
  expect(await dockerSocketPath(docker("", 1), {})).toBe("/var/run/docker.sock");
});

// --- the agent in the box ---------------------------------------------------------

test("the terminal wrapper starts Claude Code with the board server and the terminal rules, Codex with its model", () => {
  const job: TerminalJob = { driver: "claude", model: "claude-opus-5-5", mcpConfigFile: "/workspace/.verstas/mcp.json", rulesFile: "/workspace/.verstas/jobs/1-1-terminal/rules.md", credentialOut: "/x" };
  const args = claudeTerminalArgs(job);
  expect(args).toEqual(expect.arrayContaining(["--mcp-config", "/workspace/.verstas/mcp.json", "--append-system-prompt-file", job.rulesFile, "--model", "claude-opus-5-5", "--permission-mode", "bypassPermissions"]));
  expect(args).not.toContain("-p");
  expect(claudeTerminalArgs({ ...job, model: undefined })).not.toContain("--model");
  expect(codexTerminalArgs({ ...job, driver: "codex", model: "gpt-5.1-codex" })).toEqual(["-m", "gpt-5.1-codex"]);
  expect(codexTerminalArgs({ ...job, driver: "codex", model: undefined })).toEqual([]);
});

test("the agent in a terminal sees the planning tools but not reports, requests, halt or the lead's tools", () => {
  const names = visibleTools("terminal").map((t) => t.name);
  expect(names).toEqual(expect.arrayContaining(["board_list_tickets", "board_get_ticket", "board_create_ticket", "board_add_note", "board_set_priority", "board_add_dep", "chore", "chores_list", "chore_drop", "idea", "message"]));
  for (const hidden of ["board_report", "request", "halt", "budget", "board_claim", "board_submit", "chores_sweep", "handoff"]) expect(names).not.toContain(hidden);
});

test("the planner and a terminal's agent can create features through the board tool; unattended workers and leads cannot", () => {
  const props = (role: string) => (visibleTools(role).find((t) => t.name === "board_create_ticket")!.inputSchema as { properties: { kind: { enum: string[] }; state?: { enum: string[] } } }).properties;
  for (const role of ["planner", "terminal"]) expect(props(role).kind.enum).toEqual(["feature", "bug", "followup", "chore"]);
  for (const role of ["lead", "implementer", "reviewer"]) expect(props(role).kind.enum).toEqual(["bug", "followup", "chore"]);
  // Only the agent you are typing to may put a ticket straight into ready.
  expect(props("terminal").state?.enum).toEqual(["backlog", "ready"]);
  for (const role of ["planner", "lead", "implementer"]) expect(props(role).state).toBeUndefined();
});

test("Claude Code's onboarding is marked done once, keeping the rest of its config", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "verstas-claudejson-"));
  try {
    const file = path.join(dir, ".claude.json");
    await skipClaudeOnboarding(file);
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ hasCompletedOnboarding: true });
    await fs.writeFile(file, JSON.stringify({ machineID: "m", projects: { "/workspace": { hasTrustDialogAccepted: false } } }));
    await skipClaudeOnboarding(file);
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ machineID: "m", projects: { "/workspace": { hasTrustDialogAccepted: false } }, hasCompletedOnboarding: true });
    await fs.writeFile(file, "{ not json");
    await skipClaudeOnboarding(file);
    expect(await fs.readFile(file, "utf8")).toBe("{ not json");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("the terminal agent alone gets the tools to edit and delete tickets", () => {
  for (const name of ["board_update_ticket", "board_delete_ticket"]) {
    expect(visibleTools("terminal").map((t) => t.name)).toContain(name);
    for (const role of ["planner", "lead", "implementer", "reviewer"]) expect(visibleTools(role).map((t) => t.name)).not.toContain(name);
  }
});

const mergeBoard = () => {
  let b = importBoard(emptyBoard(), {
    tickets: [
      { id: "T-1", title: "Parser", state: "ready", pinned: true },
      { id: "T-2", title: "Parser tests", state: "ready" },
      { id: "T-3", title: "Docs", state: "backlog", deps: ["T-2"] },
      { id: "T-4", title: "Held", state: "ready" },
      { id: "T-5", title: "After both", state: "backlog", deps: ["T-1", "T-2"] },
    ],
  }).board;
  b = transition(b, "T-4", "in_progress");
  return b;
};

test("a merge: the kept ticket is edited (pinned too), the others are deleted and their dependents follow", () => {
  let b = editTicket(mergeBoard(), "T-1", { title: "Parser with tests", acceptance: ["parses", "tested"], size: "L", state: "backlog" }, "merged T-2 into it");
  const t1 = getTicket(b, "T-1");
  expect(t1).toMatchObject({ title: "Parser with tests", acceptance: ["parses", "tested"], size: "L", state: "backlog", spec: "" });
  expect(t1.notes.at(-1)?.text).toContain("merged T-2 into it");
  b = deleteTicket(b, "T-2", "merged into T-1", "T-1");
  expect(b.tickets.map((t) => t.id)).toEqual(["T-1", "T-3", "T-4", "T-5"]);
  expect(getTicket(b, "T-3").deps).toEqual(["T-1"]);
  // No duplicate dep when the dependent already had the replacement.
  expect(getTicket(b, "T-5").deps).toEqual(["T-1"]);
  expect(getTicket(b, "T-3").notes.at(-1)?.text).toContain("now depends on T-1");
  // Without a replacement the dependency just goes.
  expect(getTicket(deleteTicket(mergeBoard(), "T-2", "not needed"), "T-3").deps).toEqual([]);
});

test("edits and deletes never touch a held ticket, follow the state rules and keep deps sound", () => {
  expect(() => editTicket(mergeBoard(), "T-4", { title: "x" }, "r")).toThrow(/in_progress/);
  expect(() => deleteTicket(mergeBoard(), "T-4", "r")).toThrow(/in_progress/);
  expect(() => editTicket(mergeBoard(), "T-2", { deps: ["T-3"] }, "r")).toThrow();
  expect(() => editTicket(mergeBoard(), "T-2", { deps: ["T-99"] }, "r")).toThrow();
  expect(() => deleteTicket(mergeBoard(), "T-2", "r", "T-99")).toThrow();
});

// --- the agent API for a terminal's token ---------------------------------------------

const sessionDir = async (state: "created" | "finished" = "created") => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "verstas-term-"));
  const id = "2026-10-07-term";
  const paths = sessionPaths(root, id);
  await fs.mkdir(paths.workspace, { recursive: true });
  await fs.mkdir(paths.runs, { recursive: true });
  await writeJsonAtomic(paths.session, sessionSchema.parse({ id, name: "term", createdAt: now(), initializedAt: now(), state, repos: [{ name: "app", sourcePath: "/x", branch: "main", runBranch: `verstas/${id}` }] }));
  await saveBoard(paths.dir, importBoard(emptyBoard("g"), { tickets: [{ id: "T-1", title: "Schema", state: "ready", repo: "app" }] }).board);
  await writeJsonAtomic(paths.inbox, inboxSchema.parse({}));
  return { root, id, paths, hub: new SessionHub(root) };
};

test("a terminal's token creates features into the backlog or, when asked, ready; it is refused requests, halts and claims", async () => {
  const s = await sessionDir();
  const tokens = new RunTokens();
  const token = tokens.issue({ sessionId: s.id, runId: 1, role: "terminal" });
  const server = createAgentApi(s.hub, tokens).listen(0, "127.0.0.1");
  const port = await new Promise<number>((r) => server.on("listening", () => r((server.address() as net.AddressInfo).port)));
  const call = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}/agent${p}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  try {
    const made = await call("POST", "/tickets", { title: "Unity round trip", kind: "feature", repo: "app", size: "L", spec: "…", acceptance: ["imports"] });
    expect(made.status).toBe(201);
    expect(made.json.state).toBe("backlog");
    const t = (await s.hub.get(s.id)).board.tickets.find((x) => x.id === made.json.id);
    expect(t?.notes.at(-1)?.text).toBe("Created by the agent in your terminal");
    const ready = await call("POST", "/tickets", { title: "Ready now", kind: "feature", repo: "app", spec: "…", state: "ready" });
    expect(ready.json.state).toBe("ready");
    expect((await s.hub.get(s.id)).board.tickets.find((x) => x.id === ready.json.id)?.state).toBe("ready");
    // A worker asking for ready still files into the backlog.
    const worker = tokens.issue({ sessionId: s.id, runId: 1, role: "worker" });
    const filed = await fetch(`http://127.0.0.1:${port}/agent/tickets`, { method: "POST", headers: { authorization: `Bearer ${worker}`, "content-type": "application/json" }, body: JSON.stringify({ title: "Sneaky", kind: "bug", spec: "…", state: "ready" }) });
    expect(((await filed.json()) as { state: string }).state).toBe("backlog");
    // No unattended agent edits or deletes.
    for (const role of ["worker", "lead", "planner"] as const) {
      const other = tokens.issue({ sessionId: s.id, runId: 1, role });
      const del = await fetch(`http://127.0.0.1:${port}/agent/tickets/${made.json.id}`, { method: "DELETE", headers: { authorization: `Bearer ${other}`, "content-type": "application/json" }, body: JSON.stringify({ reason: "x" }) });
      expect(del.status).toBe(403);
      const patch = await fetch(`http://127.0.0.1:${port}/agent/tickets/${made.json.id}`, { method: "PATCH", headers: { authorization: `Bearer ${other}`, "content-type": "application/json" }, body: JSON.stringify({ title: "x", reason: "x" }) });
      expect(patch.status).toBe(403);
    }
    const edited = await call("PATCH", `/tickets/${made.json.id}`, { spec: "combined", reason: "merge" });
    expect(edited.status).toBe(200);
    expect((await call("PATCH", `/tickets/${made.json.id}`, { repo: "nope", reason: "x" })).status).toBe(400);
    expect((await call("DELETE", "/tickets/T-1", { reason: "merged", replacedBy: made.json.id })).status).toBe(200);
    expect((await s.hub.get(s.id)).board.tickets.some((x) => x.id === "T-1")).toBe(false);
    expect((await call("POST", "/requests", { summary: "need a host", actions: [] })).status).toBe(403);
    expect((await call("POST", "/halt", { reason: "x", severity: "major" })).status).toBe(403);
    expect((await call("POST", "/tickets/T-1/claim")).status).toBe(403);
  } finally {
    await new Promise((r) => server.close(r));
    await fs.rm(s.root, { recursive: true, force: true });
  }
});

// --- a terminal run --------------------------------------------------------------------

const commitShell = (): Shell & { commits: string[] } => {
  const commits: string[] = [];
  return {
    commits,
    async exec(cmd) {
      const line = cmd.join(" ");
      if (line === "git diff --cached --quiet") return { code: 1, stdout: "", stderr: "" };
      if (line.includes("commit")) commits.push(cmd[cmd.length - 1]!);
      return { code: 0, stdout: "", stderr: "" };
    },
  };
};

const noWorker: WorkerRunner = { run: async () => { throw new Error("no worker runs in a terminal"); } };

const terminalManager = async (state: "created" | "finished" = "created", opts: { credential?: boolean } = {}) => {
  const s = await sessionDir(state);
  const shell = commitShell();
  const issued: RunToken[] = [];
  const tokens = new RunTokens();
  const issue = tokens.issue.bind(tokens);
  tokens.issue = (info) => {
    issued.push(info);
    return issue(info);
  };
  const p = fakeProc();
  const opened: Parameters<TerminalRunner["open"]>[0][] = [];
  const mgr = new RunManager({
    hub: s.hub,
    tokens,
    shell: () => shell,
    worker: () => noWorker,
    ensureSandbox: async () => undefined,
    agentApiUrl: "http://x/agent",
    terminal: () => ({
      open: async (spec) => {
        opened.push(spec);
        return p.proc;
      },
    }),
    hasCredential: async () => opts.credential ?? true,
  });
  return { s, shell, issued, p, opened, mgr };
};

test("a terminal run starts the agent with a terminal token, ends on stop, commits once and leaves the session as it was", async () => {
  const t = await terminalManager("finished");
  try {
    const ctl = await t.mgr.start(t.s.id, { terminal: { driver: "claude", cols: 140, rows: 40 } });
    expect(ctl.run.terminal).toEqual({ driver: "claude" });
    const live = t.mgr.terminal(t.s.id)!;
    expect(live.key.length).toBeGreaterThan(20);
    await expect.poll(() => live.running).toBe(true);
    expect(t.opened[0]).toMatchObject({ driver: "claude", cols: 140, rows: 40 });
    expect(t.issued).toEqual([expect.objectContaining({ role: "terminal", runId: ctl.run.id })]);
    const job = JSON.parse(await fs.readFile(path.join(t.s.paths.workspace, t.opened[0]!.jobFile.replace("/workspace/", "")), "utf8")) as TerminalJob;
    expect(job.driver).toBe("claude");
    expect(await fs.readFile(path.join(t.s.paths.workspace, job.rulesFile.replace("/workspace/", "")), "utf8")).toContain("the user is at the keyboard");
    // Starting anything else ends it.
    expect(await t.mgr.endTerminal(t.s.id)).toBe(true);
    expect(t.p.killed()).toBe(true);
    const run = await ctl.done;
    expect(run.state).toBe("stopped");
    expect(t.shell.commits).toEqual([`Terminal: Claude Code (run ${run.id})`]);
    expect(t.mgr.terminal(t.s.id)).toBeUndefined();
    expect((await t.s.hub.get(t.s.id)).session.state).toBe("finished");
  } finally {
    await fs.rm(t.s.root, { recursive: true, force: true });
  }
});

test("an agent that exits finishes the run; a terminal on a driver without a credential never starts", async () => {
  const t = await terminalManager();
  try {
    const ctl = await t.mgr.start(t.s.id, { terminal: { driver: "codex" } });
    await expect.poll(() => t.opened.length).toBe(1);
    // Codex's backend joins the allowlist like a session agent's does.
    expect((await t.s.hub.get(t.s.id)).session.packs).toContain(driverInfo("codex").pack);
    t.p.exit(0);
    expect((await ctl.done).state).toBe("finished");
    expect(t.shell.commits).toEqual([`Terminal: Codex (run ${ctl.run.id})`]);
  } finally {
    await fs.rm(t.s.root, { recursive: true, force: true });
  }
  const none = await terminalManager("created", { credential: false });
  try {
    await expect(none.mgr.start(none.s.id, { terminal: { driver: "codex" } })).rejects.toThrow(/No Codex credential/);
    expect(none.mgr.status(none.s.id)).toBeUndefined();
  } finally {
    await fs.rm(none.s.root, { recursive: true, force: true });
  }
});

test("endTerminal leaves a work run alone", async () => {
  const t = await terminalManager();
  try {
    expect(await t.mgr.endTerminal(t.s.id)).toBe(true);
  } finally {
    await fs.rm(t.s.root, { recursive: true, force: true });
  }
});

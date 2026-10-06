/**
 * `verstas-board`: a stdio MCP server the worker's `claude -p` loads with
 * --mcp-config. Every tool is a thin call to the host's agent API, which
 * holds the rules (who may create what, pins, states). This file holds no
 * policy; it only shapes tool calls into HTTP and results into text.
 *
 * Hand-rolled JSON-RPC over newline-delimited stdio: the protocol surface
 * MCP needs for a tools-only server is five methods, and the image stays
 * dependency-free.
 *
 * Environment: VERSTAS_AGENT_API (e.g. http://host.docker.internal:4701/agent),
 * VERSTAS_RUN_TOKEN, and HTTP_PROXY when inside the box.
 */
import { promises as fs } from "node:fs";
import readline from "node:readline";
import { request } from "./http.js";

const API = (process.env.VERSTAS_AGENT_API ?? "").replace(/\/$/, "");
const TOKEN = process.env.VERSTAS_RUN_TOKEN ?? "";
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

type Tool = {
  name: string;
  /** Shown only to a lead (VERSTAS_ROLE=lead); a worker's ticket is moved by the harness. */
  leadOnly?: boolean;
  description: string;
  inputSchema: Record<string, unknown>;
  call: (args: Record<string, unknown>) => Promise<unknown>;
};

const str = (desc: string, max = 20_000) => ({ type: "string", description: desc, maxLength: max });
const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required, additionalProperties: false });

const api = async (method: string, path: string, json?: unknown): Promise<unknown> => {
  const res = await request(method, `${API}${path}`, { token: TOKEN, json });
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    parsed = { error: res.body.slice(0, 500) };
  }
  if (res.status >= 400) {
    const detail = (parsed as { error?: string }).error;
    throw new Error(detail ? `${detail} (HTTP ${res.status})` : `HTTP ${res.status} from the agent API: ${res.body.slice(0, 200) || "empty response"}`);
  }
  return parsed;
};

/** The worker's running totals (src/worker/worker.ts), with the caps turned into what is left. */
export const readBudget = async (file = process.env.VERSTAS_BUDGET_FILE ?? ""): Promise<unknown> => {
  if (!file) return { available: false, note: "This agent does not report a budget." };
  const raw = await fs.readFile(file, "utf8").catch(() => "");
  if (!raw) return { available: false, note: "No totals yet." };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { available: false, note: "The totals are being written; ask again." };
  }
  const b = parsed as { turns: number; seconds: number; contextTokens: number; outputTokens: number; caps: { minutes: number; turns: number; budgetUsd: number }; resumed?: boolean; control?: unknown };
  return {
    available: true,
    turns: b.turns,
    turnsLeft: Math.max(0, b.caps.turns - b.turns),
    minutes: Math.floor(b.seconds / 60),
    minutesLeft: Math.max(0, b.caps.minutes - Math.floor(b.seconds / 60)),
    contextTokens: b.contextTokens,
    outputTokens: b.outputTokens,
    budgetUsd: b.caps.budgetUsd,
    resumedConversation: Boolean(b.resumed),
    ...(b.control ? { control: b.control } : {}),
  };
};

/** How long `board_submit` waits for the verdict before it returns "still in review". */
const SUBMIT_WAIT_MS = Number(process.env.VERSTAS_SUBMIT_WAIT_MS) || 9 * 60_000;
const SUBMIT_POLL_MS = Number(process.env.VERSTAS_SUBMIT_POLL_MS) || 3_000;

type TicketView = { id: string; state: string; attempts?: number; notes?: { by: string; text: string; at: string }[] };

/** Submit, then wait for the judge: the verdict and the harness's notes since the submit. */
export const submitAndWait = async (id: string, waitMs = SUBMIT_WAIT_MS, pollMs = SUBMIT_POLL_MS): Promise<unknown> => {
  const path = `/tickets/${encodeURIComponent(id)}`;
  const before = ((await api("GET", path)) as TicketView).notes?.length ?? 0;
  await api("POST", `${path}/submit`, {});
  const until = Date.now() + waitMs;
  for (;;) {
    await new Promise((r) => setTimeout(r, pollMs));
    const t = (await api("GET", path)) as TicketView;
    if (t.state !== "review") {
      const verdict = t.state === "done" ? "accepted" : t.state === "ready" ? "not done yet: read the notes, then claim it again or leave it for later" : t.state === "blocked" ? "blocked" : t.state;
      return { id, state: t.state, verdict, attempts: t.attempts, notes: (t.notes ?? []).slice(before).filter((n) => n.by !== "agent").map((n) => n.text) };
    }
    if (Date.now() >= until) return { id, state: "review", verdict: "still in review", note: "The reviewer is still working. Call board_get_ticket on it later; do not claim another ticket until it leaves review." };
  }
};

/** How long `chores_submit` waits for the harness's verdict on a sweep. */
const SWEEP_WAIT_MS = Number(process.env.VERSTAS_SWEEP_WAIT_MS) || 20 * 60_000;

type SweepView = { state: string; n?: number; note?: string; chores?: unknown[] };

/** Submit the sweep, then wait until the harness committed or refused it. */
export const submitSweepAndWait = async (results: unknown[], waitMs = SWEEP_WAIT_MS, pollMs = SUBMIT_POLL_MS): Promise<unknown> => {
  await api("POST", "/chores/sweep/submit", { results });
  const until = Date.now() + waitMs;
  for (;;) {
    await new Promise((r) => setTimeout(r, pollMs));
    const sw = (await api("GET", "/chores/sweep")) as SweepView;
    if (sw.state === "accepted") return { sweep: sw.n, verdict: "committed", note: sw.note, chores: sw.chores };
    if (sw.state === "refused") return { sweep: sw.n, verdict: "refused: the chores are open again; read the note", note: sw.note, chores: sw.chores };
    if (sw.state === "none") return { verdict: "no sweep" };
    if (Date.now() >= until) return { sweep: sw.n, state: sw.state, verdict: "still being judged", note: "Call chores_list later; do not start another sweep or claim a ticket until it is settled." };
  }
};

/** Hand a ticket to its own agent, then wait until the harness settled it (done, back to ready, blocked or waiting). */
export const runAndWait = async (id: string, waitMs = SUBMIT_WAIT_MS * 4, pollMs = SUBMIT_POLL_MS): Promise<unknown> => {
  const path = `/tickets/${encodeURIComponent(id)}`;
  const before = ((await api("GET", path)) as TicketView).notes?.length ?? 0;
  const started = await api("POST", `${path}/run`, {});
  const until = Date.now() + waitMs;
  for (;;) {
    await new Promise((r) => setTimeout(r, pollMs));
    const t = (await api("GET", path)) as TicketView;
    if (t.state !== "in_progress" && t.state !== "review") {
      const verdict = t.state === "done" ? "accepted" : t.state === "ready" ? "not done yet: read the notes; run it again or leave it" : t.state === "waiting" ? "parked on a request to the user" : t.state;
      return { id, state: t.state, verdict, attempts: t.attempts, agent: (started as { agent?: unknown }).agent, notes: (t.notes ?? []).slice(before).filter((n) => n.by !== "agent").map((n) => n.text) };
    }
    if (Date.now() >= until) return { id, state: t.state, verdict: "still being worked by its agent", note: "Call board_get_ticket on it later; claim nothing until it is settled." };
  }
};

export const TOOLS: Tool[] = [
  {
    name: "budget",
    description:
      "Your running totals in this worker: turns used and left, minutes used and left, the size of your current context in tokens (what the model was last sent), and the dollar cap. Check it before starting something long, and when deciding whether to file your report now.",
    inputSchema: obj({}, []),
    call: () => readBudget(),
  },
  {
    name: "board_claim",
    leadOnly: true,
    description:
      "Take a ready ticket whose dependencies are done: it moves to in_progress and is yours. Hold one ticket at a time: submit it (or park it with a request) before claiming the next. Claim before you change files for it.",
    inputSchema: obj({ id: str("Ticket id", 20) }, ["id"]),
    call: (a) => api("POST", `/tickets/${encodeURIComponent(String(a.id))}/claim`, {}),
  },
  {
    name: "board_run",
    leadOnly: true,
    description:
      "Hand a ready ticket that names its own agent (board_list_tickets shows `agent`) to that agent: a fresh worker on that driver and model does the ticket in the shared working tree, then the reviewer judges it as usual. You must hold no ticket and no sweep. Waits for the verdict and returns it with the harness's notes; claim nothing meanwhile. A ticket without an agent is yours to claim.",
    inputSchema: obj({ id: str("Ticket id", 20) }, ["id"]),
    call: (a) => runAndWait(String(a.id)),
  },
  {
    name: "board_submit",
    leadOnly: true,
    description:
      "Submit the ticket you hold for judgment once its work is finished and your report is filed with board_report. The harness runs the checks and an independent reviewer, commits, and moves it to done, back to ready with notes, or to blocked. Waits for the verdict and returns it with the reviewer's notes.",
    inputSchema: obj({ id: str("Ticket id", 20) }, ["id"]),
    call: (a) => submitAndWait(String(a.id)),
  },
  {
    name: "handoff",
    leadOnly: true,
    description:
      "End this conversation and hand the work to a fresh lead, whose context starts from your note, the notes directory and the board. Use it when your context has become noise: the session has moved on from what you first read, you keep re-reading the same files, or the budget tool shows a large context. The note says what is in flight, what you tried, what you learned that is not in the notes yet, and what to do next. Then stop.",
    inputSchema: obj({ note: str("The handoff note", 20_000) }, ["note"]),
    call: (a) => api("POST", `/handoff`, { note: a.note }),
  },
  {
    name: "board_list_tickets",
    description: "List the board's tickets (id, title, state, kind, size, priority, deps, repo, and `agent` when the ticket runs on its own agent instead of the session's worker). Optionally filter by state.",
    inputSchema: obj({ state: { type: "string", enum: ["backlog", "ready", "in_progress", "review", "waiting", "blocked", "done"] } }, []),
    call: (a) => api("GET", `/board${a.state ? `?state=${encodeURIComponent(String(a.state))}` : ""}`),
  },
  {
    name: "board_get_ticket",
    description: "Get one ticket in full: spec, acceptance criteria, notes, report.",
    inputSchema: obj({ id: str("Ticket id, e.g. T-12", 20) }, ["id"]),
    call: (a) => api("GET", `/tickets/${encodeURIComponent(String(a.id))}`),
  },
  {
    name: "board_add_note",
    description: "Append a note to a ticket: progress, a finding, a question for the reviewer. Notes are kept with the ticket.",
    inputSchema: obj({ id: str("Ticket id", 20), text: str("The note") }, ["id", "text"]),
    call: (a) => api("POST", `/tickets/${encodeURIComponent(String(a.id))}/notes`, { text: a.text }),
  },
  {
    name: "board_report",
    description:
      "File your final report for the ticket you are working on: what you did, where, how you verified it, what is left. Required before you finish. Five to fifteen lines.",
    inputSchema: obj({ id: str("Ticket id", 20), report: str("The report") }, ["id", "report"]),
    call: (a) => api("POST", `/tickets/${encodeURIComponent(String(a.id))}/report`, { report: a.report }),
  },
  {
    name: "board_create_ticket",
    description:
      "Create a ticket in the backlog for work you found but must not do now: a bug, a follow-up (missing test, doc gap) or a chore. Never a feature; file features as ideas. The user approves backlog tickets before they run.",
    inputSchema: obj(
      {
        title: str("Short title", 200),
        kind: { type: "string", enum: ["bug", "followup", "chore"] },
        spec: str("What to do and where"),
        acceptance: { type: "array", items: str("One acceptance criterion", 2000), maxItems: 20 },
        size: { type: "string", enum: ["S", "M", "L"] },
        repo: str("Which clone under /workspace", 100),
        deps: { type: "array", items: str("Ticket id", 20), maxItems: 20 },
        priority: { type: "integer", minimum: 0, maximum: 1000 },
        agent: {
          type: "object",
          description: "Optional: run this ticket's implementer on another agent (driver claude | codex | cursor, model any id that CLI accepts). Only when the work needs that agent's strength; the driver must have a credential in the user's Settings.",
          properties: { driver: { type: "string", enum: ["claude", "codex", "cursor"] }, model: str("Model id", 100) },
          required: ["driver"],
          additionalProperties: false,
        },
      },
      ["title", "kind", "spec"],
    ),
    call: (a) => api("POST", `/tickets`, a),
  },
  {
    name: "chore",
    description:
      "File a small, self-contained fix that is not worth a ticket: a nit, a rename, a missing guard, a doc line, a weak test name; a few dozen changed lines at most. One line of text plus where to look. Chores are swept in batches by a lead and committed together after the repository's checks; no reviewer. A bug, anything a user would notice, or anything bigger is a ticket (board_create_ticket), not a chore.",
    inputSchema: obj({ text: str("What to change, one line", 2000), where: str("File, function or page", 500), repo: str("Which clone under /workspace, when the session has several", 100) }, ["text"]),
    call: (a) => api("POST", `/chores`, { text: a.text, where: a.where, repo: a.repo }),
  },
  {
    name: "chores_list",
    description: "The chore list: small fixes waiting for a sweep (state open), proposed ones awaiting the user, and what the last sweep did. Optionally filter by state.",
    inputSchema: obj({ state: { type: "string", enum: ["proposed", "open", "sweeping", "done", "dropped", "promoted"] } }, []),
    call: (a) => api("GET", `/chores${a.state ? `?state=${encodeURIComponent(String(a.state))}` : ""}`),
  },
  {
    name: "chores_sweep",
    leadOnly: true,
    description:
      "Take a batch of open chores to do in one go (you must hold no ticket): the given ids, or the oldest ones up to max. Returns the chores and the size limits of a sweep. Do them, run the repository's own checks yourself, then chores_submit. The batch becomes one commit without a reviewer, so stay within the limits and never touch the project's contract documents or fixtures from a sweep; make that a ticket instead.",
    inputSchema: obj({ ids: { type: "array", items: str("Chore id, e.g. C-3", 20), maxItems: 50 }, max: { type: "integer", minimum: 1, maximum: 50 } }, []),
    call: (a) => api("POST", `/chores/sweep`, { ids: a.ids, max: a.max }),
  },
  {
    name: "chores_submit",
    leadOnly: true,
    description:
      "Submit the sweep you hold: one result per chore, outcome done (note: what changed), dropped (note: why) or promoted (note: what the ticket should say; a backlog ticket is created). A chore you leave out goes back to the list. The harness runs the checks and the size check, commits the batch as one commit or refuses it (the changes stay in the working tree; split them into a ticket or revert them), and returns the verdict.",
    inputSchema: obj(
      {
        results: {
          type: "array",
          maxItems: 50,
          items: obj({ id: str("Chore id", 20), outcome: { type: "string", enum: ["done", "dropped", "promoted"] }, note: str("One line", 2000) }, ["id", "outcome"]),
        },
      },
      ["results"],
    ),
    call: (a) => submitSweepAndWait((a.results as unknown[]) ?? []),
  },
  {
    name: "board_set_priority",
    description: "Change a ticket's priority (lower runs first) with a reason. Pinned tickets cannot be changed.",
    inputSchema: obj({ id: str("Ticket id", 20), priority: { type: "integer", minimum: 0, maximum: 1000 }, reason: str("Why", 2000) }, ["id", "priority", "reason"]),
    call: (a) => api("POST", `/tickets/${encodeURIComponent(String(a.id))}/priority`, { priority: a.priority, reason: a.reason }),
  },
  {
    name: "board_add_dep",
    description: "Declare that a ticket depends on another one, with a reason. Pinned tickets cannot be changed; cycles are rejected.",
    inputSchema: obj({ id: str("Ticket id", 20), dep: str("Ticket id it depends on", 20), reason: str("Why", 2000) }, ["id", "dep", "reason"]),
    call: (a) => api("POST", `/tickets/${encodeURIComponent(String(a.id))}/deps`, { dep: a.dep, reason: a.reason }),
  },
  {
    name: "request",
    description:
      "For what you cannot do yourself (you have sudo: install packages yourself). Ask the user for everything you need right now in ONE request, then STOP working on the ticket. Give a summary (what you need and why) and a list of actions. Kinds Verstas performs on approval: 'network' (a host to allow), 'pack' (a named bundle of hosts for a toolchain, e.g. 'playwright'; listed in /workspace/VERSTAS.md), 'resources' (more minutes/turns/memory). Kinds the user performs or answers: 'instruction' (something only a person can do), 'question' (a decision; offer options). Ask questions rarely: if a sensible choice exists, make it, note the assumption, and continue. The ticket parks until every action is decided; the next worker gets the outcomes.",
    inputSchema: obj(
      {
        summary: str("What you need and why, for the user. One paragraph.", 8000),
        actions: {
          type: "array",
          maxItems: 20,
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["network", "pack", "resources", "instruction", "question"] },
              host: str("network: hostname or *.suffix", 253),
              pack: str("pack: the pack name, e.g. playwright", 40),
              port: { type: "integer", minimum: 1, maximum: 65535 },
              workerMinutes: { type: "integer", minimum: 1, maximum: 600 },
              workerTurns: { type: "integer", minimum: 1, maximum: 500 },
              memoryMb: { type: "integer", minimum: 256, maximum: 65536 },
              text: str("instruction or question: the text", 5000),
              options: { type: "array", items: str("question: an option", 200), maxItems: 8 },
            },
            required: ["kind"],
          },
        },
      },
      ["summary"],
    ),
    call: (a) => api("POST", `/requests`, { summary: a.summary, actions: a.actions ?? [] }),
  },
  {
    name: "halt",
    description: "Stop the whole run after you finish, for a problem that makes continuing pointless or harmful: a security issue, a contradiction that invalidates several tickets, a dependency that cannot be met. Not for ordinary needs; use request for those. Then stop and reply with what you found.",
    inputSchema: obj({ reason: str("What is wrong", 5000), severity: { type: "string", enum: ["major", "critical"] } }, ["reason", "severity"]),
    call: (a) => api("POST", `/halt`, { reason: a.reason, severity: a.severity }),
  },
  {
    name: "message",
    description: "Tell the user something that needs no answer: an observation about the codebase, a warning, a suggestion for the process. Nothing waits on it.",
    inputSchema: obj({ text: str("The message", 10_000) }, ["text"]),
    call: (a) => api("POST", `/messages`, { text: a.text }),
  },
  {
    name: "idea",
    description: "Pitch a feature idea to the user: what the current work makes possible and why it would be valuable. Ideas are kept in a list; the user may turn one into a ticket. Do not implement it.",
    inputSchema: obj({ title: str("Short title", 200), pitch: str("Two to six sentences", 10_000) }, ["title", "pitch"]),
    call: (a) => api("POST", `/ideas`, { title: a.title, pitch: a.pitch }),
  },
];

// --- JSON-RPC over stdio ----------------------------------------------------

type Rpc = { jsonrpc: "2.0"; id?: number | string | null; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code: number; message: string } };

const send = (msg: Rpc): void => {
  process.stdout.write(JSON.stringify(msg) + "\n");
};
const reply = (id: Rpc["id"], result: unknown): void => send({ jsonrpc: "2.0", id, result });
const fail = (id: Rpc["id"], code: number, message: string): void => send({ jsonrpc: "2.0", id, error: { code, message } });

/** The tools for this worker's role: a lead also drives the board. */
export const visibleTools = (role = process.env.VERSTAS_ROLE ?? ""): Tool[] => TOOLS.filter((t) => !t.leadOnly || role === "lead");

export const handle = async (msg: Rpc): Promise<void> => {
  const { id, method, params = {} } = msg;
  if (!method) return;
  if (method === "initialize") {
    const asked = String(params.protocolVersion ?? "");
    reply(id, {
      protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
      capabilities: { tools: {} },
      serverInfo: { name: "verstas-board", version: "0.1.0" },
    });
    return;
  }
  if (method === "notifications/initialized" || method.startsWith("notifications/")) return;
  if (method === "ping") return reply(id, {});
  if (method === "tools/list") {
    return reply(id, { tools: visibleTools().map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
  }
  if (method === "tools/call") {
    const name = String(params.name ?? "");
    const tool = visibleTools().find((t) => t.name === name);
    if (!tool) return fail(id, -32602, `Unknown tool ${name}`);
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    try {
      const result = await tool.call(args);
      return reply(id, { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }] });
    } catch (e) {
      // Tool errors go back as results with isError so the model can read them and adapt.
      return reply(id, { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true });
    }
  }
  if (id !== undefined) fail(id, -32601, `Method not found: ${method}`);
};

export const main = (): void => {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg: Rpc;
    try {
      msg = JSON.parse(line) as Rpc;
    } catch {
      return fail(null, -32700, "Parse error");
    }
    void handle(msg);
  });
  rl.on("close", () => process.exit(0));
};

if (process.argv[1] && /mcp-server\.(?:[cm]?js|ts)$/.test(process.argv[1])) main();

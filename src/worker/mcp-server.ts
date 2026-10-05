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
  const b = JSON.parse(raw) as { turns: number; seconds: number; contextTokens: number; outputTokens: number; caps: { minutes: number; turns: number; budgetUsd: number }; resumed?: boolean; control?: unknown };
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

export const TOOLS: Tool[] = [
  {
    name: "budget",
    description:
      "Your running totals in this worker: turns used and left, minutes used and left, the size of your current context in tokens (what the model was last sent), and the dollar cap. Check it before starting something long, and when deciding whether to file your report now.",
    inputSchema: obj({}, []),
    call: () => readBudget(),
  },
  {
    name: "board_list_tickets",
    description: "List the board's tickets (id, title, state, kind, size, priority, deps, repo). Optionally filter by state.",
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
      },
      ["title", "kind", "spec"],
    ),
    call: (a) => api("POST", `/tickets`, a),
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
    return reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
  }
  if (method === "tools/call") {
    const name = String(params.name ?? "");
    const tool = TOOLS.find((t) => t.name === name);
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

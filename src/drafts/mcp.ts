import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { DraftError } from "./draft.js";
import type { DraftTool } from "./tools.js";

/**
 * The draft MCP server: JSON-RPC 2.0 for a tools-only server, served over
 * MCP's Streamable HTTP transport at `POST /mcp` on the UI port (loopback),
 * and over stdio by mcp-stdio.ts, which forwards to the same endpoint.
 *
 * Hand-rolled like the worker's board server (src/worker/mcp-server.ts):
 * initialize, ping, tools/list, tools/call and notifications are all a
 * tools-only server needs. The two are kept apart on purpose: the worker's
 * copy is mounted into session containers on its own and must not import
 * anything outside src/worker.
 *
 * Responses are plain JSON (the transport allows it); there is no
 * server-to-client stream, so GET answers 405.
 */

export const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

type RpcId = number | string | null;
export type RpcMessage = { jsonrpc: "2.0"; id?: RpcId; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code: number; message: string } };

export type McpServerInfo = { name: string; version: string; instructions: string };

const errorText = (e: unknown): string => {
  if (e instanceof DraftError) return e.message;
  if (e instanceof z.ZodError) return `Invalid input: ${e.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`;
  return (e as Error).message ?? String(e);
};

/** One message in, one response out (null for notifications). */
export const createMcpHandler = (info: McpServerInfo, tools: readonly DraftTool[]) => {
  const reply = (id: RpcId | undefined, result: unknown): RpcMessage => ({ jsonrpc: "2.0", id: id ?? null, result });
  const fail = (id: RpcId | undefined, code: number, message: string): RpcMessage => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

  return async (raw: unknown): Promise<RpcMessage | null> => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail(null, -32600, "Invalid request");
    const msg = raw as RpcMessage;
    const { id, method } = msg;
    const params = (msg.params && typeof msg.params === "object" ? msg.params : {}) as Record<string, unknown>;
    if (typeof method !== "string") return id === undefined ? null : fail(id, -32600, "Invalid request: no method");
    if (method.startsWith("notifications/")) return null;
    if (method === "initialize") {
      const asked = String(params.protocolVersion ?? "");
      return reply(id, {
        protocolVersion: MCP_PROTOCOL_VERSIONS.includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: info.name, version: info.version },
        instructions: info.instructions,
      });
    }
    if (method === "ping") return reply(id, {});
    if (method === "tools/list") return reply(id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    if (method === "tools/call") {
      const name = String(params.name ?? "");
      const tool = tools.find((t) => t.name === name);
      if (!tool) return fail(id, -32602, `Unknown tool ${name}`);
      const args = (params.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Record<string, unknown>;
      try {
        const result = await tool.call(args);
        return reply(id, { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }] });
      } catch (e) {
        // Tool errors are results the model reads and adapts to, not protocol errors.
        return reply(id, { content: [{ type: "text", text: `Error: ${errorText(e)}` }], isError: true });
      }
    }
    return id === undefined ? null : fail(id, -32601, `Method not found: ${method}`);
  };
};

const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/i;
const LOOPBACK_NAMES = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** An Origin header naming this machine; "null" (sandboxed frames, files) is not one. */
const isLoopbackOrigin = (origin: string): boolean => {
  try {
    return LOOPBACK_NAMES.has(new URL(origin).hostname);
  } catch {
    return false;
  }
};

/**
 * The endpoint answers only requests addressed to this machine by a
 * loopback name, and only browsers on a loopback origin. The port binds to
 * 127.0.0.1 already; these two checks close DNS rebinding (a page on
 * another site that resolves its own name to 127.0.0.1 still sends its own
 * Host and Origin), which MCP's HTTP transport asks servers to handle.
 */
export const loopbackOnly = (req: Request, res: Response, next: NextFunction): void => {
  const host = req.headers.host ?? "";
  if (!LOOPBACK_HOST.test(host)) {
    res.status(403).json({ error: "The draft MCP endpoint answers loopback hosts only" });
    return;
  }
  const origin = req.headers.origin;
  if (origin !== undefined && !isLoopbackOrigin(origin)) {
    res.status(403).json({ error: "Cross-origin requests to the draft MCP endpoint are refused" });
    return;
  }
  next();
};

/** Streamable HTTP: POST a message or a batch, get JSON back; 202 when everything was a notification. */
export const createMcpRouter = (handle: (msg: unknown) => Promise<RpcMessage | null>): express.Router => {
  const router = express.Router();
  router.use(loopbackOnly);
  router.post(
    "/",
    express.json({ limit: "4mb", type: () => true }),
    (req: Request, res: Response, next: NextFunction) => {
      void (async () => {
        const body: unknown = req.body;
        if (Array.isArray(body)) {
          if (!body.length) {
            res.status(400).json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Empty batch" } });
            return;
          }
          const out = (await Promise.all(body.map(handle))).filter((m): m is RpcMessage => m !== null);
          if (!out.length) res.status(202).end();
          else res.json(out);
          return;
        }
        const out = await handle(body);
        if (!out) res.status(202).end();
        else res.json(out);
      })().catch(next);
    },
  );
  router.all("/", (_req, res) => {
    res.status(405).set("Allow", "POST").json({ error: "POST JSON-RPC messages to this endpoint; there is no event stream" });
  });
  // Body parse errors become JSON-RPC parse errors, not Express's HTML page.
  router.use((err: Error & { type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    if (err.type === "entity.parse.failed") {
      res.status(400).json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    console.error("[mcp] internal error:", err);
    res.status(500).json({ jsonrpc: "2.0", id: null, error: { code: -32603, message: err.message } });
  });
  return router;
};

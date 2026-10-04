/**
 * `npm run mcp`: the draft MCP server over stdio, for clients that start a
 * command instead of connecting to a URL (Claude Desktop's config file).
 * It holds no logic: each line from stdin is POSTed to the running host
 * app's `/mcp` endpoint and the answer is written back as one line. The
 * host app is the only writer of drafts, so the app's pages update live
 * while an assistant edits.
 *
 * VERSTAS_URL overrides the address (default http://127.0.0.1:<uiPort> from
 * ~/.verstas/config.json).
 */
import readline from "node:readline";
import { loadConfig } from "../config.js";

type Rpc = { jsonrpc?: string; id?: number | string | null; method?: string };

const write = (msg: unknown): void => {
  process.stdout.write(JSON.stringify(msg) + "\n");
};

export const endpoint = async (): Promise<string> => {
  const base = process.env.VERSTAS_URL?.replace(/\/$/, "") ?? `http://127.0.0.1:${(await loadConfig()).uiPort}`;
  return `${base}/mcp`;
};

/** Forwards one line; a request (with an id) always gets an answer, even when Verstas is down. */
export const forward = async (url: string, line: string): Promise<void> => {
  let parsed: Rpc | Rpc[];
  try {
    parsed = JSON.parse(line) as Rpc | Rpc[];
  } catch {
    write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  const ids = (Array.isArray(parsed) ? parsed : [parsed]).map((m) => m?.id).filter((id) => id !== undefined);
  const failAll = (message: string) => {
    for (const id of ids) write({ jsonrpc: "2.0", id, error: { code: -32000, message } });
  };
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: line });
    if (res.status === 202) return;
    const text = await res.text();
    if (!text.trim()) return failAll(`Empty answer from ${url} (HTTP ${res.status})`);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return failAll(`Not JSON from ${url} (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }
    // A plain error object (403, 405) is not JSON-RPC; turn it into one per request.
    if (body && typeof body === "object" && !Array.isArray(body) && !("jsonrpc" in body)) return failAll(String((body as { error?: unknown }).error ?? `HTTP ${res.status}`));
    write(body);
  } catch (e) {
    failAll(`Verstas is not reachable at ${url} (${(e as Error).message}). Start it (npm start in the verstas directory) and try again.`);
  }
};

export const main = async (): Promise<void> => {
  const url = await endpoint();
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const pending = new Set<Promise<void>>();
  rl.on("line", (line) => {
    if (!line.trim()) return;
    const p = forward(url, line).finally(() => pending.delete(p));
    pending.add(p);
  });
  rl.on("close", () => {
    void Promise.allSettled([...pending]).then(() => process.exit(0));
  });
};

if (process.argv[1] && /mcp-stdio\.(?:[cm]?js|ts)$/.test(process.argv[1])) void main();

/**
 * The sandbox egress proxy. Runs inside a small container that sits on both
 * the session's internal network and the bridge, and is the only way out.
 *
 * - CONNECT host:port  -> allowed only if the allowlist says so (TLS tunnels,
 *                         port 443 unless an entry names another port).
 * - http://… requests  -> allowed only to the agent API under /agent/.
 * - everything else    -> 403 and a "denied" log line.
 *
 * Dependency-free on purpose (Node builtins only) so it can be mounted into
 * node:22-alpine as two files. See docs/SANDBOX.md, Boundary 3.
 *
 * Environment:
 *   ALLOWLIST_FILE     JSON array of entries; re-read when its mtime changes
 *   VERSTAS_AGENT_API  "host:port" of the agent API (plain http target)
 *   PORT               listen port (default 3128)
 */
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import {
  decideConnect,
  decideHttp,
  parseAgentApiTarget,
  parseAllowlist,
  type AllowEntry,
} from "./allowlist.js";

const PORT = Number(process.env.PORT ?? 3128);
const ALLOWLIST_FILE = process.env.ALLOWLIST_FILE ?? "/allowlist.json";
const AGENT_API = parseAgentApiTarget(process.env.VERSTAS_AGENT_API);
const MAX_TUNNELS = 256;
const IDLE_MS = 120_000;
const RELOAD_POLL_MS = 2_000;

let allowlist: AllowEntry[] = [];
let lastMtime = -1;
let tunnels = 0;

const log = (record: Record<string, unknown>) => {
  process.stdout.write(JSON.stringify({ t: new Date().toISOString(), ...record }) + "\n");
};

const reload = () => {
  try {
    const st = fs.statSync(ALLOWLIST_FILE);
    if (st.mtimeMs === lastMtime) return;
    lastMtime = st.mtimeMs;
    const raw: unknown = JSON.parse(fs.readFileSync(ALLOWLIST_FILE, "utf8"));
    if (!Array.isArray(raw) || !raw.every((x) => typeof x === "string")) throw new Error("not a string array");
    allowlist = parseAllowlist(raw as string[]);
    log({ kind: "allowlist", entries: allowlist.length });
  } catch (e) {
    // Fail closed: an unreadable list means an empty list.
    allowlist = [];
    log({ kind: "allowlist_error", error: String((e as Error).message ?? e) });
  }
};

reload();
setInterval(reload, RELOAD_POLL_MS).unref();

const server = http.createServer((req, res) => {
  req.socket.on("error", (e) => log({ kind: "client_error", error: e.message }));
  const url = req.url ?? "";
  const decision = decideHttp(AGENT_API, url);
  if (!decision.allow) {
    log({ kind: "denied", method: req.method, url: url.slice(0, 200), reason: decision.reason });
    res.writeHead(403, { "content-type": "text/plain" }).end(`verstas proxy: ${decision.reason}\n`);
    return;
  }
  const target = new URL(url);
  const headers = { ...req.headers };
  delete headers["proxy-connection"];
  delete headers["proxy-authorization"];
  const upstream = http.request(
    {
      host: target.hostname,
      port: target.port ? Number(target.port) : 80,
      method: req.method,
      path: target.pathname + target.search,
      headers,
    },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.setTimeout(IDLE_MS, () => upstream.destroy(new Error("upstream timeout")));
  upstream.on("error", (e) => {
    log({ kind: "upstream_error", url: url.slice(0, 200), error: e.message });
    if (!res.headersSent) res.writeHead(502).end();
    else res.destroy();
  });
  req.pipe(upstream);
});

server.on("connect", (req, socketRaw, head) => {
  const socket = socketRaw as net.Socket;
  // A client may reset the connection at any point (curl does, right after a
  // 403). Without a listener that is an unhandled 'error' and the process
  // dies, taking the whole session's egress with it.
  socket.on("error", (e) => log({ kind: "client_error", error: e.message }));
  const [hostRaw = "", portRaw = ""] = (req.url ?? "").split(":");
  const port = Number(portRaw);
  const decision = Number.isInteger(port) ? decideConnect(allowlist, hostRaw, port) : { allow: false as const, reason: "bad port" };
  if (!decision.allow) {
    log({ kind: "denied", method: "CONNECT", host: hostRaw.slice(0, 200), port, reason: decision.reason });
    socket.end("HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\nverstas proxy: " + decision.reason + "\n");
    return;
  }
  if (tunnels >= MAX_TUNNELS) {
    log({ kind: "denied", method: "CONNECT", host: hostRaw, port, reason: "too many tunnels" });
    socket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n");
    return;
  }
  tunnels++;
  const upstream = net.connect(port, hostRaw, () => {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  const done = () => {
    tunnels--;
    upstream.destroy();
    socket.destroy();
  };
  upstream.setTimeout(IDLE_MS, done);
  socket.setTimeout(IDLE_MS, done);
  upstream.on("error", (e) => {
    log({ kind: "upstream_error", host: hostRaw, port, error: e.message });
    socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    done();
  });
  upstream.on("close", done);
  socket.on("error", done);
  socket.on("close", done);
  log({ kind: "allowed", host: hostRaw, port });
});

server.on("clientError", (_e, socket) => {
  socket.on("error", () => undefined);
  socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

// Last line of defence: a proxy must keep serving. Log and carry on.
process.on("uncaughtException", (e) => log({ kind: "uncaught", error: e.message, stack: String(e.stack).slice(0, 500) }));
process.on("unhandledRejection", (e) => log({ kind: "unhandled_rejection", error: String(e) }));

server.listen(PORT, "0.0.0.0", () => {
  log({ kind: "listening", port: PORT, agentApi: AGENT_API ? `${AGENT_API.host}:${AGENT_API.port}` : null });
});

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}

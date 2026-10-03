import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { createAgentApi, RunTokens } from "./agent-api/agent-api.js";
import { loadConfig, loadSecrets, saveConfig, type Config } from "./config.js";
import { createDockerRunManager, proxyDistPath } from "./harness/docker-worker.js";
import { createDockerRunner } from "./sandbox/docker.js";
import type { SandboxConfig } from "./sandbox/lifecycle.js";
import { SessionHub } from "./sessions/hub.js";
import { createUiApi } from "./web/api.js";

/**
 * Entrypoint. Two HTTP servers:
 *   127.0.0.1:4700  the UI and its API (you)
 *   0.0.0.0:4701    the agent API (workers, through the proxy, with a run token)
 * and one WebSocket on the UI server that streams board changes and run events.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
/** Works from dist/src/main.js and from src/main.ts under tsx: walk up to the package root. */
const findRepoRoot = async (from: string): Promise<string> => {
  let dir = from;
  for (let i = 0; i < 6; i++) {
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8")) as { name?: string };
      if (pkg.name === "verstas") return dir;
    } catch {
      // keep walking
    }
    dir = path.dirname(dir);
  }
  throw new Error("Cannot find the verstas package root");
};
const repoRoot = await findRepoRoot(here);
const distRoot = path.join(repoRoot, "dist");
const version = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8")).version as string;

let config: Config = await loadConfig();
await fs.mkdir(config.sessionsRoot, { recursive: true });

/** One line per API request on both servers; set VERSTAS_QUIET=1 to turn it off. */
const requestLog = (tag: string): express.RequestHandler => (req, res, next) => {
  if (process.env.VERSTAS_QUIET) return next();
  const t0 = Date.now();
  res.on("finish", () => {
    if (req.path === "/status" && res.statusCode < 400) return; // the UI polls this
    console.log(`[${tag}] ${res.statusCode} ${req.method} ${req.originalUrl} ${Date.now() - t0}ms`);
  });
  next();
};

const docker = createDockerRunner();
const sandbox: SandboxConfig = {
  docker,
  proxyDistHostPath: proxyDistPath(distRoot),
  agentApiPort: config.agentApiPort,
  linuxHost: config.linuxHost,
};
const hub = new SessionHub(config.sessionsRoot);
const tokens = new RunTokens();
const agentApiUrl = `http://host.docker.internal:${config.agentApiPort}/agent`;
const runConfig = {
  hub,
  tokens,
  sandbox,
  agentApiUrl,
  claudeToken: async () => (await loadSecrets()).claudeToken,
};
const runs = createDockerRunManager(runConfig);

// Agent API: all interfaces, token-protected, path-restricted by the proxy.
const agentApp = express();
agentApp.use(requestLog("agent"));
agentApp.use(createAgentApi(hub, tokens));
agentApp.listen(config.agentApiPort, "0.0.0.0", () => {
  console.log(`agent api  http://0.0.0.0:${config.agentApiPort}/agent`);
});

// UI API + static UI + WebSocket, loopback only.
const uiApp = express();
uiApp.use("/api", requestLog("ui"));
uiApp.use(createUiApi({
  hub,
  runs,
  runConfig,
  sandbox,
  getConfig: () => config,
  setConfig: async (c) => {
    config = c;
    await saveConfig(c);
    if (c.sessionsRoot !== hub.root) console.log("sessions root changed; restart verstas to use it");
  },
  version,
}));
const webDist = path.join(repoRoot, "web", "dist");
uiApp.use(express.static(webDist));
uiApp.get(/^\/(?!api\/).*/, (_req, res) => {
  res.sendFile(path.join(webDist, "index.html"), (err) => {
    if (err) res.status(200).type("text/plain").send("Verstas API is up. Build the UI with `npm run web:build` to get the web app here.\n");
  });
});

const server = createServer(uiApp);
const wss = new WebSocketServer({ server, path: "/ws" });
const broadcast = (msg: unknown) => {
  const data = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(data);
};
hub.on("change", (c) => broadcast({ type: "change", ...c }));
hub.on("event", (e) => {
  broadcast({ type: "event", ...e });
  const ev = e.event;
  if (!process.env.VERSTAS_QUIET && ev.kind !== "cost" && ev.kind !== "tool_result") {
    const text = "text" in ev ? ev.text : "summary" in ev ? `${"tool" in ev ? ev.tool + " " : ""}${ev.summary}` : "state" in ev ? `${ev.state}${"reason" in ev && ev.reason ? ` (${ev.reason})` : ""}` : "";
    console.log(`[run ${e.sessionId}#${e.runId}] ${ev.kind}${"ticket" in ev && ev.ticket ? ` ${ev.ticket}` : ""} ${String(text).slice(0, 160)}`);
  }
});

server.listen(config.uiPort, "127.0.0.1", () => {
  console.log(`verstas ${version}  http://127.0.0.1:${config.uiPort}  sessions in ${config.sessionsRoot}`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log("stopping; active runs are stopped and their tickets requeued");
    server.close();
    setTimeout(() => process.exit(0), 1500).unref();
  });
}

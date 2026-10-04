import { createServer, type Server } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { createAgentApi, RunTokens } from "./agent-api/agent-api.js";
import { loadConfig, loadSecrets, saveConfig, type Config } from "./config.js";
import { createDockerRunManager, proxyDistPath, workerDistPath } from "./harness/docker-worker.js";
import { createDockerRunner } from "./sandbox/docker.js";
import type { SandboxConfig } from "./sandbox/lifecycle.js";
import { SessionHub } from "./sessions/hub.js";
import { listSessions } from "./sessions/sessions.js";
import { createUiApi } from "./web/api.js";
import { RemoteClient } from "./remote/client.js";
import { requestJson } from "./remote/http.js";
import { DraftStore, type DraftChange } from "./drafts/store.js";
import { createDraftTools, DRAFT_SERVER_INSTRUCTIONS } from "./drafts/tools.js";
import { createMcpHandler, createMcpRouter } from "./drafts/mcp.js";
import { buildContext, probeImage } from "./context/context.js";
import { listScripts } from "./scripts/library.js";
import { listBranches } from "./sessions/workspace.js";
import { detectPacksInRepo } from "./network/packs.js";
import { mcpSetup } from "./drafts/setup.js";

/**
 * The host app as a function, so the command line (src/main.ts) and the
 * desktop window (electron/main.mjs) start the same thing. Two HTTP servers:
 *   127.0.0.1:4700  the UI and its API (you)
 *   0.0.0.0:4701    the agent API (workers, through the proxy, with a run token)
 * and one WebSocket on the UI server that streams board changes and run events.
 */

export type Verstas = {
  /** The UI's address, e.g. http://127.0.0.1:4700. */
  url: string;
  version: string;
  /** Stops runs (their tickets are requeued), says goodbye to the remote dashboard, closes the servers. */
  stop: () => Promise<void>;
};

/** Resolves once both servers listen; rejects if a port is taken. */
export const startVerstas = async (): Promise<Verstas> => {
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
    workerDistHostPath: workerDistPath(distRoot),
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
  const listenAgent = () => new Promise<Server>((resolve, reject) => {
    const s = agentApp.listen(config.agentApiPort, "0.0.0.0", () => {
      s.off("error", reject);
      console.log(`agent api  http://0.0.0.0:${config.agentApiPort}/agent`);
      resolve(s);
    });
    s.once("error", reject);
  });

  // Remote dashboard: outbound only. Your actions arrive as commands and are
  // carried out through this process's own UI API on the loopback address.
  const remote = new RemoteClient({
    hub,
    runs,
    listSessionIds: async () => (await listSessions(config.sessionsRoot)).map((s) => s.id),
    getConfig: () => config,
    getToken: async () => (await loadSecrets()).remoteToken,
    localApi: (call) => requestJson(`http://127.0.0.1:${config.uiPort}/api${call.path}`, { method: call.method, body: call.body, timeoutMs: 120_000 }),
    version,
    log: (m) => console.log(m),
  });

  // Drafts: prepared by an assistant through /mcp, reviewed and turned into a
  // session by you in the UI. One store, so both see the same files.
  const drafts = new DraftStore();
  const uiUrl = process.env.VERSTAS_UI_URL?.replace(/\/$/, "") ?? `http://127.0.0.1:${config.uiPort}`;
  const draftTools = createDraftTools({
    store: drafts,
    workTargets: () => config.workTargets,
    recipes: () => listScripts(),
    branches: listBranches,
    detectPacks: detectPacksInRepo,
    context: async () => {
      const facts = await probeImage(docker, config.devboxImage).catch(() => null);
      return buildContext({ tail: "draft", config, facts, scripts: await listScripts(), repoNames: config.workTargets.map((w) => w.name) });
    },
    reviewUrl: (id) => `${uiUrl}/#/d/${encodeURIComponent(id)}`,
  });
  const mcp = createMcpRouter(createMcpHandler({ name: "verstas-drafts", version, instructions: DRAFT_SERVER_INSTRUCTIONS }, draftTools));

  // UI API + static UI + WebSocket + the draft MCP endpoint, loopback only.
  const uiApp = express();
  uiApp.use("/api", requestLog("ui"));
  uiApp.use("/mcp", requestLog("mcp"), mcp);
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
    remote,
    drafts,
    mcpSetup: async () => {
      const stdioScript = path.join(distRoot, "src", "drafts", "mcp-stdio.js");
      const stdioBuilt = await fs.access(stdioScript).then(() => true, () => false);
      return mcpSetup({
        url: `http://127.0.0.1:${config.uiPort}/mcp`,
        stdioScript,
        stdioBuilt,
        // Inside the desktop app, process.execPath is Electron; it runs scripts as Node with ELECTRON_RUN_AS_NODE.
        node: { command: process.execPath, electron: Boolean(process.versions.electron) },
      });
    },
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
  // It re-emits the HTTP server's errors; a taken port is reported by the listen below.
  wss.on("error", () => undefined);
  const broadcast = (msg: unknown) => {
    const data = JSON.stringify(msg);
    for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(data);
  };
  hub.on("change", (c) => broadcast({ type: "change", ...c }));
  drafts.on("change", (c: DraftChange) => broadcast({ type: "draft", draftId: c.draftId, deleted: c.deleted ?? false }));
  hub.on("event", (e) => {
    broadcast({ type: "event", ...e });
    const ev = e.event;
    const debug = Boolean(process.env.VERSTAS_DEBUG);
    if (!process.env.VERSTAS_QUIET && ev.kind !== "cost" && (debug || ev.kind !== "tool_result")) {
      const text = "text" in ev ? ev.text : "summary" in ev ? `${"tool" in ev ? ev.tool + " " : ""}${"ok" in ev && !ev.ok ? "FAILED " : ""}${ev.summary}` : "state" in ev ? `${ev.state}${"reason" in ev && ev.reason ? ` (${ev.reason})` : ""}` : "";
      console.log(`[run ${e.sessionId}#${e.runId}] ${ev.kind}${"ticket" in ev && ev.ticket ? ` ${ev.ticket}` : ""} ${debug ? String(text) : String(text).slice(0, 160)}`);
    }
  });


  // The UI port first: if it is taken, another Verstas is running and this
  // one must not touch its workers, so nothing below runs.
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.uiPort, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const agentServer = await listenAgent().catch(async (e: Error) => {
    await closeServer(server);
    throw e;
  });

  // A previous host process may have died with workers still running in their
  // containers and tickets still held. Clean that up before anything starts.
  for (const s of await listSessions(config.sessionsRoot)) {
    const did = await runs.recover(s.id).catch((e: Error) => [`recovery failed: ${e.message}`]);
    if (did.length) console.log(`[recover ${s.id}] ${did.join("; ")}`);
  }

  void remote.apply().then(() => {
    const st = remote.status();
    if (st.state !== "off") console.log(`remote dashboard ${config.remote.baseUrl}: ${st.state}${st.error ? ` (${st.error})` : ""}`);
  });
  const url = `http://127.0.0.1:${config.uiPort}`;
  console.log(`draft mcp  ${url}/mcp`);
  console.log(`verstas ${version}  ${url}  sessions in ${config.sessionsRoot}${process.env.VERSTAS_DEBUG ? "  [debug: docker commands, raw worker streams, full tool output]" : ""}`);

  let stopped: Promise<void> | null = null;
  const stop = () =>
    (stopped ??= (async () => {
      console.log("stopping; active runs are stopped and their tickets requeued");
      // Tell the dashboard first: it shows "not running" at once instead of in 45 s.
      await remote.stop().catch(() => undefined);
      await runs.stopAll();
      for (const c of wss.clients) c.terminate();
      await Promise.all([closeServer(server), closeServer(agentServer)]);
    })());
  return { url, version, stop };
};

const closeServer = (s: Server) =>
  new Promise<void>((resolve) => {
    s.close(() => resolve());
    s.closeAllConnections?.();
  });

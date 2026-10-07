import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import os from "node:os";
import express, { type Request, type Response } from "express";
import { z } from "zod";
import {
  agentFor,
  agentSpecSchema,
  reviewModeSchema,
  capsSchema,
  choreIdSchema,
  sessionModeSchema,
  DEFAULT_ALLOWLIST,
  DRIVER_NAMES,
  driverNameSchema,
  isInitialized,
  limitsSchema,
  sessionAgentsSchema,
  setupModeSchema,
  now,
  ticketIdSchema,
  ticketImportSchema,
  ticketKindSchema,
  ticketSizeSchema,
  ticketStateSchema,
  type AgentRequest,
  type RequestAction,
  type Inbox,
  type Run,
  type Session,
  type SessionSetupScript,
  type Ticket,
} from "../core/types.js";
import { emptyBoard, addChore, addNote, BoardError, exportBoard, getTicket, importBoard, parseBoardPaste, promoteChore, replaceTicket, setChoreState, transition, validateDeps, validateRepos, canTransition } from "../board/board.js";
import { codexAuthRefreshedAt, configSchema, loadConfig, loadSecrets, saveConfig, saveSecrets, verstasHome, workTargetSchema, type Config } from "../config.js";
import { codexAuthAgeDays, configuredDrivers, DRIVERS } from "../harness/drivers.js";
import type { SessionHub } from "../sessions/hub.js";
import { createSession, deleteSessionDir, listSessions, makeSessionId, provisionSession, removeClones, repoPick, RESERVED_WORKSPACE_NAMES, sessionPaths, withAgentPacks, writeRecipeFiles } from "../sessions/sessions.js";
import { applyBundle, ApplyError } from "../sessions/apply.js";
import { importArchive, readArchive, writeArchive } from "../sessions/archive.js";
import type { SessionHandle } from "../sessions/hub.js";
import { listSandboxes, removeSandbox, sandboxStatus, snapshotSandbox, stopAllSandboxes, stopSandbox, type SandboxConfig } from "../sandbox/lifecycle.js";
import { dockerAvailable } from "../sandbox/docker.js";
import type { RunManager } from "../harness/run.js";
import { dockerShell, ensureSessionSandbox, runSetup, type RunManagerConfig } from "../harness/docker-worker.js";
import { deleteScript, getScript, hostsFromScript, listScripts, saveScript, setupScriptSchema } from "../scripts/library.js";
import { buildContext, probeImage } from "../context/context.js";
import { allowlistFor, detectPacksInRepo, NETWORK_PACKS, packHosts } from "../network/packs.js";
import { allRuns, lastRun, runTotals } from "../sessions/runs.js";
import { RemoteClient } from "../remote/client.js";
import { isLoopback } from "../remote/http.js";
import { extractZip, listBranches } from "../sessions/workspace.js";
import { DraftError, draftBoardText, validateDraft, type Draft } from "../drafts/draft.js";
import type { DraftStore } from "../drafts/store.js";
import type { McpSetup } from "../drafts/setup.js";

/**
 * The UI's API, on 127.0.0.1 only. Everything the agent API refuses lives
 * here: sessions, Docker, decisions on requests, settings. No token: the
 * loopback bind is the boundary (docs/SANDBOX.md, "Host app exposure").
 */

const execFileP = promisify(execFile);

export type UiApiDeps = {
  hub: SessionHub;
  runs: RunManager;
  runConfig: RunManagerConfig;
  sandbox: SandboxConfig;
  getConfig: () => Config;
  setConfig: (c: Config) => Promise<void>;
  version: string;
  /** The remote dashboard connection; absent in tests that do not need it. */
  remote?: RemoteClient;
  /** Draft sessions (src/drafts); the same store the draft MCP endpoint writes. */
  drafts: DraftStore;
  /** How to connect an assistant to the draft MCP endpoint, with real paths. */
  mcpSetup: () => Promise<McpSetup>;
};

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response) => {
    fn(req, res).catch((e: unknown) => {
      if (e instanceof z.ZodError) {
        const msg = `Invalid input: ${e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`;
        console.warn(`[ui] 400 ${req.method} ${req.originalUrl}: ${msg}`);
        res.status(400).json({ error: msg });
      } else if (e instanceof DraftError) {
        res.status(e.code === "not_found" ? 404 : e.code === "invalid" ? 400 : 409).json({ error: e.message });
      } else if (e instanceof BoardError) {
        console.warn(`[ui] ${req.method} ${req.originalUrl}: ${e.message}`);
        res.status(e.code === "unknown_ticket" ? 404 : 409).json({ error: e.message });
      } else if (typeof (e as { status?: unknown }).status === "number") {
        res.status((e as { status: number }).status).json({ error: (e as Error).message });
      } else if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        console.warn(`[ui] 404 ${req.method} ${req.originalUrl}: ${(e as Error).message}`);
        res.status(404).json({ error: `Not found: ${(e as NodeJS.ErrnoException).path ?? ""}` });
      } else {
        console.error(`[ui] 500 ${req.method} ${req.originalUrl}:`, e);
        res.status(500).json({ error: (e as Error).message });
      }
    });
  };

const USER_STATES = ["backlog", "ready", "blocked", "done"] as const;

const param = (req: Request, key: string): string => String(req.params[key] ?? "");

/** "~/work/x" -> "/Users/me/work/x"; shells expand this, forms do not. */
const expandHome = (p: string): string => (p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p);

export const createUiApi = (d: UiApiDeps): express.Express => {
  const app = express();
  app.disable("x-powered-by");
  const api = express.Router();
  api.use(express.json({ limit: "4mb" }));

  // --- status and settings ---------------------------------------------------

  api.get(
    "/status",
    wrap(async (_req, res) => {
      const docker = await dockerAvailable(d.sandbox.docker);
      const cfg = d.getConfig();
      const image = docker.ok ? await d.sandbox.docker.run(["image", "inspect", cfg.devboxImage, "--format", "{{.Id}}"], { allowFailure: true, timeoutMs: 10_000 }) : null;
      const secrets = await loadSecrets();
      const credentials = configuredDrivers(secrets);
      const codexAge = codexAuthAgeDays(secrets);
      res.json({
        version: d.version,
        docker,
        image: image ? image.code === 0 : false,
        imageName: cfg.devboxImage,
        sessionsRoot: cfg.sessionsRoot,
        hasClaudeToken: Boolean(secrets.claudeToken),
        credentials,
        /** Every driver the UI can offer, with whether its credential is configured. */
        drivers: DRIVER_NAMES.map((name) => ({ ...DRIVERS[name], configured: credentials[name], ...(name === "codex" && codexAge !== undefined ? { codexAuthAgeDays: Math.round(codexAge * 10) / 10 } : {}) })),
      });
    }),
  );

  const codexAuthBody = z.string().min(2).max(200_000).refine((s) => {
    try {
      const j = JSON.parse(s) as Record<string, unknown>;
      return typeof j === "object" && j !== null && ("tokens" in j || "OPENAI_API_KEY" in j);
    } catch {
      return false;
    }
  }, "Not a Codex auth.json: expected JSON with a tokens object");

  /** Import Codex's login from this machine, after `codex login` (or `codex login --device-auth`) here. */
  api.post(
    "/secrets/codex/import",
    wrap(async (req, res) => {
      const body = z.object({ path: z.string().max(1000).optional() }).parse(req.body ?? {});
      const file = body.path ? expandHome(body.path) : path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "auth.json");
      const text = await fs.readFile(file, "utf8").catch((e: NodeJS.ErrnoException) => {
        throw new Error(e.code === "ENOENT" ? `No Codex login at ${file}. Run \`codex login --device-auth\` on this machine first.` : e.message);
      });
      const auth = codexAuthBody.parse(text.trim());
      if (/"OPENAI_API_KEY"\s*:\s*"[^"]+"/.test(auth) && !/"tokens"/.test(auth)) throw new Error("That Codex login is an API key, which bills per use. Log in with your ChatGPT account instead (`codex logout`, then `codex login --device-auth`).");
      await saveSecrets({ ...(await loadSecrets()), codexAuth: auth });
      res.json({ ok: true, from: file, refreshedAt: codexAuthRefreshedAt(auth)?.toISOString() });
    }),
  );

  /** Forget one credential. Sessions that need it fail at their next worker with a clear message. */
  api.delete(
    "/secrets/:driver",
    wrap(async (req, res) => {
      const driver = driverNameSchema.parse(param(req, "driver"));
      const s = { ...(await loadSecrets()) };
      delete s[DRIVERS[driver].secret];
      await saveSecrets(s);
      res.json({ ok: true });
    }),
  );

  // --- the host as a whole ---------------------------------------------------------

  /** Every active run: pause after its current ticket, or stop now (tickets go back to ready). */
  api.post(
    "/host/runs",
    wrap(async (req, res) => {
      const { action } = z.object({ action: z.enum(["pause", "stop"]) }).parse(req.body);
      const ids = d.runs.activeSessions();
      if (action === "pause") d.runs.pauseAll();
      else await d.runs.stopAll();
      res.json({ ok: true, sessions: ids });
    }),
  );

  /** Stops every session container and proxy that is not in the middle of a run; a stopped box restarts on the next run. */
  api.post(
    "/host/sandboxes",
    wrap(async (req, res) => {
      z.object({ action: z.literal("stop") }).parse(req.body);
      const active = new Set(d.runs.activeSessions());
      const stopped = await stopAllSandboxes(d.sandbox, active);
      res.json({ ok: true, stopped, skipped: [...active] });
    }),
  );

  /**
   * Quit Verstas from the UI. The process gets the same signal Ctrl-C sends,
   * so the terminal app and the desktop app take their normal shutdown path:
   * runs stop and requeue their tickets, containers stop, then the process ends.
   */
  api.post("/host/quit", (_req, res) => {
    res.json({ ok: true });
    setTimeout(() => process.kill(process.pid, "SIGTERM"), 200).unref();
  });

  api.get("/config", (_req, res) => res.json(d.getConfig()));

  api.put(
    "/config",
    wrap(async (req, res) => {
      const patch = configSchema.partial().parse(req.body);
      if (patch.sessionsRoot) patch.sessionsRoot = path.resolve(expandHome(patch.sessionsRoot));
      const next = configSchema.parse({ ...d.getConfig(), ...patch });
      await fs.mkdir(next.sessionsRoot, { recursive: true });
      await d.setConfig(next);
      res.json(next);
    }),
  );

  api.put(
    "/secrets",
    wrap(async (req, res) => {
      const body = z
        .object({
          claudeToken: z.string().min(10).max(4000).optional(),
          cursorApiKey: z.string().min(10).max(4000).optional(),
          /** The text of Codex's auth.json, pasted; the import route reads it from disk instead. */
          codexAuth: codexAuthBody.optional(),
        })
        .parse(req.body);
      if (!body.claudeToken && !body.cursorApiKey && !body.codexAuth) throw new Error("Nothing to save");
      const cur = await loadSecrets();
      await saveSecrets({
        ...cur,
        ...(body.claudeToken ? { claudeToken: body.claudeToken.trim() } : {}),
        ...(body.cursorApiKey ? { cursorApiKey: body.cursorApiKey.trim() } : {}),
        ...(body.codexAuth ? { codexAuth: body.codexAuth.trim() } : {}),
      });
      res.json({ ok: true });
    }),
  );

  // --- remote dashboard (docs/REMOTE.md) ------------------------------------------

  /** A base URL is an origin: https anywhere, http only on this machine. */
  const remoteOrigin = (raw: string): string => {
    let u: URL;
    try {
      u = new URL(raw.trim());
    } catch {
      throw new z.ZodError([{ code: "custom", path: ["baseUrl"], message: "Not a URL", input: raw }]);
    }
    if (u.protocol !== "https:" && !(u.protocol === "http:" && isLoopback(u))) {
      throw new z.ZodError([{ code: "custom", path: ["baseUrl"], message: "Use https (http only for localhost)", input: raw }]);
    }
    return u.origin;
  };

  const remoteView = async () => {
    const cfg = d.getConfig().remote;
    return { enabled: cfg.enabled, baseUrl: cfg.baseUrl, hasToken: Boolean((await loadSecrets()).remoteToken), status: d.remote?.status() ?? { state: "off", shared: 0 } };
  };

  api.get(
    "/remote",
    wrap(async (_req, res) => {
      res.json(await remoteView());
    }),
  );

  api.put(
    "/remote",
    wrap(async (req, res) => {
      const body = z.object({ enabled: z.boolean().optional(), baseUrl: z.string().max(500).optional(), token: z.string().trim().max(500).optional() }).parse(req.body);
      const cur = d.getConfig();
      const baseUrl = body.baseUrl === undefined ? cur.remote.baseUrl : body.baseUrl.trim() ? remoteOrigin(body.baseUrl) : "";
      if (body.token !== undefined) {
        const secrets = await loadSecrets();
        await saveSecrets({ ...secrets, remoteToken: body.token || undefined });
      }
      await d.setConfig(configSchema.parse({ ...cur, remote: { enabled: body.enabled ?? cur.remote.enabled, baseUrl } }));
      await d.remote?.apply();
      // Give the first push a moment so the page shows connected or the error.
      await new Promise((r) => setTimeout(r, 1500));
      res.json(await remoteView());
    }),
  );

  api.post(
    "/remote/test",
    wrap(async (req, res) => {
      const body = z.object({ baseUrl: z.string().max(500).optional(), token: z.string().trim().max(500).optional() }).parse(req.body ?? {});
      const baseUrl = body.baseUrl?.trim() ? remoteOrigin(body.baseUrl) : d.getConfig().remote.baseUrl;
      const token = body.token || (await loadSecrets()).remoteToken;
      if (!baseUrl || !token) {
        res.json({ ok: false, error: !baseUrl ? "No base URL" : "No token" });
        return;
      }
      res.json(await RemoteClient.test(baseUrl, token));
    }),
  );

  api.post(
    "/work-targets",
    wrap(async (req, res) => {
      const t = workTargetSchema.parse(req.body);
      const abs = path.resolve(expandHome(t.path));
      const inside = await execFileP("git", ["-C", abs, "rev-parse", "--is-inside-work-tree"]).then((r) => r.stdout.trim()).catch(() => "false");
      if (inside !== "true") {
        res.status(400).json({ error: `${abs} is not a git work tree` });
        return;
      }
      const cfg = d.getConfig();
      if (cfg.workTargets.some((w) => w.name === t.name)) {
        res.status(409).json({ error: `A work target named ${t.name} exists` });
        return;
      }
      const next = { ...cfg, workTargets: [...cfg.workTargets, { name: t.name, path: abs }] };
      await d.setConfig(next);
      res.status(201).json(next.workTargets);
    }),
  );

  api.delete(
    "/work-targets/:name",
    wrap(async (req, res) => {
      const cfg = d.getConfig();
      await d.setConfig({ ...cfg, workTargets: cfg.workTargets.filter((w) => w.name !== param(req, "name")) });
      res.json({ ok: true });
    }),
  );

  /** Branches of a work target, for the new-session form. */
  api.get(
    "/work-targets/:name/branches",
    wrap(async (req, res) => {
      const t = d.getConfig().workTargets.find((w) => w.name === param(req, "name"));
      if (!t) {
        res.status(404).json({ error: "No such work target" });
        return;
      }
      res.json(await listBranches(t.path));
    }),
  );

  /** Packs a work target's manifests imply, for the new-session form. */
  api.get(
    "/work-targets/:name/packs",
    wrap(async (req, res) => {
      const t = d.getConfig().workTargets.find((w) => w.name === param(req, "name"));
      if (!t) {
        res.status(404).json({ error: "No such work target" });
        return;
      }
      res.json({ packs: await detectPacksInRepo(t.path).catch(() => []) });
    }),
  );

  api.get("/network/packs", (_req, res) => res.json(NETWORK_PACKS));

  // --- setup script library ------------------------------------------------------

  api.get(
    "/scripts",
    wrap(async (_req, res) => {
      res.json(await listScripts());
    }),
  );

  api.put(
    "/scripts/:name",
    wrap(async (req, res) => {
      const body = setupScriptSchema.parse({ ...req.body, name: param(req, "name") });
      // Hosts declared in the script header are merged with the ones typed in.
      const hosts = [...new Set([...body.hosts, ...hostsFromScript(body.script)])];
      res.json(await saveScript({ ...body, hosts }));
    }),
  );

  api.delete(
    "/scripts/:name",
    wrap(async (req, res) => {
      await deleteScript(param(req, "name"));
      res.json({ ok: true });
    }),
  );

  /** Markdown to paste into any assistant. tail = script | board | free; session optional. */
  api.get(
    "/context",
    wrap(async (req, res) => {
      const tail = z.enum(["script", "board", "free"]).catch("free").parse(req.query.tail);
      const cfg = d.getConfig();
      const session = typeof req.query.session === "string" && req.query.session ? (await d.hub.get(req.query.session)).session : null;
      const repoNames = typeof req.query.repos === "string" ? req.query.repos.split(",").filter(Boolean) : cfg.workTargets.map((w) => w.name);
      const facts = await probeImage(d.sandbox.docker, session?.image ?? cfg.devboxImage).catch(() => null);
      res.type("text/markdown").send(buildContext({ tail, config: cfg, facts, scripts: await listScripts(), session, repoNames }));
    }),
  );

  /** Parses a pasted board without saving it: what would be imported, or why it is invalid. */
  api.post(
    "/board/preview",
    wrap(async (req, res) => {
      const { text, repos } = z.object({ text: z.string().max(2_000_000), repos: z.array(z.string()).optional() }).parse(req.body);
      try {
        const parsed = parseBoardPaste(text);
        const r = importBoard(emptyBoard(), parsed, { by: "user", defaultState: "ready" });
        if (repos) validateRepos(r.board.tickets, repos);
        res.json({
          ok: true,
          goal: r.board.goal,
          tickets: r.board.tickets.map((t) => ({ id: t.id, title: t.title, kind: t.kind, repo: t.repo, size: t.size, state: t.state, deps: t.deps, acceptance: t.acceptance.length })),
          chores: r.chores.length,
        });
      } catch (e) {
        const msg = e instanceof z.ZodError ? `Invalid board: ${e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` : e instanceof SyntaxError ? `Not valid JSON: ${e.message}` : (e as Error).message;
        res.json({ ok: false, error: msg });
      }
    }),
  );

  // --- uploads (zip attachments for a session being created) -----------------

  const uploadsDir = path.join(verstasHome(), "uploads");
  api.post(
    "/uploads",
    express.raw({ type: () => true, limit: "1gb" }),
    wrap(async (req, res) => {
      const name = String(req.headers["x-filename"] ?? "attachment.zip").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 120);
      const body = req.body as Buffer;
      if (!Buffer.isBuffer(body) || body.length < 22 || body.readUInt32LE(0) !== 0x04034b50) {
        res.status(400).json({ error: "Not a zip file" });
        return;
      }
      await fs.mkdir(uploadsDir, { recursive: true, mode: 0o700 });
      const id = crypto.randomBytes(8).toString("hex");
      await fs.writeFile(path.join(uploadsDir, `${id}.zip`), body, { mode: 0o600 });
      res.status(201).json({ id, name, bytes: body.length });
    }),
  );

  // --- drafts (docs/DRAFTS.md) ------------------------------------------------------
  // Prepared through the draft MCP endpoint; here they are read, deleted, and
  // turned into sessions through the normal create call (draftId above).

  api.get(
    "/mcp/setup",
    wrap(async (_req, res) => {
      res.json(await d.mcpSetup());
    }),
  );

  const draftEnv = async () => ({ workTargets: d.getConfig().workTargets, recipes: (await listScripts()).map((x) => x.name) });
  const draftRow = (x: Draft, env: Awaited<ReturnType<typeof draftEnv>>) => {
    const p = validateDraft(x, env);
    return { id: x.id, name: x.name, goal: x.goal, tickets: x.tickets.length, repos: x.repos.map((r) => r.name ?? r.target), errors: p.errors.length, warnings: p.warnings.length, createdBy: x.createdBy, createdAt: x.createdAt, updatedAt: x.updatedAt, promotedTo: x.promotedTo };
  };

  api.get(
    "/drafts",
    wrap(async (_req, res) => {
      const env = await draftEnv();
      res.json((await d.drafts.list()).map((x) => draftRow(x, env)));
    }),
  );

  api.get(
    "/drafts/:id",
    wrap(async (req, res) => {
      const draft = await d.drafts.get(param(req, "id"));
      res.json({ draft, problems: validateDraft(draft, await draftEnv()), boardText: draftBoardText(draft) });
    }),
  );

  api.delete(
    "/drafts/:id",
    wrap(async (req, res) => {
      await d.drafts.get(param(req, "id"));
      await d.drafts.remove(param(req, "id"));
      res.json({ ok: true });
    }),
  );

  // --- sessions ----------------------------------------------------------------

  const summarize = async (s: Session) => {
    const h = await d.hub.get(s.id);
    const counts: Record<string, number> = {};
    for (const t of h.board.tickets) counts[t.state] = (counts[t.state] ?? 0) + 1;
    const runs = await allRuns(h.paths.runs);
    const live = d.runs.status(s.id);
    const run = live ?? runs[runs.length - 1];
    return {
      session: h.session,
      counts,
      run,
      openRequests: h.inbox.requests.filter((r) => r.state === "open").length,
      ideas: h.inbox.ideas.filter((i) => !i.promotedTo).length,
      totals: runTotals(live ? [...runs.filter((r) => r.id !== live.id), live] : runs, h.session.createdAt),
    };
  };

  api.get(
    "/sessions",
    wrap(async (_req, res) => {
      const sessions = await listSessions(d.getConfig().sessionsRoot);
      // One docker call tells which sessions still have a container, running or stopped.
      const boxes = await listSandboxes(d.sandbox).catch(() => new Map<string, "running" | "stopped">());
      // One unreadable session must not hide the others: report it as a row with an error.
      const rows = await Promise.all(
        sessions.map(async (s) => {
          const sandbox = boxes.get(s.id) ?? "absent";
          try {
            return { ...(await summarize(s)), sandbox };
          } catch (e) {
            console.warn(`[ui] session ${s.id} could not be summarised: ${(e as Error).message}`);
            return { session: s, counts: {}, run: undefined, openRequests: 0, ideas: 0, sandbox, error: (e as Error).message };
          }
        }),
      );
      res.json(rows);
    }),
  );

  const createBody = z.object({
    name: z.string().min(1).max(200),
    goal: z.string().max(20_000).default(""),
    repos: z.array(z.object({ target: z.string(), branch: z.string().optional(), name: z.string().optional() })).default([]),
    uploads: z.array(z.object({ id: z.string().regex(/^[a-f0-9]{16}$/), name: z.string() })).default([]),
    allowlist: z.array(z.string()).optional(),
    packs: z.array(z.string()).optional(),
    /** Legacy: the worker's Claude model. New callers send `agents`. */
    model: z.string().max(100).optional(),
    agents: sessionAgentsSchema.optional(),
    setupScripts: z.array(z.string()).default([]),
    caps: capsSchema.partial().optional(),
    limits: limitsSchema.partial().optional(),
    board: z.string().optional(),
    requirements: z.string().max(20_000).optional(),
    setupMode: setupModeSchema.optional(),
    /** The draft this form was filled from; it is marked as having become this session. */
    draftId: z.string().max(90).optional(),
  });

  /** Zip uploads from /uploads become extracted attachments of the session; the uploads are removed. */
  const attachUploads = async (h: SessionHandle, uploads: { id: string; name: string }[]) => {
    const extracts = [];
    for (const u of uploads) {
      const file = path.join(uploadsDir, `${u.id}.zip`);
      const dirName = u.name.replace(/\.zip$/i, "").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 100) || "attachment";
      if (h.session.attachments.some((a) => a.dir === dirName)) throw Object.assign(new Error(`An attachment named ${dirName} exists already; remove it first`), { status: 409 });
      const ex = await extractZip(file, path.join(h.paths.attachments, dirName));
      await fs.rm(file, { force: true });
      extracts.push(ex);
      await h.mutate((docs) => ({ next: { session: { ...docs.session, attachments: [...docs.session.attachments, { name: u.name, dir: dirName, bytes: ex.bytes, skipped: ex.skipped }] } } }));
    }
    return extracts;
  };

  api.post(
    "/sessions",
    wrap(async (req, res) => {
      const input = createBody.parse(req.body);
      const cfg = d.getConfig();
      if (input.draftId) {
        const draft = await d.drafts.get(input.draftId);
        if (draft.promotedTo) throw new DraftError(`This draft already became the session ${draft.promotedTo}`, "promoted");
      }
      const repos = input.repos.map((r) => {
        const target = cfg.workTargets.find((w) => w.name === r.target);
        if (!target) throw new Error(`Unknown work target ${r.target}`);
        return { target, branch: r.branch, name: r.name };
      });
      const zips = input.uploads.map((u) => ({ name: u.name, file: path.join(uploadsDir, `${u.id}.zip`) }));
      // A pasted board is checked before anything is written. Tickets may name repositories picked later: only a repository the board names and the session will never have is a problem at start time, not here.
      const pasted = input.board?.trim() ? parseBoardPaste(input.board) : undefined;
      if (pasted && repos.length) validateRepos(importBoard(emptyBoard(), pasted, { by: "user", defaultState: "ready" }).board.tickets, repos.map((r) => r.name ?? r.target.name));
      const setupScripts = [];
      for (const name of input.setupScripts) setupScripts.push(await getScript(name));
      await fs.mkdir(cfg.sessionsRoot, { recursive: true });
      // Nothing is cloned and no container exists: the session is a plan until you initialize it.
      const created = await createSession(cfg.sessionsRoot, { ...input, repos, zips, setupScripts, image: cfg.devboxImage });
      for (const z of zips) await fs.rm(z.file, { force: true });
      let imported: { created: string[]; skipped: { title: string; reason: string }[] } | undefined;
      if (pasted) {
        const h = await d.hub.get(created.session.id);
        imported = await h.mutate((docs) => {
          const r = importBoard(docs.board, pasted, { by: "user", defaultState: "ready" });
          return { next: { board: r.board }, result: { created: r.created, skipped: r.skipped } };
        });
      }
      if (input.draftId) await d.drafts.markPromoted(input.draftId, created.session.id).catch((e: Error) => console.warn(`[ui] draft ${input.draftId}: ${e.message}`));
      res.status(201).json({ session: created.session, extracts: created.extracts, imported });
    }),
  );

  // --- the plan: repositories, attachments, recipes, setup mode, then Initialize ------------

  const notWhileRunning = (res: Response, id: string): boolean => {
    if (!d.runs.status(id)) return false;
    res.status(409).json({ error: "Pause or stop the run first" });
    return true;
  };
  const onlyBeforeInit = (res: Response, h: SessionHandle, what: string): boolean => {
    if (!isInitialized(h.session)) return false;
    res.status(409).json({ error: `${what} can change only while the session is not initialized. Reset the environment first.` });
    return true;
  };

  /** Picks a repository; the clone is made at initialization. */
  api.post(
    "/sessions/:id/repos",
    wrap(async (req, res) => {
      const pick = z.object({ target: z.string(), branch: z.string().max(200).optional(), name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/).optional() }).parse(req.body);
      const h = await d.hub.get(param(req, "id"));
      if (onlyBeforeInit(res, h, "Repositories")) return;
      const target = d.getConfig().workTargets.find((w) => w.name === pick.target);
      if (!target) throw Object.assign(new Error(`Unknown work target ${pick.target}`), { status: 404 });
      const name = pick.name ?? target.name;
      if (RESERVED_WORKSPACE_NAMES.includes(name)) throw Object.assign(new Error(`"${name}" is reserved in the workspace`), { status: 409 });
      if (h.session.repos.some((r) => r.name === name)) throw Object.assign(new Error(`This session already has a repository named ${name}`), { status: 409 });
      const spec = await repoPick(h.id, { target, branch: pick.branch, name: pick.name });
      // The packs the repository's manifests imply join the allowlist, as the New session form did.
      const found = await detectPacksInRepo(target.path).catch(() => [] as string[]);
      await h.mutate((docs) => {
        const packs = withAgentPacks([...new Set([...docs.session.packs, ...found])], docs.session);
        return { next: { session: { ...docs.session, repos: [...docs.session.repos, spec], packs, allowlist: [...new Set([...docs.session.allowlist, ...packHosts(packs)])] } } };
      });
      res.status(201).json({ ok: true, repo: spec, packs: found });
    }),
  );

  api.delete(
    "/sessions/:id/repos/:name",
    wrap(async (req, res) => {
      const h = await d.hub.get(param(req, "id"));
      if (onlyBeforeInit(res, h, "Repositories")) return;
      const name = param(req, "name");
      if (!h.session.repos.some((r) => r.name === name)) throw Object.assign(new Error(`No repository ${name} in this session`), { status: 404 });
      // An initialization that did not complete may have cloned it already; the clone goes with the pick.
      await fs.rm(path.join(h.paths.workspace, name), { recursive: true, force: true });
      await h.mutate((docs) => ({ next: { session: { ...docs.session, repos: docs.session.repos.filter((r) => r.name !== name) } } }));
      res.json({ ok: true });
    }),
  );

  /** Uploaded zips (see /uploads) become attachments of an existing session. */
  api.post(
    "/sessions/:id/attachments",
    wrap(async (req, res) => {
      const { uploads } = z.object({ uploads: z.array(z.object({ id: z.string().regex(/^[a-f0-9]{16}$/), name: z.string() })).min(1) }).parse(req.body);
      const h = await d.hub.get(param(req, "id"));
      if (notWhileRunning(res, h.id)) return;
      const extracts = await attachUploads(h, uploads);
      res.status(201).json({ ok: true, extracts, attachments: (await d.hub.get(h.id)).session.attachments });
    }),
  );

  /** Your description of an attachment; empty clears it. Read by the workers of the next run. */
  api.put(
    "/sessions/:id/attachments/:dir",
    wrap(async (req, res) => {
      const { description } = z.object({ description: z.string().max(1000) }).parse(req.body);
      const h = await d.hub.get(param(req, "id"));
      const dir = param(req, "dir");
      if (!h.session.attachments.some((a) => a.dir === dir)) throw Object.assign(new Error(`No attachment ${dir}`), { status: 404 });
      const text = description.trim() || undefined;
      await h.mutate((docs) => ({ next: { session: { ...docs.session, attachments: docs.session.attachments.map((a) => (a.dir === dir ? { ...a, description: text } : a)) } } }));
      res.json({ ok: true, description: text ?? null });
    }),
  );

  api.delete(
    "/sessions/:id/attachments/:dir",
    wrap(async (req, res) => {
      const h = await d.hub.get(param(req, "id"));
      if (notWhileRunning(res, h.id)) return;
      const dir = param(req, "dir");
      const att = h.session.attachments.find((a) => a.dir === dir);
      if (!att) throw Object.assign(new Error(`No attachment ${dir}`), { status: 404 });
      const target = path.resolve(h.paths.attachments, dir);
      if (!target.startsWith(path.resolve(h.paths.attachments) + path.sep)) throw new Error("Bad attachment directory");
      await fs.rm(target, { recursive: true, force: true });
      await h.mutate((docs) => ({ next: { session: { ...docs.session, attachments: docs.session.attachments.filter((a) => a.dir !== dir) } } }));
      res.json({ ok: true });
    }),
  );

  /** The recipes from the library this session runs when its container is created; their hosts join the allowlist. After initialization, "Re-run recipes" applies a change. */
  api.put(
    "/sessions/:id/recipes",
    wrap(async (req, res) => {
      const { names } = z.object({ names: z.array(z.string()).max(50) }).parse(req.body);
      const h = await d.hub.get(param(req, "id"));
      if (notWhileRunning(res, h.id)) return;
      const scripts: SessionSetupScript[] = [];
      for (const name of names) scripts.push(await getScript(name));
      await writeRecipeFiles(h.paths, scripts);
      await h.mutate((docs) => ({
        next: { session: { ...docs.session, setupScripts: scripts, setup: [], allowlist: [...new Set([...docs.session.allowlist, ...scripts.flatMap((x) => x.hosts)])] } },
      }));
      res.json({ ok: true });
    }),
  );

  /**
   * Initialize: clone the repositories now, then a run brings the container
   * up, runs the recipes and (unless the setup mode skips it) the setup
   * worker. With `start`, the tickets follow when initialization succeeds.
   */
  api.post(
    "/sessions/:id/init",
    wrap(async (req, res) => {
      const { start } = z.object({ start: z.boolean().default(false) }).parse(req.body ?? {});
      const h = await d.hub.get(param(req, "id"));
      if (notWhileRunning(res, h.id)) return;
      if (isInitialized(h.session)) {
        res.status(409).json({ error: "This session is initialized already" });
        return;
      }
      const { repos, clones } = await provisionSession(d.getConfig().sessionsRoot, h.session);
      await h.mutate((docs) => ({ next: { session: { ...docs.session, repos } } }));
      let ctl;
      try {
        ctl = await d.runs.start(h.id, { init: true, start });
      } catch (e) {
        res.status(409).json({ error: (e as Error).message, clones });
        return;
      }
      res.json({ ok: true, run: ctl.run, clones });
    }),
  );

  /** Back to a plan: the sandbox (with its home volume and snapshot) and the clones go; the board, the notes, the settings and the run history stay. */
  api.post(
    "/sessions/:id/reset",
    wrap(async (req, res) => {
      const h = await d.hub.get(param(req, "id"));
      if (notWhileRunning(res, h.id)) return;
      await removeSandbox(d.sandbox, h.id, { everything: true }).catch(() => undefined);
      await removeClones(d.getConfig().sessionsRoot, h.session);
      await h.mutate((docs) => ({
        next: {
          session: { ...docs.session, initializedAt: null, readiness: undefined, snapshot: undefined, setup: [], repos: docs.session.repos.map(({ baseCommit: _b, ...r }) => r), state: "setup" },
        },
      }));
      res.json({ ok: true });
    }),
  );

  api.get(
    "/sessions/:id",
    wrap(async (req, res) => {
      const h = await d.hub.get(param(req, "id"));
      const runs = await allRuns(h.paths.runs);
      const live = d.runs.status(h.id);
      const run = live ?? runs[runs.length - 1];
      const sandbox = await sandboxStatus(d.sandbox, h.id).catch(() => null);
      const all = live ? [...runs.filter((r) => r.id !== live.id), live] : runs;
      res.json({ session: h.session, board: h.board, inbox: h.inbox, run, runs: all, totals: runTotals(all, h.session.createdAt), sandbox, active: Boolean(live), dir: h.paths.dir });
    }),
  );

  api.get(
    "/sessions/:id/events",
    wrap(async (req, res) => {
      const h = await d.hub.get(param(req, "id"));
      const runId = Number(req.query.run) || (await lastRun(h.paths.runs))?.id;
      if (!runId) {
        res.json({ runId: null, events: [] });
        return;
      }
      const file = path.join(h.paths.runs, String(runId), "events.jsonl");
      const raw = await fs.readFile(file, "utf8").catch(() => "");
      const lines = raw.split("\n").filter(Boolean);
      const limit = Math.min(Number(req.query.limit) || 500, 5000);
      res.json({ runId, events: lines.slice(-limit).map((l) => JSON.parse(l) as unknown) });
    }),
  );

  /** Worker reports for one ticket across every run, oldest first; empty when no run touched it. */
  api.get(
    "/sessions/:id/tickets/:ticket/reports",
    wrap(async (req, res) => {
      const h = await d.hub.get(param(req, "id"));
      const tid = ticketIdSchema.parse(param(req, "ticket"));
      const out: { runId: number; text: string }[] = [];
      for (const r of await allRuns(h.paths.runs)) {
        const text = await fs.readFile(path.join(h.paths.runs, String(r.id), "tickets", `${tid}.md`), "utf8").catch(() => "");
        if (text.trim()) out.push({ runId: r.id, text });
      }
      res.json({ reports: out });
    }),
  );

  api.get(
    "/sessions/:id/runs/:run/tickets/:ticket",
    wrap(async (req, res) => {
      const h = await d.hub.get(param(req, "id"));
      const file = path.join(h.paths.runs, String(Number(param(req, "run"))), "tickets", `${ticketIdSchema.parse(param(req, "ticket"))}.md`);
      res.type("text/markdown").send(await fs.readFile(file, "utf8"));
    }),
  );

  api.delete(
    "/sessions/:id",
    wrap(async (req, res) => {
      const id = param(req, "id");
      d.runs.stopNow(id);
      await removeSandbox(d.sandbox, id, { everything: true }).catch(() => undefined);
      await deleteSessionDir(d.getConfig().sessionsRoot, id);
      d.hub.forget(id);
      res.json({ ok: true });
    }),
  );

  api.post(
    "/sessions/:id/run",
    wrap(async (req, res) => {
      const { action, prompt } = z.object({ action: z.enum(["start", "plan", "brief", "setup", "prompt", "pause", "stop"]), prompt: z.string().max(20_000).optional() }).parse(req.body);
      const id = param(req, "id");
      if (action === "start" || action === "plan" || action === "brief" || action === "setup" || action === "prompt") {
        let ctl;
        try {
          ctl = await d.runs.start(id, { plan: action === "plan" ? (prompt ?? "") : undefined, brief: action === "brief", setup: action === "setup", prompt: action === "prompt" ? (prompt ?? "") : undefined });
        } catch (e) {
          res.status(409).json({ error: (e as Error).message });
          return;
        }
        res.json({ ok: true, run: ctl.run });
        return;
      }
      const ok = action === "pause" ? d.runs.pauseAfterTicket(id) : d.runs.stopNow(id);
      res.json({ ok, note: ok ? undefined : "No active run" });
    }),
  );

  api.post(
    "/sessions/:id/sandbox",
    wrap(async (req, res) => {
      const { action } = z.object({ action: z.enum(["stop", "remove"]) }).parse(req.body);
      if (d.runs.status(param(req, "id"))) {
        res.status(409).json({ error: "Stop the run first" });
        return;
      }
      if (action === "stop") await stopSandbox(d.sandbox, param(req, "id"));
      else await removeSandbox(d.sandbox, param(req, "id"));
      res.json({ ok: true });
    }),
  );

  // --- setup scripts of a session ------------------------------------------------

  api.get(
    "/sessions/:id/setup",
    wrap(async (req, res) => {
      const h = await d.hub.get(param(req, "id"));
      const logs: Record<string, string> = {};
      for (const sc of h.session.setupScripts) logs[sc.name] = await fs.readFile(path.join(h.paths.setup, `${sc.name}.log`), "utf8").catch(() => "");
      const note = (name: string) => fs.readFile(path.join(h.paths.notes, name), "utf8").catch(() => "");
      res.json({
        scripts: h.session.setupScripts.map(({ script, ...meta }) => ({ ...meta, lines: script.split("\n").length })),
        results: h.session.setup,
        logs,
        requirements: h.session.requirements,
        readiness: h.session.readiness ?? null,
        env: await note("env.md"),
        recipe: await note("setup.sh"),
        recipeLog: await fs.readFile(path.join(h.paths.setup, "recipe.log"), "utf8").catch(() => ""),
      });
    }),
  );

  /** Re-runs every setup script now (container is brought up if needed). */
  api.post(
    "/sessions/:id/setup/rerun",
    wrap(async (req, res) => {
      const h = await d.hub.get(param(req, "id"));
      if (notWhileRunning(res, h.id)) return;
      if (!isInitialized(h.session)) {
        res.status(409).json({ error: "Initialize the session first; the recipes run then" });
        return;
      }
      await ensureSessionSandbox(d.runConfig, h.session, path.join(h.paths.dir, "sandbox.env"), false).catch(() => undefined);
      try {
        const results = await runSetup(d.runConfig, h.id);
        res.json({ ok: true, results });
      } catch (e) {
        res.status(500).json({ error: (e as Error).message, results: (await d.hub.get(h.id)).session.setup });
      }
    }),
  );

  /** The project brief the orientation worker wrote, with its age. */
  api.get(
    "/sessions/:id/brief",
    wrap(async (req, res) => {
      const h = await d.hub.get(param(req, "id"));
      const file = path.join(h.paths.notes, "brief.md");
      const text = await fs.readFile(file, "utf8").catch(() => "");
      const st = text ? await fs.stat(file) : null;
      res.json({ text, updatedAt: st?.mtime.toISOString() ?? null, words: text ? text.split(/\s+/).filter(Boolean).length : 0 });
    }),
  );

  /** What ran as root in the box through sudo: workspace/.verstas/logs/sudo.log, newest last. */
  api.get(
    "/sessions/:id/sudo-log",
    wrap(async (req, res) => {
      const h = await d.hub.get(param(req, "id"));
      const text = await fs.readFile(path.join(h.paths.workspace, ".verstas", "logs", "sudo.log"), "utf8").catch(() => "");
      const commands = [...text.matchAll(/COMMAND=(.*)$/gm)].map((m) => m[1]!.trim());
      res.json({ count: commands.length, commands: commands.slice(-200) });
    }),
  );

  /**
   * Saves this session's recipe (notes/setup.sh) and environment description
   * (notes/env.md) to the library under a name, to tick on the next session
   * for the same repositories. It runs as the agent, with sudo, like here.
   */
  api.post(
    "/sessions/:id/recipe/promote",
    wrap(async (req, res) => {
      const body = z.object({ name: z.string(), description: z.string().max(500).default("") }).parse(req.body);
      const h = await d.hub.get(param(req, "id"));
      const script = await fs.readFile(path.join(h.paths.notes, "setup.sh"), "utf8").catch(() => "");
      if (!script.trim()) {
        res.status(404).json({ error: "This session has no notes/setup.sh yet; the setup worker writes it." });
        return;
      }
      const env = await fs.readFile(path.join(h.paths.notes, "env.md"), "utf8").catch(() => "");
      const saved = await saveScript({
        name: body.name,
        description: body.description || `Recipe from session ${h.session.name}`,
        hosts: [...new Set([...hostsFromScript(script), ...h.session.allowlist.filter((x) => !DEFAULT_ALLOWLIST.includes(x))])],
        note: `Recipe saved from session ${h.session.name} (${h.session.repos.map((r) => r.name).join(", ") || "no repositories"}). It already ran; notes/env.md describes the result.`,
        script,
        runAs: "agent",
        env,
      });
      res.json({ ok: true, name: saved.name });
    }),
  );

  /** The setup mode and the instructions the setup worker gets on top of what it works out itself. */
  api.put(
    "/sessions/:id/requirements",
    wrap(async (req, res) => {
      const body = z.object({ requirements: z.string().max(20_000).optional(), setupMode: setupModeSchema.optional() }).parse(req.body);
      const h = await d.hub.get(param(req, "id"));
      const session = await h.mutate((docs) => {
        const next = { ...docs.session, requirements: body.requirements === undefined ? docs.session.requirements : body.requirements.trim(), setupMode: body.setupMode ?? docs.session.setupMode };
        return { next: { session: next }, result: next };
      });
      res.json({ ok: true, session });
    }),
  );

  /**
   * Accept the environment as it is: an initialization whose setup worker
   * reported "needs" is completed by you, after you dealt with it by hand
   * or decided it does not matter. Optionally starts the work run.
   */
  api.post(
    "/sessions/:id/setup/confirm",
    wrap(async (req, res) => {
      const { start } = z.object({ start: z.boolean().default(false) }).parse(req.body ?? {});
      const h = await d.hub.get(param(req, "id"));
      if (notWhileRunning(res, h.id)) return;
      if (!h.session.repos.every((r) => r.baseCommit)) {
        res.status(409).json({ error: "The repositories are not cloned yet; press Initialize first" });
        return;
      }
      // Commit the box as it is now, so a recreate starts from a set-up environment. Best effort: a failed snapshot leaves the recipe as the fallback.
      let snapshot: { image: string; baseImageId: string } | undefined;
      let snapshotError: string | undefined;
      if ((await sandboxStatus(d.sandbox, h.id).catch(() => null))?.container === "running") {
        snapshot = await snapshotSandbox(d.sandbox, h.session).catch((e: Error) => {
          snapshotError = e.message;
          return undefined;
        });
      } else snapshotError = "the container is not running; no snapshot taken";
      await h.mutate((docs) => ({
        next: {
          session: {
            ...docs.session,
            initializedAt: docs.session.initializedAt ?? now(),
            readiness: docs.session.readiness ? { ...docs.session.readiness, confirmedAt: now() } : undefined,
            snapshot: snapshot ? { ...snapshot, at: now() } : docs.session.snapshot,
            state: docs.session.state === "setup" ? "created" : docs.session.state,
          },
        },
      }));
      if (start) await d.runs.start(h.id);
      res.json({ ok: true, snapshot: snapshot?.image ?? null, snapshotError });
    }),
  );

  // --- export and apply ----------------------------------------------------------

  /** Bundles the named repos (all when omitted) inside the container; files land in <session>/export/. */
  const bundleRepos = async (h: SessionHandle, names?: string[]) => {
    if (d.runs.status(h.id)) throw Object.assign(new Error("Pause or stop the run first"), { status: 409 });
    if (!isInitialized(h.session)) throw Object.assign(new Error("Nothing to export: the session is not initialized"), { status: 409 });
    await ensureSessionSandbox(d.runConfig, h.session, path.join(h.paths.dir, "sandbox.env"), false);
    const sh = dockerShell(d.sandbox, h.id);
    const mk = await sh.exec(["mkdir", "-p", "/workspace/.verstas/export"]);
    if (mk.code !== 0) throw new Error(`The agent cannot write in /workspace (${mk.stderr.trim().slice(-200)}); on a Linux host the workspace must be owned by uid 1000, which the sandbox arranges at start`);
    const files: { repo: string; file: string; branch: string; bytes: number }[] = [];
    for (const repo of h.session.repos.filter((r) => !names || names.includes(r.name))) {
      const bundle = `/workspace/.verstas/export/${repo.name}.bundle`;
      const r = await sh.exec(["git", "bundle", "create", bundle, "--all"], { workdir: `/workspace/${repo.name}`, timeoutMs: 600_000 });
      if (r.code !== 0) throw new Error(`bundle ${repo.name}: ${r.stderr.slice(-500)}`);
      const src = path.join(h.paths.workspace, ".verstas", "export", `${repo.name}.bundle`);
      const dst = path.join(h.paths.exportDir, `${repo.name}.bundle`);
      await fs.mkdir(h.paths.exportDir, { recursive: true });
      await fs.copyFile(src, dst);
      await fs.rm(src, { force: true });
      files.push({ repo: repo.name, file: dst, branch: repo.runBranch, bytes: (await fs.stat(dst)).size });
    }
    return files;
  };

  /**
   * Commits on each repository's run branch since the session started, for
   * the reset dialog: what a reset would delete unless applied or exported.
   * Counted inside the container (Boundary 5); null when it cannot be.
   */
  api.get(
    "/sessions/:id/commits",
    wrap(async (req, res) => {
      const h = await d.hub.get(param(req, "id"));
      if (!isInitialized(h.session) || !h.session.repos.length) {
        res.json({ repos: [] });
        return;
      }
      const sh = await ensureSessionSandbox(d.runConfig, h.session, path.join(h.paths.dir, "sandbox.env"), false)
        .then(() => dockerShell(d.sandbox, h.id))
        .catch(() => null);
      const repos: { name: string; runBranch: string; commits: number | null }[] = [];
      for (const r of h.session.repos) {
        let commits: number | null = null;
        if (sh && r.baseCommit) {
          const out = await sh.exec(["git", "rev-list", "--count", `${r.baseCommit}..${r.runBranch}`], { workdir: `/workspace/${r.name}`, timeoutMs: 60_000 }).catch(() => null);
          if (out?.code === 0 && /^\d+$/.test(out.stdout.trim())) commits = Number(out.stdout.trim());
        }
        repos.push({ name: r.name, runBranch: r.runBranch, commits });
      }
      res.json({ repos });
    }),
  );

  api.post(
    "/sessions/:id/export",
    wrap(async (req, res) => {
      const h = await d.hub.get(param(req, "id"));
      try {
        const files = await bundleRepos(h);
        res.json({
          files,
          howTo: files.map((f) => `cd <your ${f.repo} checkout> && git fetch "${f.file}" ${f.branch}:${f.branch} && git log --oneline ${f.branch}`),
        });
      } catch (e) {
        res.status((e as { status?: number }).status ?? 500).json({ error: (e as Error).message });
      }
    }),
  );

  /**
   * Apply one repository's work to the real repository as the feature
   * branch verstas/<session>: bundle inside the container, fetch on the
   * host into the work target. Your checked-out branch is never moved.
   */
  api.post(
    "/sessions/:id/apply",
    wrap(async (req, res) => {
      const { repo } = z.object({ repo: z.string().min(1) }).parse(req.body);
      const h = await d.hub.get(param(req, "id"));
      const spec = h.session.repos.find((r) => r.name === repo);
      if (!spec) {
        res.status(404).json({ error: `No repository ${repo} in this session` });
        return;
      }
      try {
        const [file] = await bundleRepos(h, [repo]);
        const result = await applyBundle({ targetPath: spec.sourcePath, bundleFile: file!.file, branch: spec.runBranch, baseCommit: spec.baseCommit, sourceBranch: spec.branch });
        res.json(result);
      } catch (e) {
        const status = e instanceof ApplyError ? 400 : ((e as { status?: number }).status ?? 500);
        res.status(status).json({ error: (e as Error).message });
      }
    }),
  );

  api.get(
    "/sessions/:id/export/:repo",
    wrap(async (req, res) => {
      const h = await d.hub.get(param(req, "id"));
      const name = String(param(req, "repo")).replace(/[^A-Za-z0-9._-]/g, "");
      res.download(path.join(h.paths.exportDir, `${name}.bundle`));
    }),
  );

  // --- session archives (src/sessions/archive.ts) ---------------------------------

  const archiveFile = (h: SessionHandle) => path.join(h.paths.exportDir, `${h.id}.ver`);

  /**
   * Writes <session>/export/<id>.ver to take the session to another machine.
   * The clones go as bundles made in the container, so a change nobody
   * committed would be lost: the export refuses then.
   */
  api.post(
    "/sessions/:id/archive",
    wrap(async (req, res) => {
      const h = await d.hub.get(param(req, "id"));
      if (notWhileRunning(res, h.id)) return;
      let bundles: { repo: string; file: string }[] = [];
      if (isInitialized(h.session) && h.session.repos.length) {
        await ensureSessionSandbox(d.runConfig, h.session, path.join(h.paths.dir, "sandbox.env"), false);
        const sh = dockerShell(d.sandbox, h.id);
        const dirty: string[] = [];
        for (const r of h.session.repos) {
          const st = await sh.exec(["git", "status", "--porcelain"], { workdir: `/workspace/${r.name}` });
          if (st.code !== 0) throw new Error(`git status in ${r.name}: ${st.stderr.slice(-300)}`);
          const files = st.stdout.split("\n").filter(Boolean);
          if (files.length) dirty.push(`${r.name} (${files.slice(0, 5).map((l) => l.slice(3)).join(", ")}${files.length > 5 ? `, ${files.length - 5} more` : ""})`);
        }
        if (dirty.length) {
          res.status(409).json({ error: `Uncommitted changes would be left behind: ${dirty.join("; ")}. Commit or discard them (a prompt does either), then export again.` });
          return;
        }
        bundles = (await bundleRepos(h)).map((f) => ({ repo: f.repo, file: f.file }));
      }
      const out = await writeArchive({ root: d.getConfig().sessionsRoot, session: h.session, bundles, outFile: archiveFile(h), verstasVersion: d.version });
      res.json({ file: out.file, bytes: out.bytes, skipped: out.skipped, download: `/api/sessions/${encodeURIComponent(h.id)}/archive` });
    }),
  );

  api.get(
    "/sessions/:id/archive",
    wrap(async (req, res) => {
      const h = await d.hub.get(param(req, "id"));
      const file = archiveFile(h);
      await fs.access(file);
      res.download(file, `${h.id}.ver`);
    }),
  );

  /**
   * An uploaded archive (see /uploads) becomes a session here, as a plan
   * with its clones in place; Initialize rebuilds the environment. When the
   * id exists already, `as` decides: replace that session, or import a copy
   * under a new id. Without it the answer is 409 with `exists`.
   */
  api.post(
    "/sessions/import",
    wrap(async (req, res) => {
      const body = z.object({ upload: z.string().regex(/^[a-f0-9]{16}$/), as: z.enum(["replace", "copy"]).optional() }).parse(req.body);
      const file = path.join(uploadsDir, `${body.upload}.zip`);
      const { session: incoming } = readArchive(file);
      const cfg = d.getConfig();
      const root = cfg.sessionsRoot;
      const exists = await fs.access(sessionPaths(root, incoming.id).dir).then(() => true, () => false);
      if (exists && !body.as) {
        const here = await d.hub.get(incoming.id).then((h) => h.session.name, () => incoming.id);
        res.status(409).json({ error: `A session ${incoming.id} exists here already`, exists: { id: incoming.id, name: here } });
        return;
      }
      // A copy beside the original says so in its name, and its id follows the name.
      const name = exists && body.as === "copy" ? `${incoming.name.slice(0, 193)} (copy)` : undefined;
      const id = name ? await makeSessionId(root, name) : incoming.id;
      const replace = exists && body.as === "replace";
      if (replace && notWhileRunning(res, id)) return;
      const result = await importArchive({
        root,
        file,
        id,
        name,
        workTargets: cfg.workTargets,
        image: cfg.devboxImage,
        replace: replace ? { removeEnvironment: () => removeSandbox(d.sandbox, id, { everything: true }).catch(() => undefined) } : undefined,
      });
      d.hub.forget(id);
      await fs.rm(file, { force: true });
      res.status(201).json(result);
    }),
  );

  // --- board -----------------------------------------------------------------

  api.get(
    "/sessions/:id/board/export",
    wrap(async (req, res) => {
      const h = await d.hub.get(param(req, "id"));
      res.type("application/json").send(exportBoard(h.board));
    }),
  );

  api.post(
    "/sessions/:id/board/import",
    wrap(async (req, res) => {
      const { text, state } = z.object({ text: z.string().min(1).max(2_000_000), state: z.enum(["backlog", "ready"]).default("ready") }).parse(req.body);
      const h = await d.hub.get(param(req, "id"));
      const parsed = parseBoardPaste(text);
      const result = await h.mutate((docs) => {
        const r = importBoard(docs.board, parsed, { by: "user", defaultState: state });
        validateRepos(r.board.tickets, docs.session.repos.map((x) => x.name), { ignoreDone: true });
        return { next: { board: r.board }, result: { created: r.created, updated: r.updated, skipped: r.skipped, chores: r.chores } };
      });
      res.json(result);
    }),
  );

  // --- chores: small fixes swept in batches (docs/BOARD.md) ------------------

  api.post(
    "/sessions/:id/chores",
    wrap(async (req, res) => {
      const input = z.object({ text: z.string().min(1).max(2000), where: z.string().max(500).optional(), repo: z.string().min(1).max(100).optional() }).parse(req.body);
      const h = await d.hub.get(param(req, "id"));
      const id = await h.mutate((docs) => {
        if (input.repo && !docs.session.repos.some((x) => x.name === input.repo)) throw new BoardError(`No repository ${input.repo} in this session`, "unknown_repo");
        const r = addChore(docs.board, input, "user", { state: "open" });
        return { next: { board: r.board }, result: r.id };
      });
      res.status(201).json({ id });
    }),
  );

  /** Approve a proposed chore (to open) or drop one. A chore in a sweep belongs to the lead until the sweep is settled. */
  api.post(
    "/sessions/:id/chores/:cid/state",
    wrap(async (req, res) => {
      const { state, note } = z.object({ state: z.enum(["open", "dropped"]), note: z.string().max(2000).optional() }).parse(req.body);
      const cid = choreIdSchema.parse(param(req, "cid"));
      const h = await d.hub.get(param(req, "id"));
      await h.mutate((docs) => ({ next: { board: setChoreState(docs.board, cid, state, note) } }));
      res.json({ ok: true });
    }),
  );

  api.post(
    "/sessions/:id/chores/approve-all",
    wrap(async (req, res) => {
      const h = await d.hub.get(param(req, "id"));
      const ids = await h.mutate((docs) => {
        let board = docs.board;
        const moved: string[] = [];
        for (const c of docs.board.chores) {
          if (c.state !== "proposed") continue;
          board = setChoreState(board, c.id, "open");
          moved.push(c.id);
        }
        return { next: { board }, result: moved };
      });
      res.json({ ok: true, approved: ids });
    }),
  );

  /** A chore that deserves a reviewer becomes a backlog ticket. */
  api.post(
    "/sessions/:id/chores/:cid/promote",
    wrap(async (req, res) => {
      const { note } = z.object({ note: z.string().max(2000).optional() }).parse(req.body ?? {});
      const cid = choreIdSchema.parse(param(req, "cid"));
      const h = await d.hub.get(param(req, "id"));
      const ticketId = await h.mutate((docs) => {
        const r = promoteChore(docs.board, cid, "user", { note });
        return { next: { board: r.board }, result: r.ticketId };
      });
      res.status(201).json({ id: ticketId });
    }),
  );

  const ticketEdit = z.object({
    title: z.string().min(1).max(200).optional(),
    kind: ticketKindSchema.optional(),
    repo: z.string().max(100).nullable().optional(),
    size: ticketSizeSchema.optional(),
    priority: z.number().int().min(0).max(1000).optional(),
    deps: z.array(ticketIdSchema).optional(),
    spec: z.string().max(50_000).optional(),
    acceptance: z.array(z.string().min(1).max(2000)).optional(),
    pinned: z.boolean().optional(),
    /** null clears the ticket's own agent. */
    agent: agentSpecSchema.nullable().optional(),
    /** null goes back to the session's review setting. */
    review: reviewModeSchema.nullable().optional(),
  });

  api.post(
    "/sessions/:id/tickets",
    wrap(async (req, res) => {
      const input = ticketImportSchema.parse(req.body);
      const h = await d.hub.get(param(req, "id"));
      const id = await h.mutate((docs) => {
        const r = importBoard(docs.board, { tickets: [input] }, { by: "user", defaultState: "backlog" });
        validateRepos(r.board.tickets, docs.session.repos.map((x) => x.name), { ignoreDone: true });
        return { next: { board: r.board }, result: r.created[0] };
      });
      res.status(201).json({ id });
    }),
  );

  api.put(
    "/sessions/:id/tickets/:tid",
    wrap(async (req, res) => {
      const patch = ticketEdit.parse(req.body);
      const tid = ticketIdSchema.parse(param(req, "tid"));
      const h = await d.hub.get(param(req, "id"));
      const ticket = await h.mutate((docs) => {
        const t = getTicket(docs.board, tid);
        const next: Ticket = { ...t, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)), repo: patch.repo === null ? undefined : (patch.repo ?? t.repo), agent: patch.agent === null ? undefined : (patch.agent ?? t.agent), review: patch.review === null ? undefined : (patch.review ?? t.review), updatedAt: now() } as Ticket;
        const board = replaceTicket(docs.board, next);
        validateDeps(board.tickets);
        validateRepos([next], docs.session.repos.map((x) => x.name));
        return { next: { board }, result: next };
      });
      res.json(ticket);
    }),
  );

  api.post(
    "/sessions/:id/tickets/:tid/state",
    wrap(async (req, res) => {
      const { state, note } = z.object({ state: ticketStateSchema, note: z.string().max(2000).optional() }).parse(req.body);
      const tid = ticketIdSchema.parse(param(req, "tid"));
      if (!(USER_STATES as readonly string[]).includes(state)) {
        res.status(400).json({ error: `You can move tickets to ${USER_STATES.join(", ")}; the loop owns the rest` });
        return;
      }
      const h = await d.hub.get(param(req, "id"));
      const active = d.runs.status(h.id);
      if (active?.currentTicket === tid) {
        res.status(409).json({ error: "A worker holds this ticket; stop the run first" });
        return;
      }
      const t = await h.mutate((docs) => {
        const cur = getTicket(docs.board, tid);
        if (!canTransition(cur.state, state)) throw new BoardError(`Cannot move ${tid} from ${cur.state} to ${state}`, "illegal_transition");
        let board = transition(docs.board, tid, state, { by: "user", text: note ?? `Moved to ${state}` });
        // A user putting a blocked or done ticket back in play starts its attempt count over.
        if (state === "ready" && (cur.state === "blocked" || cur.state === "done")) board = replaceTicket(board, { ...getTicket(board, tid), attempts: 0 });
        return { next: { board }, result: getTicket(board, tid) };
      });
      res.json(t);
    }),
  );

  /** Backlog -> ready for every backlog ticket: the approval step after a plan or an import. */
  api.post(
    "/sessions/:id/tickets/approve-all",
    wrap(async (req, res) => {
      const h = await d.hub.get(param(req, "id"));
      const ids = await h.mutate((docs) => {
        let board = docs.board;
        const moved: string[] = [];
        for (const t of docs.board.tickets) {
          if (t.state !== "backlog") continue;
          board = transition(board, t.id, "ready", { by: "user", text: "Approved" });
          moved.push(t.id);
        }
        return { next: { board }, result: moved };
      });
      res.json({ ok: true, approved: ids });
    }),
  );

  api.post(
    "/sessions/:id/tickets/:tid/notes",
    wrap(async (req, res) => {
      const { text } = z.object({ text: z.string().min(1).max(20_000) }).parse(req.body);
      const tid = ticketIdSchema.parse(param(req, "tid"));
      const h = await d.hub.get(param(req, "id"));
      await h.mutate((docs) => ({ next: { board: addNote(docs.board, tid, "user", text) } }));
      res.json({ ok: true });
    }),
  );

  api.delete(
    "/sessions/:id/tickets/:tid",
    wrap(async (req, res) => {
      const tid = ticketIdSchema.parse(param(req, "tid"));
      const h = await d.hub.get(param(req, "id"));
      if (d.runs.status(h.id)?.currentTicket === tid) {
        res.status(409).json({ error: "A worker holds this ticket; stop the run first" });
        return;
      }
      await h.mutate((docs) => {
        const tickets = docs.board.tickets.filter((t) => t.id !== tid).map((t) => ({ ...t, deps: t.deps.filter((x) => x !== tid) }));
        return { next: { board: { ...docs.board, tickets } } };
      });
      res.json({ ok: true });
    }),
  );

  /** Show the session on the remote dashboard, or stop showing it. */
  api.put(
    "/sessions/:id/remote",
    wrap(async (req, res) => {
      const { remote } = z.object({ remote: z.boolean() }).parse(req.body);
      const h = await d.hub.get(param(req, "id"));
      await h.mutate((docs) => ({ next: { session: { ...docs.session, remote } } }));
      res.json({ ok: true, remote });
    }),
  );

  /** The hosts, or the packs: with `packs`, the hosts outside any pack are kept and the packs' hosts are rebuilt from the new choice. */
  api.put(
    "/sessions/:id/allowlist",
    wrap(async (req, res) => {
      const body = z.object({ allowlist: z.array(z.string().trim().min(1).max(260)).max(200).optional(), packs: z.array(z.string()).max(50).optional() }).parse(req.body);
      const h = await d.hub.get(param(req, "id"));
      await h.mutate((docs) => {
        const s = docs.session;
        if (body.packs) {
          const packs = withAgentPacks(body.packs, s);
          const old = new Set(packHosts(s.packs));
          const extra = (body.allowlist ?? s.allowlist).filter((x) => !old.has(x));
          return { next: { session: { ...s, packs, allowlist: allowlistFor(packs, extra) } } };
        }
        return { next: { session: { ...s, allowlist: body.allowlist ?? s.allowlist } } };
      });
      res.json({ ok: true });
    }),
  );

  api.put(
    "/sessions/:id/caps",
    wrap(async (req, res) => {
      const body = z
        .object({
          caps: capsSchema.partial().optional(),
          limits: limitsSchema.partial().optional(),
          /** Legacy: sets the worker's model and keeps its driver. */
          model: z.string().max(100).nullable().optional(),
          /** Replaces the agents block. Applies to the next worker that starts. */
          agents: sessionAgentsSchema.optional(),
          /** How tickets are worked; applies to the next run. */
          mode: sessionModeSchema.optional(),
        })
        .parse(req.body);
      const h = await d.hub.get(param(req, "id"));
      await h.mutate((docs) => {
        const s = docs.session;
        let agents = body.agents ?? s.agents;
        if (body.model !== undefined && !body.agents) {
          const worker = agentFor(s, "implementer");
          agents = { ...s.agents, worker: { driver: worker.driver, model: body.model?.trim() || undefined } };
        }
        const next = {
          ...s,
          caps: capsSchema.parse({ ...s.caps, ...body.caps }),
          limits: limitsSchema.parse({ ...s.limits, ...body.limits }),
          model: body.model === undefined ? s.model : body.model?.trim() || undefined,
          agents,
          mode: body.mode ?? s.mode,
        };
        // A newly chosen agent's backend joins the allowlist; the proxy picks it up before the next worker.
        const packs = withAgentPacks(next.packs, next);
        const allowlist = [...new Set([...next.allowlist, ...packHosts(packs)])];
        return { next: { session: { ...next, packs, allowlist } } };
      });
      res.json({ ok: true });
    }),
  );

  // --- inbox -------------------------------------------------------------------

  /**
   * Decide one or more actions of a request, with an optional free-text
   * answer. Approved network/pack/resources actions are applied here;
   * instruction and question actions just record what you said. The request
   * resolves, and the ticket returns to ready, once every action is decided.
   */
  api.post(
    "/sessions/:id/requests/:rid",
    wrap(async (req, res) => {
      const body = z
        .object({
          answer: z.string().max(8000).optional(),
          actions: z.array(z.object({ id: z.string(), decision: z.enum(["approve", "decline"]), note: z.string().max(8000).optional() })).default([]),
          declineAll: z.boolean().default(false),
        })
        .parse(req.body);
      const h = await d.hub.get(param(req, "id"));
      const request = h.inbox.requests.find((r) => r.id === param(req, "rid"));
      if (!request || request.state !== "open") {
        res.status(404).json({ error: "No open request with that id" });
        return;
      }
      const decisions = new Map(body.actions.map((a) => [a.id, a]));
      if (body.declineAll) for (const a of request.actions) if (a.state === "open" && !decisions.has(a.id)) decisions.set(a.id, { id: a.id, decision: "decline" });

      // Side effects first (they may take minutes), then one atomic update.
      const outcomes = new Map<string, { state: "approved" | "declined"; outcome: string }>();
      for (const a of request.actions) {
        const dec = decisions.get(a.id);
        if (!dec || a.state !== "open") continue;
        if (dec.decision === "decline") {
          outcomes.set(a.id, { state: "declined", outcome: dec.note ? `declined: ${dec.note}` : "declined" });
          continue;
        }
        outcomes.set(a.id, { state: "approved", outcome: await applyAction(d, h.id, a, dec.note) });
      }

      const result = await h.mutate((docs) => {
        const cur = docs.inbox.requests.find((r) => r.id === request.id)!;
        const actions: RequestAction[] = cur.actions.map((a) => {
          const o = outcomes.get(a.id);
          return o ? { ...a, state: o.state, outcome: o.outcome, decidedAt: now() } : a;
        });
        const allDecided = actions.every((a) => a.state !== "open");
        const resolved = allDecided && (actions.length > 0 || Boolean(body.answer) || body.declineAll || Boolean(cur.halt) || cur.actions.length === 0);
        const next: AgentRequest = { ...cur, actions, answer: body.answer ?? cur.answer, state: resolved ? "resolved" : "open", decidedAt: resolved ? now() : cur.decidedAt };
        const inbox: Inbox = { ...docs.inbox, requests: docs.inbox.requests.map((r) => (r.id === next.id ? next : r)) };
        let board = docs.board;
        let session = docs.session;
        for (const a of actions) {
          const o = outcomes.get(a.id);
          if (!o || o.state !== "approved") continue;
          const det = a.detail;
          if (det.kind === "network") {
            const entry = det.port ? `${det.host}:${det.port}` : det.host;
            if (!session.allowlist.includes(entry)) session = { ...session, allowlist: [...session.allowlist, entry] };
          } else if (det.kind === "pack") {
            session = { ...session, packs: [...new Set([...session.packs, det.pack])], allowlist: [...new Set([...session.allowlist, ...packHosts([det.pack])])] };
          } else if (det.kind === "resources") {
            session = {
              ...session,
              caps: capsSchema.parse({ ...session.caps, ...(det.workerMinutes ? { workerMinutes: det.workerMinutes } : {}), ...(det.workerTurns ? { workerTurns: det.workerTurns } : {}) }),
              limits: limitsSchema.parse({ ...session.limits, ...(det.memoryMb ? { memory: `${det.memoryMb}m` } : {}) }),
            };
          }
        }
        if (resolved && next.ticketId) {
          const t = getTicket(board, next.ticketId);
          board = addNote(board, t.id, "user", `${next.id} resolved${next.answer ? `: ${next.answer.slice(0, 500)}` : ""} (${actions.map((a) => `${a.id} ${a.state}`).join(", ") || "answered"})`);
          if (t.state === "waiting") board = transition(board, t.id, "ready", { by: "harness", text: "Request resolved; requeued" });
        }
        if (resolved && (session.state === "halted" || session.state === "waiting")) session = { ...session, state: isInitialized(session) ? "paused" : "setup" };
        return { next: { inbox, board, session }, result: next };
      });
      // Initialization keeps going while you answer: once every setup
      // request is decided, the setup worker runs again with the outcomes.
      const after = await d.hub.get(h.id);
      if (result.state === "resolved" && !result.ticketId && !isInitialized(after.session) && !after.inbox.requests.some((r) => r.state === "open" && !r.ticketId) && !d.runs.status(h.id)) {
        await d.runs.start(h.id, { init: true }).catch((e: Error) => console.warn(`[ui] could not continue initialization for ${h.id}: ${e.message}`));
      }
      res.json({ ok: true, request: result });
    }),
  );

  api.post(
    "/sessions/:id/messages/:mid/read",
    wrap(async (req, res) => {
      const h = await d.hub.get(param(req, "id"));
      await h.mutate((docs) => ({ next: { inbox: { ...docs.inbox, messages: docs.inbox.messages.map((m) => (m.id === param(req, "mid") ? { ...m, read: true } : m)) } } }));
      res.json({ ok: true });
    }),
  );

  api.post(
    "/sessions/:id/ideas/:iid/promote",
    wrap(async (req, res) => {
      const h = await d.hub.get(param(req, "id"));
      const idea = h.inbox.ideas.find((i) => i.id === param(req, "iid"));
      if (!idea) {
        res.status(404).json({ error: "No such idea" });
        return;
      }
      const id = await h.mutate((docs) => {
        const r = importBoard(docs.board, { tickets: [{ title: idea.title, kind: "feature", spec: idea.pitch, notes: [`From idea ${idea.id}`] }] }, { by: "user", defaultState: "backlog" });
        const inbox: Inbox = { ...docs.inbox, ideas: docs.inbox.ideas.map((i) => (i.id === idea.id ? { ...i, promotedTo: r.created[0] } : i)) };
        return { next: { board: r.board, inbox }, result: r.created[0] };
      });
      res.status(201).json({ id });
    }),
  );

  app.use("/api", api);
  return app;
};

/** The side effect of approving one action; returns the outcome text the worker will read. */
const applyAction = async (d: UiApiDeps, sessionId: string, a: RequestAction, note?: string): Promise<string> => {
  const det = a.detail;
  if (det.kind === "network") return `allowed${note ? `: ${note}` : ""}`;
  if (det.kind === "pack") return `allowed ${packHosts([det.pack]).filter((h) => h !== "api.anthropic.com").join(", ")}${note ? ` (${note})` : ""}`;
  if (det.kind === "resources") return `applied${note ? `: ${note}` : ""}`;
  if (det.kind === "instruction") return note ? `done: ${note}` : "done";
  return note ? `answer: ${note}` : "answered without text";
};

export { loadConfig, saveConfig, sessionPaths };

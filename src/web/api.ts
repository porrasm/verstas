import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import os from "node:os";
import express, { type Request, type Response } from "express";
import { z } from "zod";
import {
  capsSchema,
  limitsSchema,
  now,
  ticketIdSchema,
  ticketImportSchema,
  ticketKindSchema,
  ticketSizeSchema,
  ticketStateSchema,
  type AgentRequest,
  type Inbox,
  type Run,
  type Session,
  type Ticket,
} from "../core/types.js";
import { emptyBoard, addNote, BoardError, exportBoard, getTicket, importBoard, parseBoardPaste, replaceTicket, transition, validateDeps, validateRepos, canTransition } from "../board/board.js";
import { configSchema, loadConfig, loadSecrets, saveConfig, saveSecrets, verstasHome, workTargetSchema, type Config } from "../config.js";
import type { SessionHub } from "../sessions/hub.js";
import { createSession, deleteSessionDir, listSessions, sessionPaths } from "../sessions/sessions.js";
import { removeSandbox, runRootCommand, sandboxStatus, stopSandbox, type SandboxConfig } from "../sandbox/lifecycle.js";
import { dockerAvailable } from "../sandbox/docker.js";
import type { RunManager } from "../harness/run.js";
import { dockerShell, ensureSessionSandbox, type RunManagerConfig } from "../harness/docker-worker.js";

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
};

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response) => {
    fn(req, res).catch((e: unknown) => {
      if (e instanceof z.ZodError) {
        const msg = `Invalid input: ${e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`;
        console.warn(`[ui] 400 ${req.method} ${req.originalUrl}: ${msg}`);
        res.status(400).json({ error: msg });
      } else if (e instanceof BoardError) {
        console.warn(`[ui] ${req.method} ${req.originalUrl}: ${e.message}`);
        res.status(e.code === "unknown_ticket" ? 404 : 409).json({ error: e.message });
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
      res.json({ version: d.version, docker, image: image ? image.code === 0 : false, imageName: cfg.devboxImage, sessionsRoot: cfg.sessionsRoot, hasClaudeToken: Boolean(secrets.claudeToken) });
    }),
  );

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
      const { claudeToken } = z.object({ claudeToken: z.string().min(10).max(4000) }).parse(req.body);
      await saveSecrets({ ...(await loadSecrets()), claudeToken: claudeToken.trim() });
      res.json({ ok: true });
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
      const out = await execFileP("git", ["-C", t.path, "for-each-ref", "--format=%(refname:short)", "refs/heads/"]);
      const current = await execFileP("git", ["-C", t.path, "symbolic-ref", "--short", "HEAD"]).then((r) => r.stdout.trim()).catch(() => "");
      res.json({ current, branches: out.stdout.split("\n").filter(Boolean) });
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

  // --- sessions ----------------------------------------------------------------

  const summarize = async (s: Session) => {
    const h = await d.hub.get(s.id);
    const counts: Record<string, number> = {};
    for (const t of h.board.tickets) counts[t.state] = (counts[t.state] ?? 0) + 1;
    const run = d.runs.status(s.id) ?? (await lastRun(h.paths.runs));
    return { session: h.session, counts, run, openRequests: h.inbox.requests.filter((r) => r.state === "open").length, ideas: h.inbox.ideas.filter((i) => !i.promotedTo).length };
  };

  api.get(
    "/sessions",
    wrap(async (_req, res) => {
      const sessions = await listSessions(d.getConfig().sessionsRoot);
      res.json(await Promise.all(sessions.map(summarize)));
    }),
  );

  const createBody = z.object({
    name: z.string().min(1).max(200),
    goal: z.string().max(20_000).default(""),
    repos: z.array(z.object({ target: z.string(), branch: z.string().optional(), name: z.string().optional() })).default([]),
    uploads: z.array(z.object({ id: z.string().regex(/^[a-f0-9]{16}$/), name: z.string() })).default([]),
    allowlist: z.array(z.string()).optional(),
    model: z.string().max(100).optional(),
    caps: capsSchema.partial().optional(),
    limits: limitsSchema.partial().optional(),
    board: z.string().optional(),
    plan: z.boolean().default(false),
  });

  api.post(
    "/sessions",
    wrap(async (req, res) => {
      const input = createBody.parse(req.body);
      const cfg = d.getConfig();
      const repos = input.repos.map((r) => {
        const target = cfg.workTargets.find((w) => w.name === r.target);
        if (!target) throw new Error(`Unknown work target ${r.target}`);
        return { target, branch: r.branch, name: r.name };
      });
      const zips = input.uploads.map((u) => ({ name: u.name, file: path.join(uploadsDir, `${u.id}.zip`) }));
      // Validate the pasted board against the chosen repositories BEFORE cloning anything.
      const repoNames = repos.map((r) => r.name ?? r.target.name);
      const pasted = input.board?.trim() ? parseBoardPaste(input.board) : undefined;
      if (pasted) {
        const preview = importBoard(emptyBoard(), pasted, { by: "user", defaultState: "ready" });
        validateRepos(preview.board.tickets, repoNames);
      }
      await fs.mkdir(cfg.sessionsRoot, { recursive: true });
      const created = await createSession(cfg.sessionsRoot, { ...input, repos, zips, image: cfg.devboxImage });
      for (const z of zips) await fs.rm(z.file, { force: true });
      let imported: { created: string[]; skipped: { title: string; reason: string }[] } | undefined;
      if (pasted) {
        const h = await d.hub.get(created.session.id);
        imported = await h.mutate((docs) => {
          const r = importBoard(docs.board, pasted, { by: "user", defaultState: "ready" });
          return { next: { board: r.board }, result: { created: r.created, skipped: r.skipped } };
        });
      }
      if (input.plan) await d.runs.start(created.session.id, { plan: true });
      res.status(201).json({ session: created.session, clones: created.clones, extracts: created.extracts, imported });
    }),
  );

  api.get(
    "/sessions/:id",
    wrap(async (req, res) => {
      const h = await d.hub.get(param(req, "id"));
      const run = d.runs.status(h.id) ?? (await lastRun(h.paths.runs));
      const sandbox = await sandboxStatus(d.sandbox, h.id).catch(() => null);
      res.json({ session: h.session, board: h.board, inbox: h.inbox, run, sandbox, active: Boolean(d.runs.status(h.id)) });
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
      await removeSandbox(d.sandbox, id).catch(() => undefined);
      await deleteSessionDir(d.getConfig().sessionsRoot, id);
      d.hub.forget(id);
      res.json({ ok: true });
    }),
  );

  api.post(
    "/sessions/:id/run",
    wrap(async (req, res) => {
      const { action } = z.object({ action: z.enum(["start", "plan", "pause", "stop"]) }).parse(req.body);
      const id = param(req, "id");
      if (action === "start" || action === "plan") {
        const ctl = await d.runs.start(id, { plan: action === "plan" });
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

  // --- export ------------------------------------------------------------------

  api.post(
    "/sessions/:id/export",
    wrap(async (req, res) => {
      const h = await d.hub.get(param(req, "id"));
      if (d.runs.status(h.id)) {
        res.status(409).json({ error: "Pause or stop the run first" });
        return;
      }
      await ensureSessionSandbox(d.runConfig, h.session, path.join(h.paths.dir, "sandbox.env"), undefined);
      const sh = dockerShell(d.sandbox, h.id);
      await sh.exec(["mkdir", "-p", "/workspace/.verstas/export"]);
      const files: { repo: string; file: string; branch: string; bytes: number }[] = [];
      for (const repo of h.session.repos) {
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
      await stopSandbox(d.sandbox, h.id);
      res.json({
        files,
        howTo: files.map((f) => `cd <your ${f.repo} checkout> && git fetch "${f.file}" ${f.branch}:${f.branch} && git log --oneline ${f.branch}`),
      });
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
        return { next: { board: r.board }, result: { created: r.created, updated: r.updated, skipped: r.skipped } };
      });
      res.json(result);
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
        const next: Ticket = { ...t, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)), repo: patch.repo === null ? undefined : (patch.repo ?? t.repo), updatedAt: now() } as Ticket;
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

  api.put(
    "/sessions/:id/goal",
    wrap(async (req, res) => {
      const { goal } = z.object({ goal: z.string().max(20_000) }).parse(req.body);
      const h = await d.hub.get(param(req, "id"));
      await h.mutate((docs) => ({ next: { board: { ...docs.board, goal }, session: { ...docs.session, goal } } }));
      res.json({ ok: true });
    }),
  );

  api.put(
    "/sessions/:id/allowlist",
    wrap(async (req, res) => {
      const { allowlist } = z.object({ allowlist: z.array(z.string().trim().min(1).max(260)).max(200) }).parse(req.body);
      const h = await d.hub.get(param(req, "id"));
      await h.mutate((docs) => ({ next: { session: { ...docs.session, allowlist } } }));
      res.json({ ok: true });
    }),
  );

  api.put(
    "/sessions/:id/caps",
    wrap(async (req, res) => {
      const body = z.object({ caps: capsSchema.partial().optional(), limits: limitsSchema.partial().optional(), model: z.string().max(100).nullable().optional() }).parse(req.body);
      const h = await d.hub.get(param(req, "id"));
      await h.mutate((docs) => ({
        next: {
          session: {
            ...docs.session,
            caps: capsSchema.parse({ ...docs.session.caps, ...body.caps }),
            limits: limitsSchema.parse({ ...docs.session.limits, ...body.limits }),
            model: body.model === undefined ? docs.session.model : body.model?.trim() || undefined,
          },
        },
      }));
      res.json({ ok: true });
    }),
  );

  // --- inbox -------------------------------------------------------------------

  api.post(
    "/sessions/:id/requests/:rid",
    wrap(async (req, res) => {
      const { decision, answer } = z.object({ decision: z.enum(["approve", "deny"]), answer: z.string().max(5000).optional() }).parse(req.body);
      const h = await d.hub.get(param(req, "id"));
      const request = h.inbox.requests.find((r) => r.id === param(req, "rid"));
      if (!request || request.state !== "open") {
        res.status(404).json({ error: "No open request with that id" });
        return;
      }
      let applied = "";
      if (decision === "approve") applied = await applyRequest(d, h.id, request);
      const state = decision === "approve" ? "approved" : "denied";
      await h.mutate((docs) => {
        const inbox: Inbox = { ...docs.inbox, requests: docs.inbox.requests.map((r) => (r.id === request.id ? { ...r, state, answer: [answer, applied].filter(Boolean).join(" ") || undefined, decidedAt: now() } : r)) };
        let board = docs.board;
        let session = docs.session;
        if (request.ticketId) {
          const t = getTicket(board, request.ticketId);
          board = addNote(board, t.id, "user", `${request.id} ${state}${answer ? `: ${answer}` : ""}${applied ? ` (${applied})` : ""}`);
          if (t.state === "waiting") board = transition(board, t.id, "ready", { by: "harness", text: "Request answered; requeued" });
        }
        if (request.detail.kind === "network" && decision === "approve") {
          const entry = request.detail.port ? `${request.detail.host}:${request.detail.port}` : request.detail.host;
          if (!session.allowlist.includes(entry)) session = { ...session, allowlist: [...session.allowlist, entry] };
        }
        if (request.detail.kind === "root_command" && decision === "approve") {
          session = { ...session, rootCommands: [...session.rootCommands, { command: request.detail.command, cwd: request.detail.cwd, at: now(), requestId: request.id }] };
        }
        if (request.detail.kind === "resources" && decision === "approve") {
          const r = request.detail;
          session = {
            ...session,
            caps: capsSchema.parse({ ...session.caps, ...(r.workerMinutes ? { workerMinutes: r.workerMinutes } : {}), ...(r.workerTurns ? { workerTurns: r.workerTurns } : {}) }),
            limits: limitsSchema.parse({ ...session.limits, ...(r.memoryMb ? { memory: `${r.memoryMb}m` } : {}) }),
          };
        }
        if (session.state === "halted" || session.state === "waiting") session = { ...session, state: "paused" };
        return { next: { inbox, board, session } };
      });
      res.json({ ok: true, applied });
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

/** Side effects of approving a request that need the sandbox now; the rest is recorded on the session. */
const applyRequest = async (d: UiApiDeps, sessionId: string, request: AgentRequest): Promise<string> => {
  const det = request.detail;
  if (det.kind === "root_command") {
    const h = await d.hub.get(sessionId);
    const st = await sandboxStatus(d.sandbox, sessionId).catch(() => null);
    if (st?.container !== "running") {
      // Bring the box up without a run token: the command does not need one.
      await ensureSessionSandbox(d.runConfig, h.session, path.join(h.paths.dir, "sandbox.env"), undefined);
    }
    const r = await runRootCommand(d.sandbox, sessionId, det.command, det.cwd);
    const tail = r.output.trim().split("\n").slice(-30).join("\n");
    return `${r.ok ? "ran as root, exit 0" : `ran as root, exit ${r.code}`}${tail ? `\n--- output (tail) ---\n${tail}` : ""}`;
  }
  if (det.kind === "network") return "added to the allowlist";
  if (det.kind === "resources") return "caps updated";
  return "";
};

const lastRun = async (runsDir: string): Promise<Run | undefined> => {
  try {
    const ids = (await fs.readdir(runsDir)).map(Number).filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => b - a);
    for (const id of ids) {
      try {
        return JSON.parse(await fs.readFile(path.join(runsDir, String(id), "run.json"), "utf8")) as Run;
      } catch {
        continue;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
};

export { loadConfig, saveConfig, sessionPaths };

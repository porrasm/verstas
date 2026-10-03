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
  needsSetup,
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
  type Ticket,
} from "../core/types.js";
import { emptyBoard, addNote, BoardError, exportBoard, getTicket, importBoard, parseBoardPaste, replaceTicket, transition, validateDeps, validateRepos, canTransition } from "../board/board.js";
import { configSchema, loadConfig, loadSecrets, saveConfig, saveSecrets, verstasHome, workTargetSchema, type Config } from "../config.js";
import type { SessionHub } from "../sessions/hub.js";
import { createSession, deleteSessionDir, listSessions, sessionPaths } from "../sessions/sessions.js";
import { applyBundle, ApplyError } from "../sessions/apply.js";
import type { SessionHandle } from "../sessions/hub.js";
import { removeSandbox, runRootScript, sandboxStatus, snapshotSandbox, stopSandbox, type SandboxConfig } from "../sandbox/lifecycle.js";
import { dockerAvailable } from "../sandbox/docker.js";
import type { RunManager } from "../harness/run.js";
import { dockerShell, ensureSessionSandbox, runSetup, type RunManagerConfig } from "../harness/docker-worker.js";
import { deleteScript, getScript, hostsFromScript, listScripts, saveScript, setupScriptSchema } from "../scripts/library.js";
import { buildContext, probeImage } from "../context/context.js";
import { detectPacksInRepo, NETWORK_PACKS, packHosts } from "../network/packs.js";

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
      // One unreadable session must not hide the others: report it as a row with an error.
      const rows = await Promise.all(
        sessions.map(async (s) => {
          try {
            return await summarize(s);
          } catch (e) {
            console.warn(`[ui] session ${s.id} could not be summarised: ${(e as Error).message}`);
            return { session: s, counts: {}, run: undefined, openRequests: 0, ideas: 0, error: (e as Error).message };
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
    model: z.string().max(100).optional(),
    setupScripts: z.array(z.string()).default([]),
    caps: capsSchema.partial().optional(),
    limits: limitsSchema.partial().optional(),
    board: z.string().optional(),
    requirements: z.string().max(20_000).optional(),
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
      const setupScripts = [];
      for (const name of input.setupScripts) setupScripts.push(await getScript(name));
      await fs.mkdir(cfg.sessionsRoot, { recursive: true });
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
      // With requirements, setup starts at once: it is the part that needs you, so it should happen while you are here.
      if (created.session.requirements.trim()) await d.runs.start(created.session.id, { setup: true });
      else if (input.plan) await d.runs.start(created.session.id, { plan: true });
      res.status(201).json({ session: created.session, clones: created.clones, extracts: created.extracts, imported });
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
      res.json({ session: h.session, board: h.board, inbox: h.inbox, run, runs: all, totals: runTotals(all, h.session.createdAt), sandbox, active: Boolean(live) });
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
          ctl = await d.runs.start(id, { plan: action === "plan", brief: action === "brief", setup: action === "setup", prompt: action === "prompt" ? (prompt ?? "") : undefined });
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
      if (d.runs.status(h.id)) {
        res.status(409).json({ error: "Pause or stop the run first" });
        return;
      }
      await ensureSessionSandbox(d.runConfig, h.session, path.join(h.paths.dir, "sandbox.env"), undefined).catch(() => undefined);
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
   * Set or clear the session requirements. A change reopens the gate: the
   * last verdict was about the old requirements. Empty requirements mean no
   * setup phase.
   */
  api.put(
    "/sessions/:id/requirements",
    wrap(async (req, res) => {
      const { requirements } = z.object({ requirements: z.string().max(20_000) }).parse(req.body);
      const h = await d.hub.get(param(req, "id"));
      const session = await h.mutate((docs) => {
        const changed = docs.session.requirements.trim() !== requirements.trim();
        const next = { ...docs.session, requirements: requirements.trim(), readiness: changed ? undefined : docs.session.readiness };
        const state = needsSetup(next) && !d.runs.status(h.id) ? "setup" : docs.session.state === "setup" ? "created" : docs.session.state;
        return { next: { session: { ...next, state } }, result: next };
      });
      res.json({ ok: true, session });
    }),
  );

  /** You confirm the setup worker's "ready" verdict; tickets may run from now on. Optionally starts the work run. */
  api.post(
    "/sessions/:id/setup/confirm",
    wrap(async (req, res) => {
      const { start } = z.object({ start: z.boolean().default(false) }).parse(req.body ?? {});
      const h = await d.hub.get(param(req, "id"));
      if (h.session.readiness?.verdict !== "ready") {
        res.status(409).json({ error: "The setup worker has not reported the environment ready. Run setup again, or clear the requirements to skip the setup phase." });
        return;
      }
      // Commit the box as it is now, so a recreate starts from a set-up environment. Best effort: a failed snapshot leaves the recipe as the fallback.
      let snapshot: { image: string; baseImageId: string } | undefined;
      let snapshotError: string | undefined;
      if (d.runs.status(h.id)) snapshotError = "a run is active; no snapshot taken";
      else if ((await sandboxStatus(d.sandbox, h.id).catch(() => null))?.container === "running") {
        snapshot = await snapshotSandbox(d.sandbox, h.session).catch((e: Error) => {
          snapshotError = e.message;
          return undefined;
        });
      } else snapshotError = "the container is not running; no snapshot taken";
      await h.mutate((docs) => ({
        next: {
          session: {
            ...docs.session,
            readiness: { ...docs.session.readiness!, confirmedAt: now() },
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
    await ensureSessionSandbox(d.runConfig, h.session, path.join(h.paths.dir, "sandbox.env"), undefined);
    const sh = dockerShell(d.sandbox, h.id);
    await sh.exec(["mkdir", "-p", "/workspace/.verstas/export"]);
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

  /**
   * Decide one or more actions of a request, with an optional free-text
   * answer. Approved network/resources/root_script actions are applied here;
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
          } else if (det.kind === "root_script") {
            session = { ...session, rootScripts: [...session.rootScripts, { script: det.script, cwd: det.cwd, at: now(), requestId: next.id }] };
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
        if (resolved && (session.state === "halted" || session.state === "waiting")) session = { ...session, state: needsSetup(session) ? "setup" : "paused" };
        return { next: { inbox, board, session }, result: next };
      });
      // The setup phase keeps going while you answer: once every setup
      // request is decided, the setup worker runs again with the outcomes.
      const after = await d.hub.get(h.id);
      if (result.state === "resolved" && !result.ticketId && needsSetup(after.session) && !after.inbox.requests.some((r) => r.state === "open" && !r.ticketId) && !d.runs.status(h.id)) {
        await d.runs.start(h.id, { setup: true }).catch((e: Error) => console.warn(`[ui] could not restart setup for ${h.id}: ${e.message}`));
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
  if (det.kind === "root_script") {
    const h = await d.hub.get(sessionId);
    const st = await sandboxStatus(d.sandbox, sessionId).catch(() => null);
    if (st?.container !== "running") await ensureSessionSandbox(d.runConfig, h.session, path.join(h.paths.dir, "sandbox.env"), undefined);
    const r = await runRootScript(d.sandbox, sessionId, det.script, det.cwd);
    const tail = r.output.trim().split("\n").slice(-30).join("\n");
    return `${r.ok ? "ran as root, exit 0" : `ran as root, exit ${r.code}`}${note ? ` (${note})` : ""}${tail ? `\n--- output (tail) ---\n${tail}` : ""}`;
  }
  if (det.kind === "network") return `allowed${note ? `: ${note}` : ""}`;
  if (det.kind === "pack") return `allowed ${packHosts([det.pack]).filter((h) => h !== "api.anthropic.com").join(", ")}${note ? ` (${note})` : ""}`;
  if (det.kind === "resources") return `applied${note ? `: ${note}` : ""}`;
  if (det.kind === "instruction") return note ? `done: ${note}` : "done";
  return note ? `answer: ${note}` : "answered without text";
};

/** Every run.json under runs/, oldest first; unreadable ones are skipped. */
const allRuns = async (runsDir: string): Promise<Run[]> => {
  const out: Run[] = [];
  try {
    const ids = (await fs.readdir(runsDir)).map(Number).filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => a - b);
    for (const id of ids) {
      try {
        out.push(JSON.parse(await fs.readFile(path.join(runsDir, String(id), "run.json"), "utf8")) as Run);
      } catch {
        continue;
      }
    }
  } catch {
    return out;
  }
  return out;
};

/** What the UI shows in a header: money spent over every run, how many runs, when something last happened. */
const runTotals = (runs: Run[], createdAt: string): { usd: number; runs: number; lastActivityAt: string } => {
  let last = createdAt;
  let usd = 0;
  for (const r of runs) {
    usd += r.cost.usd ?? 0;
    for (const t of [r.startedAt, r.endedAt]) if (t && t > last) last = t;
  }
  return { usd, runs: runs.length, lastActivityAt: last };
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

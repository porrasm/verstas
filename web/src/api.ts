import { useEffect, useRef, useState } from "react";

/** Thin fetch helpers and the WebSocket hook. Types mirror src/core/types.ts loosely. */

export type Ticket = {
  id: string;
  title: string;
  kind: string;
  repo?: string;
  size: string;
  priority: number;
  deps: string[];
  state: string;
  spec: string;
  acceptance: string[];
  notes: { at: string; by: string; text: string }[];
  attempts: number;
  pinned: boolean;
  report?: string;
  diff?: { added: number; removed: number; files: number };
  cost?: { usd?: number };
  createdAt: string;
  updatedAt: string;
};
export type Board = { goal: string; tickets: Ticket[] };
export type ActionDetail =
  | { kind: "network"; host: string; port?: number }
  | { kind: "pack"; pack: string }
  | { kind: "resources"; workerMinutes?: number; workerTurns?: number; memoryMb?: number }
  | { kind: "instruction"; text: string }
  | { kind: "question"; text: string; options?: string[] };
export type RequestAction = { id: string; detail: ActionDetail; state: "open" | "approved" | "declined"; outcome?: string; decidedAt?: string };
export type AgentRequest = { id: string; ticketId?: string; summary: string; actions: RequestAction[]; halt?: { reason: string; severity: string }; state: "open" | "resolved"; answer?: string; createdAt: string; decidedAt?: string };
export type Inbox = {
  requests: AgentRequest[];
  messages: { id: string; ticketId?: string; text: string; createdAt: string; read: boolean }[];
  ideas: { id: string; ticketId?: string; title: string; pitch: string; createdAt: string; promotedTo?: string }[];
};
export type Session = {
  id: string;
  name: string;
  goal: string;
  createdAt: string;
  image: string;
  /** Legacy: the worker's Claude model from before `agents`; read through agentFor. */
  model?: string;
  agents?: SessionAgents;
  repos: { name: string; sourcePath: string; branch: string; runBranch: string; baseCommit?: string }[];
  attachments: { name: string; dir: string; bytes: number; skipped: string[] }[];
  allowlist: string[];
  packs: string[];
  caps: { workerMinutes: number; workerTurns: number; runTickets: number; budgetUsd: number; ticketAttempts: number; reviewer: boolean };
  limits: { memory: string; cpus: number; pids: number; workspaceMb: number };
  rootScripts: { script: string; cwd?: string; at: string; requestId?: string }[];
  setupScripts: { name: string; description: string; hosts: string[]; note: string; script: string; runAs: "root" | "agent" }[];
  setup: { name: string; ok: boolean; code: number; at: string; tail: string }[];
  requirements: string;
  readiness?: Readiness;
  prompts: { at: string; runId: number; text: string; reply: string; stopReason: string }[];
  state: string;
  /** Shown on the remote dashboard; off by default. */
  remote: boolean;
};
export type RemoteSettings = {
  enabled: boolean;
  baseUrl: string;
  hasToken: boolean;
  status: { state: "off" | "unconfigured" | "connecting" | "connected" | "error"; error?: string; lastPushAt?: string; lastCommandAt?: string; shared: number };
};
export type Readiness = { verdict: "ready" | "needs"; at: string; summary: string; checks: { text: string; ok: boolean }[]; confirmedAt?: string };
/** Tickets wait for the environment: requirements set and not confirmed. Mirrors src/core/types.ts. */
export const needsSetup = (s: { requirements: string; readiness?: Readiness }): boolean => Boolean(s.requirements.trim()) && !s.readiness?.confirmedAt;
export type NetworkPack = { name: string; title: string; hosts: string[]; /** Set on the packs that follow an agent choice instead of being ticked. */ agent?: DriverName };
export type SetupScript = { name: string; description: string; hosts: string[]; note: string; script: string; runAs: "root" | "agent"; env: string };
export type Run = { id: number; state: string; startedAt: string; endedAt?: string; currentTicket?: string; ticketsDone: number; cost: { usd?: number }; pauseReason?: string; resumeAt?: string };
export type VEvent = { kind: string; t: string; ticket?: string; [k: string]: unknown };
export type Totals = { usd: number; runs: number; lastActivityAt: string };
export type SessionSummary = { session: Session; counts: Record<string, number>; run?: Run; openRequests: number; ideas: number; totals?: Totals; /** The session container, as Docker sees it. */ sandbox?: "running" | "stopped" | "absent"; error?: string };
export type Sandbox = { network: boolean; proxy: "running" | "stopped" | "absent"; container: "running" | "stopped" | "absent" };
export type SessionDetail = { session: Session; board: Board; inbox: Inbox; run?: Run; runs: Run[]; totals: Totals; sandbox: Sandbox | null; active: boolean; /** The session directory on this machine. */ dir: string };
export type DriverName = "claude" | "codex" | "cursor";
export type AgentSpec = { driver: DriverName; model?: string };
export type SessionAgents = { worker?: AgentSpec; reviewer?: AgentSpec };
export type WorkerRole = "implementer" | "reviewer" | "planner" | "setup" | "prompt";
/** Mirrors src/core/types.ts agentFor: the reviewer defaults to the worker; sessions from before `agents` ran Claude with `model`. */
export const agentFor = (s: { model?: string; agents?: SessionAgents }, role: WorkerRole): AgentSpec => {
  const worker: AgentSpec = s.agents?.worker ?? { driver: "claude", model: s.model || undefined };
  return role === "reviewer" && s.agents?.reviewer ? s.agents.reviewer : worker;
};
/** One driver as /status lists it: what the UI needs to offer it and to warn when it cannot run. */
export type DriverInfo = { name: DriverName; title: string; models: string[]; hint: string; reportsCost: boolean; configured: boolean; codexAuthAgeDays?: number };
export type Status = {
  version: string;
  docker: { ok: boolean; detail: string };
  image: boolean;
  imageName: string;
  sessionsRoot: string;
  hasClaudeToken: boolean;
  credentials: Record<DriverName, boolean>;
  drivers: DriverInfo[];
};
export type Config = { sessionsRoot: string; workTargets: { name: string; path: string }[]; uiPort: number; agentApiPort: number; devboxImage: string; linuxHost: boolean };

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export const api = async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) throw new ApiError(res.status, (json as { error?: string })?.error ?? `HTTP ${res.status}`);
  return json as T;
};

export const upload = async (file: File): Promise<{ id: string; name: string; bytes: number }> => {
  const res = await fetch("/api/uploads", { method: "POST", headers: { "x-filename": file.name, "content-type": "application/zip" }, body: file });
  if (!res.ok) throw new ApiError(res.status, ((await res.json()) as { error?: string }).error ?? "upload failed");
  return (await res.json()) as { id: string; name: string; bytes: number };
};

type WsMessage =
  | { type: "change"; sessionId: string; board?: Board; inbox?: Inbox; session?: Session }
  | { type: "event"; sessionId: string; runId: number; event: VEvent }
  | { type: "draft"; draftId: string; deleted: boolean };

/** A draft session (src/drafts/draft.ts): prepared by an assistant, created by you. */
export type DraftTicket = { id: string; title: string; kind?: string; repo?: string; size?: string; priority?: number; deps?: string[]; state?: string; spec?: string; acceptance?: string[]; notes?: string[]; pinned?: boolean };
export type Draft = {
  id: string;
  name: string;
  goal: string;
  requirements: string;
  notes: string;
  repos: { target: string; branch?: string; name?: string }[];
  packs: string[];
  extraHosts: string[];
  recipes: string[];
  tickets: DraftTicket[];
  createdBy: "agent" | "user";
  createdAt: string;
  updatedAt: string;
  promotedTo?: string;
  promotedAt?: string;
};
export type DraftProblems = { errors: string[]; warnings: string[] };
export type DraftDetail = { draft: Draft; problems: DraftProblems; boardText: string };
export type DraftRow = { id: string; name: string; goal: string; tickets: number; repos: string[]; errors: number; warnings: number; createdBy: string; createdAt: string; updatedAt: string; promotedTo?: string };
export type McpSetup = { url: string; claudeCode: string; desktopConfig: string; stdioBuilt: boolean; prompt: string };

/** One socket per page; reconnects with backoff; delivers parsed messages to the latest handler. */
export const useLive = (onMessage: (m: WsMessage) => void): boolean => {
  const [connected, setConnected] = useState(false);
  const handler = useRef(onMessage);
  handler.current = onMessage;
  useEffect(() => {
    let ws: WebSocket | null = null;
    let timer: number | undefined;
    let closed = false;
    let delay = 500;
    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onopen = () => {
        setConnected(true);
        delay = 500;
      };
      ws.onmessage = (e) => {
        try {
          handler.current(JSON.parse(e.data as string) as WsMessage);
        } catch {
          // ignore
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (!closed) {
          timer = window.setTimeout(connect, delay);
          delay = Math.min(delay * 2, 10_000);
        }
      };
      ws.onerror = () => ws?.close();
    };
    connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }, []);
  return connected;
};

export const fmtTime = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
};
export const fmtDateTime = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
};
/** "just now", "4 min ago", "3 h ago", "2 d ago". */
export const fmtAgo = (iso: string, now = Date.now()): string => {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
};
/** "14 s", "12 min", "2 h 05 min". */
export const fmtDuration = (fromIso: string, toIso?: string, now = Date.now()): string => {
  const a = new Date(fromIso).getTime();
  const b = toIso ? new Date(toIso).getTime() : now;
  if (Number.isNaN(a) || Number.isNaN(b)) return "";
  const s = Math.max(0, Math.round((b - a) / 1000));
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
};
export const fmtUsd = (n?: number): string => (n === undefined ? "" : `$${n.toFixed(2)}`);
/** A ticking "now" for the relative-time labels; re-renders every `ms`. */
export const useNow = (ms = 30_000): number => {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
};

export const TICKET_STATES = ["backlog", "ready", "in_progress", "review", "waiting", "blocked", "done"] as const;
export const STATE_LABEL: Record<string, string> = { backlog: "Backlog", ready: "Ready", in_progress: "In progress", review: "Review", waiting: "Waiting", blocked: "Blocked", done: "Done" };
export const fmtBytes = (n: number): string => (n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} kB`);

/** Models offered in the UI; any other id or alias can be typed. */
/** Clipboard write with a fallback for views that refuse it. */
export const copyText = async (text: string): Promise<void> => {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
};
export type ApplyResult = { targetPath: string; branch: string; base: string | null; commits: { sha: string; subject: string }[]; howTo: string[] };

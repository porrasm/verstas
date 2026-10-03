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
export type AgentRequest = { id: string; ticketId?: string; detail: Record<string, unknown> & { kind: string }; why: string; state: string; answer?: string; createdAt: string };
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
  model?: string;
  repos: { name: string; sourcePath: string; branch: string; runBranch: string }[];
  attachments: { name: string; dir: string; bytes: number; skipped: string[] }[];
  allowlist: string[];
  caps: { workerMinutes: number; workerTurns: number; runTickets: number; budgetUsd: number; ticketAttempts: number; reviewer: boolean };
  limits: { memory: string; cpus: number; pids: number; workspaceMb: number };
  rootCommands: { command: string; cwd?: string; at: string; requestId?: string }[];
  state: string;
};
export type Run = { id: number; state: string; startedAt: string; endedAt?: string; currentTicket?: string; ticketsDone: number; cost: { usd?: number }; pauseReason?: string; resumeAt?: string };
export type VEvent = { kind: string; t: string; ticket?: string; [k: string]: unknown };
export type SessionSummary = { session: Session; counts: Record<string, number>; run?: Run; openRequests: number; ideas: number; error?: string };
export type SessionDetail = { session: Session; board: Board; inbox: Inbox; run?: Run; sandbox: { network: boolean; proxy: string; container: string } | null; active: boolean };
export type Status = { version: string; docker: { ok: boolean; detail: string }; image: boolean; imageName: string; sessionsRoot: string; hasClaudeToken: boolean };
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

type WsMessage = ({ type: "change"; sessionId: string; board?: Board; inbox?: Inbox; session?: Session }) | { type: "event"; sessionId: string; runId: number; event: VEvent };

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
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
};
export const fmtUsd = (n?: number): string => (n === undefined ? "" : `$${n.toFixed(2)}`);
export const fmtBytes = (n: number): string => (n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} kB`);

/** Models offered in the UI; any other id or alias can be typed. */
export const MODEL_CHOICES = ["claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1", "claude-haiku-4-5-20251001", "sonnet", "opus", "haiku"];

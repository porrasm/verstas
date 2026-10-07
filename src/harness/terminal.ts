import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { DriverName } from "../core/types.js";

/**
 * Agent terminals: you type to Claude Code or Codex in their own interface,
 * running in the session's box with the board tools. The run that owns one
 * is an ordinary run of its own kind (run.terminal), so only one thing
 * happens in a session at a time, and starting a work run ends it.
 *
 * The process side is behind TerminalRunner so the run loop is tested with
 * a fake; src/harness/docker-terminal.ts is the real one.
 */

/** A running agent TUI in the box. */
export interface TerminalProcess {
  write(data: Buffer | string): void;
  resize(cols: number, rows: number): void;
  onData(fn: (chunk: Buffer) => void): void;
  /** Resolves with the exit code when the process has ended (null when unknown). */
  exited: Promise<number | null>;
  /** Ends it: a hangup first so the agent can save, then harder. Resolves once it is gone. */
  kill(): Promise<void>;
}

export type TerminalOpenSpec = {
  driver: DriverName;
  /** The job file inside the container (src/worker/terminal.ts reads it). */
  jobFile: string;
  /** Host path of the job's credential hand-back file (Codex rotates its login). */
  credentialFile: string;
  runToken: string;
  cols: number;
  rows: number;
};

export interface TerminalRunner {
  open(spec: TerminalOpenSpec): Promise<TerminalProcess>;
}

/** What the page receives besides the terminal's bytes. */
export type TerminalNotice = { type: "status"; text: string } | { type: "exit"; code: number | null; stopped: boolean };

/** One attached page (a WebSocket): bytes go to `data`, notices to `notice`. */
export type TerminalClient = { data: (chunk: Buffer) => void; notice: (n: TerminalNotice) => void };

/** How much of the screen history a page that attaches late gets replayed. */
const SCROLLBACK_BYTES = 512 * 1024;

/**
 * The terminal as the pages see it: it exists from the moment the run is
 * asked for (so a page can attach while the box is still starting), keeps
 * the recent output for pages that attach later or reload, and passes
 * keystrokes and the window size to the process once it runs.
 */
export class LiveTerminal {
  /** Proves a page may attach; handed only to the UI's own API (see the /ws/terminal upgrade). */
  readonly key = randomBytes(24).toString("base64url");
  private proc: TerminalProcess | null = null;
  private clients = new Set<TerminalClient>();
  private scrollback: Buffer[] = [];
  private scrollbackBytes = 0;
  private lastStatus: TerminalNotice | null = null;
  private ended: TerminalNotice | null = null;
  size: { cols: number; rows: number };

  constructor(
    readonly runId: number,
    readonly driver: DriverName,
    size: { cols?: number; rows?: number } = {},
  ) {
    this.size = { cols: clampSize(size.cols, 120), rows: clampSize(size.rows, 32) };
  }

  get running(): boolean {
    return this.proc !== null && this.ended === null;
  }

  bind(proc: TerminalProcess): void {
    this.proc = proc;
    // The "starting" line is over: pages clear it.
    this.lastStatus = null;
    for (const c of this.clients) c.notice({ type: "status", text: "" });
    proc.onData((chunk) => {
      this.remember(chunk);
      for (const c of this.clients) c.data(chunk);
    });
  }

  status(text: string): void {
    const n: TerminalNotice = { type: "status", text };
    this.lastStatus = n;
    for (const c of this.clients) c.notice(n);
  }

  end(code: number | null, stopped: boolean): void {
    if (this.ended) return;
    this.ended = { type: "exit", code, stopped };
    for (const c of this.clients) c.notice(this.ended);
  }

  /** A page attaches: it gets the screen so far, then everything live. Returns the detach. */
  attach(client: TerminalClient): () => void {
    if (this.lastStatus && !this.proc) client.notice(this.lastStatus);
    if (this.scrollbackBytes) client.data(Buffer.concat(this.scrollback));
    if (this.ended) client.notice(this.ended);
    this.clients.add(client);
    return () => this.clients.delete(client);
  }

  input(data: Buffer | string): void {
    if (this.running) this.proc!.write(data);
  }

  resize(cols: number, rows: number): void {
    this.size = { cols: clampSize(cols, this.size.cols), rows: clampSize(rows, this.size.rows) };
    if (this.running) this.proc!.resize(this.size.cols, this.size.rows);
  }

  private remember(chunk: Buffer): void {
    this.scrollback.push(chunk);
    this.scrollbackBytes += chunk.length;
    while (this.scrollbackBytes > SCROLLBACK_BYTES && this.scrollback.length > 1) this.scrollbackBytes -= this.scrollback.shift()!.length;
  }
}

const clampSize = (n: number | undefined, fallback: number): number => (typeof n === "number" && Number.isFinite(n) ? Math.min(1000, Math.max(10, Math.round(n))) : fallback);

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * May this upgrade attach to a session's agent terminal? It is a shell in
 * the box with an agent's credential behind it, so: the host must be a
 * loopback name (a page that rebinds its own name to 127.0.0.1 does not
 * pass), the page must come from that same origin (WebSockets carry no
 * CORS), and the key must be the one the UI's own API handed out for this
 * terminal.
 */
export const terminalUpgrade = <T extends { key: string }>(req: Pick<IncomingMessage, "headers">, url: URL, find: (sessionId: string) => T | undefined): T | undefined => {
  const host = req.headers.host ?? "";
  let hostname = "";
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    return undefined;
  }
  if (!LOOPBACK.has(hostname)) return undefined;
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== host) return undefined;
    } catch {
      return undefined;
    }
  }
  const live = find(url.searchParams.get("session") ?? "");
  const key = url.searchParams.get("key") ?? "";
  if (!live || !key || key.length !== live.key.length || !timingSafeEqual(Buffer.from(key), Buffer.from(live.key))) return undefined;
  return live;
};

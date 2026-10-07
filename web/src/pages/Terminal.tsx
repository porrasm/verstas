import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api } from "../api";

/**
 * An agent terminal on the session page: Claude Code or Codex in their own
 * interface, running in the box. Keystrokes and the screen travel as bytes
 * over /ws/terminal (src/server.ts); the key comes from the UI API, which
 * only this page's origin can read. A reload or a second window attaches
 * to the same terminal and gets the recent screen replayed.
 */

type Info = { active: boolean; runId?: number; driver?: string; key?: string; running?: boolean };
type Notice = { type: "status"; text: string } | { type: "exit"; code: number | null; stopped: boolean };

/** A terminal reads best dark whatever the page's theme; these follow the app's dark tokens. */
const THEME = {
  background: "#0f1211",
  foreground: "#e9eeea",
  cursor: "#3fc79c",
  cursorAccent: "#0f1211",
  selectionBackground: "rgba(63, 199, 156, 0.35)",
  black: "#1e2521",
  brightBlack: "#5b685f",
  red: "#e66c58",
  brightRed: "#f08c7b",
  green: "#5ac47e",
  brightGreen: "#7ed69c",
  yellow: "#e9ae2f",
  brightYellow: "#f2c661",
  blue: "#6fabe9",
  brightBlue: "#94c2f0",
  magenta: "#c493e0",
  brightMagenta: "#d6b0ea",
  cyan: "#3fc79c",
  brightCyan: "#6ed9b6",
  white: "#bcc7bf",
  brightWhite: "#ffffff",
};

export const AgentTerminal = ({ sessionId, base, title, onEnd, onClose }: { sessionId: string; base: string; title: string; onEnd: () => void; onClose: () => void }) => {
  const host = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<"connecting" | "open" | "ended">("connecting");
  const [note, setNote] = useState("");

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let disposed = false;
    let ended = false;
    let ws: WebSocket | null = null;
    let retry: number | undefined;
    const term = new Terminal({ cursorBlink: true, fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace', fontSize: 13, lineHeight: 1.15, scrollback: 5000, theme: THEME });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    const refit = () => {
      try {
        fit.fit();
      } catch {
        // not laid out yet
      }
    };
    refit();
    const sendSize = () => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    };
    const observer = new ResizeObserver(refit);
    observer.observe(el);
    term.onResize(sendSize);
    const encoder = new TextEncoder();
    term.onData((d) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(encoder.encode(d));
    });
    // Some mouse reports are sent as raw bytes rather than text.
    term.onBinary((d) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(Uint8Array.from(d, (c) => c.charCodeAt(0) & 0xff));
    });

    const finish = (text: string) => {
      ended = true;
      setPhase("ended");
      setNote(text);
    };
    const connect = async () => {
      const info = await api<Info>("GET", `${base}/terminal`).catch(() => null);
      if (disposed) return;
      if (!info?.active || !info.key) {
        finish("The terminal has ended. Whatever the agent changed in the repositories was committed.");
        return;
      }
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws/terminal?session=${encodeURIComponent(sessionId)}&key=${encodeURIComponent(info.key)}`);
      ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        // The server replays the recent screen on every attach: start from a clean one so a reconnect does not double it.
        term.reset();
        setPhase("open");
        setNote("");
        sendSize();
        term.focus();
      };
      ws.onmessage = (e) => {
        if (typeof e.data !== "string") {
          term.write(new Uint8Array(e.data as ArrayBuffer));
          return;
        }
        try {
          const n = JSON.parse(e.data) as Notice;
          if (n.type === "status") setNote(n.text);
          else finish(n.stopped ? "The terminal was ended. Whatever the agent changed in the repositories was committed." : `The agent exited${n.code ? ` (exit ${n.code})` : ""}. Whatever it changed in the repositories was committed.`);
        } catch {
          // not a notice
        }
      };
      ws.onclose = () => {
        if (!disposed && !ended) retry = window.setTimeout(() => void connect(), 1000);
      };
    };
    void connect();
    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      observer.disconnect();
      ws?.close();
      term.dispose();
    };
  }, [sessionId, base]);

  return (
    <section className="card stack tight term-card">
      <div className="row">
        <h3>Agent terminal · {title}</h3>
        <span className={`pill ${phase === "open" ? "sig" : phase === "ended" ? "quiet" : "info"}`}>{phase === "open" ? <><span className="dot run" />live</> : phase === "ended" ? "ended" : "connecting"}</span>
        {note && <span className="muted small">{note}</span>}
        {phase === "ended" ? <button className="quiet sm end" onClick={onClose}>Close</button> : <button className="warn sm end" onClick={onEnd} title="Hang up the agent; its changes in the repositories are committed">End terminal</button>}
      </div>
      <div className="term-host" ref={host} onClick={() => host.current?.querySelector("textarea")?.focus()} />
      <div className="muted small">The agent works in the box with the board tools; its tickets go to the backlog unless you ask for them to be ready. Starting a run ends this terminal and commits what changed in the repositories.</div>
    </section>
  );
};

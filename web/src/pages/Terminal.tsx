import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api, copyText } from "../api";

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

/**
 * What Shift+Enter sends. A terminal sends Enter for both, so the agent would
 * submit; agents read a newline from another key instead: Claude Code from
 * Esc+Enter (what its own /terminal-setup binds Shift+Enter to), Codex from
 * Ctrl+J.
 */
export const SHIFT_ENTER: Record<"claude" | "codex", string> = { claude: "\x1b\r", codex: "\n" };

export const AgentTerminal = ({ sessionId, base, title, driver, onEnd, onClose }: { sessionId: string; base: string; title: string; driver: "claude" | "codex"; onEnd: () => void; onClose: () => void }) => {
  const host = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const [phase, setPhase] = useState<"connecting" | "open" | "ended">("connecting");
  const [note, setNote] = useState("");
  const [selected, setSelected] = useState(false);
  const [copied, setCopied] = useState(false);
  const copySelection = async () => {
    const text = termRef.current?.getSelection() ?? "";
    if (!text) return;
    await copyText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  const copyRef = useRef(copySelection);
  copyRef.current = copySelection;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let disposed = false;
    let ended = false;
    let ws: WebSocket | null = null;
    let retry: number | undefined;
    // Agents' interfaces may capture the mouse; Option-drag (Shift-drag off the Mac) still selects text then.
    const term = new Terminal({ cursorBlink: true, fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace', fontSize: 13, lineHeight: 1.15, scrollback: 5000, theme: THEME, macOptionClickForcesSelection: true });
    termRef.current = term;
    term.onSelectionChange(() => setSelected(term.hasSelection()));
    // Agents that draw their own selection (Claude Code captures the mouse) copy with OSC 52: "52;<target>;<base64>".
    // Only right after you clicked or typed in the pane: the box may not fill your clipboard on its own.
    let touchedAt = 0;
    const touched = () => (touchedAt = Date.now());
    el.addEventListener("mouseup", touched);
    el.addEventListener("keydown", touched, true);
    term.parser.registerOscHandler(52, (data) => {
      const b64 = data.slice(data.indexOf(";") + 1);
      if (!b64 || b64 === "?") return true; // a read request: the page never hands the clipboard to the box
      if (Date.now() - touchedAt > 3000) return true;
      try {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        void copyText(new TextDecoder().decode(bytes)).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      } catch {
        // not base64; ignore
      }
      return true;
    });
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
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    term.attachCustomKeyEventHandler((e) => {
      // Copy: Cmd+C on the Mac, Ctrl+Shift+C elsewhere (Ctrl+C stays the agent's interrupt).
      const copyKey = e.key.toLowerCase() === "c" && (mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && e.shiftKey);
      if (copyKey) {
        if (e.type === "keydown" && term.hasSelection()) void copyRef.current();
        return false;
      }
      if (e.key !== "Enter" || !e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return true;
      // Swallow both the keydown and its keypress, or xterm would also send Enter.
      if (e.type === "keydown" && ws?.readyState === WebSocket.OPEN) ws.send(encoder.encode(SHIFT_ENTER[driver]));
      return false;
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
      el.removeEventListener("mouseup", touched);
      el.removeEventListener("keydown", touched, true);
      ws?.close();
      termRef.current = null;
      term.dispose();
    };
  }, [sessionId, base, driver]);

  return (
    <section className="card stack tight term-card">
      <div className="row">
        <h3>Agent terminal · {title}</h3>
        <span className={`pill ${phase === "open" ? "sig" : phase === "ended" ? "quiet" : "info"}`}>{phase === "open" ? <><span className="dot run" />live</> : phase === "ended" ? "ended" : "connecting"}</span>
        {note && <span className="muted small">{note}</span>}
        <button className="quiet sm end" onClick={() => void copySelection()} disabled={!selected && !copied} title="Copy the selected text (⌘C on the Mac, Ctrl+Shift+C elsewhere)">{copied ? "Copied" : "Copy"}</button>
        {phase === "ended" ? <button className="quiet sm" onClick={onClose}>Close</button> : <button className="warn sm" onClick={onEnd} title="Hang up the agent; its changes in the repositories are committed">End terminal</button>}
      </div>
      <div className="term-host" ref={host} onClick={() => host.current?.querySelector("textarea")?.focus()} />
      <div className="muted small">Select text by dragging, or with {/Mac/.test(navigator.platform) ? "⌥" : "Shift"}-drag when the agent has the mouse; {/Mac/.test(navigator.platform) ? "⌘C" : "Ctrl+Shift+C"} copies, Shift+Enter starts a new line. The agent works in the box with the board tools; its tickets go to the backlog unless you ask for them to be ready. Starting a run ends this terminal and commits what changed in the repositories.</div>
    </section>
  );
};

import { useEffect, useState } from "react";
import { api, copyText, type McpSetup } from "../api";

/**
 * How to let an assistant prepare drafts: the MCP connection for Claude
 * Code and for Claude Desktop, and a first message to send it. Everything
 * comes from the host app, so the port and paths are this installation's.
 */
export const ConnectAssistant = ({ open = false }: { open?: boolean }) => {
  const [setup, setSetup] = useState<McpSetup | null>(null);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState("");
  useEffect(() => {
    api<McpSetup>("GET", "/mcp/setup").then(setSetup).catch((e: Error) => setErr(e.message));
  }, []);
  const copy = async (what: string, text: string) => {
    await copyText(text);
    setCopied(what);
    setTimeout(() => setCopied(""), 2500);
  };
  const Block = ({ id, label, text, help }: { id: string; label: string; text: string; help: string }) => (
    <div className="stack tight">
      <div className="row">
        <strong className="small">{label}</strong>
        <span className="muted small grow">{help}</span>
        <button className="quiet sm" onClick={() => void copy(id, text)}>{copied === id ? "Copied" : "Copy"}</button>
      </div>
      <pre className="mono small card" style={{ padding: "8px 10px" }}>{text}</pre>
    </div>
  );
  return (
    <details className="card" open={open}>
      <summary><strong>Connect an assistant</strong> <span className="muted small">Let Claude prepare a draft session over MCP; you review it here and create the session.</span></summary>
      {err && <div className="banner warn" style={{ marginTop: 10 }}>{err}</div>}
      {setup && (
        <div className="stack" style={{ marginTop: 12 }}>
          <Block id="code" label="Claude Code" help="Run once in a terminal; the server is then available in every project." text={setup.claudeCode} />
          <Block
            id="desktop"
            label="Claude Desktop"
            help="Add this entry to claude_desktop_config.json (Settings → Developer → Edit config), then restart Claude Desktop."
            text={setup.desktopConfig}
          />
          {!setup.stdioBuilt && <div className="banner signal small">The stdio bridge is not built yet. Run <code>npm run build</code> in the verstas directory before using the Claude Desktop entry.</div>}
          <Block id="prompt" label="First message" help="Send it after you have described what to build." text={setup.prompt} />
          <p className="small muted">
            Verstas must be running while the assistant works; the endpoint is <code>{setup.url}</code>, on this machine only. The assistant can create and edit drafts. It cannot create, start or change a session: that stays on this page.
          </p>
        </div>
      )}
    </details>
  );
};

import { useEffect, useState } from "react";
import { api, type Config, type Status } from "../api";

export const SettingsPage = ({ status }: { status: Status | null }) => {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [msg, setMsg] = useState("");
  const [token, setToken] = useState("");
  const [wt, setWt] = useState({ name: "", path: "" });
  const load = () => api<Config>("GET", "/config").then(setCfg).catch((e: Error) => setMsg(e.message));
  useEffect(() => {
    load();
  }, []);
  if (!cfg) return <div className="muted">{msg || "Loading…"}</div>;
  const save = async (patch: Partial<Config>) => {
    try {
      setCfg(await api<Config>("PUT", "/config", patch));
      setMsg("Saved. Port and sessions-root changes take effect after a restart.");
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const addTarget = async () => {
    try {
      await api("POST", "/work-targets", wt);
      setWt({ name: "", path: "" });
      load();
      setMsg("Work target added.");
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const removeTarget = async (name: string) => {
    await api("DELETE", `/work-targets/${encodeURIComponent(name)}`);
    load();
  };
  const saveToken = async () => {
    try {
      await api("PUT", "/secrets", { claudeToken: token });
      setToken("");
      setMsg("Token saved to ~/.verstas/secrets.json (mode 0600).");
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  return (
    <div className="grid" style={{ maxWidth: 820 }}>
      <h2>Settings</h2>
      {msg && <div className="small">{msg}</div>}
      <div className="card grid">
        <h3>Sessions root</h3>
        <p className="muted small">Every session is a directory under this path. The app creates and deletes them; nothing else on your disk is touched.</p>
        <div className="row">
          <input id="root" defaultValue={cfg.sessionsRoot} onBlur={(e) => e.target.value !== cfg.sessionsRoot && save({ sessionsRoot: e.target.value })} />
        </div>
      </div>
      <div className="card grid">
        <h3>Work targets</h3>
        <p className="muted small">Local git repositories a session may be created from. Sessions get a fresh clone; your checkout is never mounted.</p>
        <table>
          <tbody>
            {cfg.workTargets.map((w) => (
              <tr key={w.name}><td><strong>{w.name}</strong></td><td className="mono">{w.path}</td><td style={{ textAlign: "right" }}><button onClick={() => removeTarget(w.name)}>Remove</button></td></tr>
            ))}
            {cfg.workTargets.length === 0 && <tr><td className="muted" colSpan={3}>None yet.</td></tr>}
          </tbody>
        </table>
        <div className="row">
          <input id="wt-name" placeholder="name (e.g. nuppi)" value={wt.name} onChange={(e) => setWt({ ...wt, name: e.target.value })} style={{ maxWidth: 200 }} />
          <input id="wt-path" placeholder="/absolute/path/to/repo" value={wt.path} onChange={(e) => setWt({ ...wt, path: e.target.value })} />
          <button onClick={addTarget} disabled={!wt.name || !wt.path}>Add</button>
        </div>
      </div>
      <div className="card grid">
        <h3>Claude token</h3>
        <p className="muted small">
          Run <code>claude setup-token</code> in a terminal and paste the result. It is stored in <code>~/.verstas/secrets.json</code> and passed to session containers as <code>CLAUDE_CODE_OAUTH_TOKEN</code>.
          {status?.hasClaudeToken ? <span className="ok"> A token is configured.</span> : <span className="err"> No token yet.</span>}
        </p>
        <div className="row">
          <input id="token" type="password" placeholder="paste token" value={token} onChange={(e) => setToken(e.target.value)} />
          <button onClick={saveToken} disabled={token.length < 10}>Save</button>
        </div>
      </div>
      <div className="card grid">
        <h3>Image and ports</h3>
        <div className="form two">
          <label>Dev-box image<input id="image" defaultValue={cfg.devboxImage} onBlur={(e) => e.target.value !== cfg.devboxImage && save({ devboxImage: e.target.value })} /></label>
          <label>Agent API port (reachable from containers)<input id="agentPort" type="number" defaultValue={cfg.agentApiPort} onBlur={(e) => Number(e.target.value) !== cfg.agentApiPort && save({ agentApiPort: Number(e.target.value) })} /></label>
          <label>UI port (loopback only)<input id="uiPort" type="number" defaultValue={cfg.uiPort} onBlur={(e) => Number(e.target.value) !== cfg.uiPort && save({ uiPort: Number(e.target.value) })} /></label>
          <label className="chk" style={{ alignSelf: "end" }}><input type="checkbox" checked={cfg.linuxHost} onChange={(e) => save({ linuxHost: e.target.checked })} /> Linux host (adds host-gateway for the proxy)</label>
        </div>
        <p className="muted small">Build the image with <code>npm run image:build</code> after changing the Dockerfile.</p>
      </div>
    </div>
  );
};

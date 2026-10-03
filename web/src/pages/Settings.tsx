import { useEffect, useState } from "react";
import { api, fmtAgo, type Config, type RemoteSettings, type Status } from "../api";

/**
 * Remote dashboard: a base URL and a token you created there. Only sessions
 * you tick on their own page are sent (docs/REMOTE.md).
 */
const RemoteDashboard = () => {
  const [r, setR] = useState<RemoteSettings | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  const load = () =>
    api<RemoteSettings>("GET", "/remote")
      .then((x) => {
        setR(x);
        setBaseUrl((b) => b || x.baseUrl);
      })
      .catch((e: Error) => setNote({ text: e.message, error: true }));
  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 5000);
    return () => clearInterval(id);
  }, []);
  if (!r) return null;
  const save = async (patch: { enabled?: boolean; baseUrl?: string; token?: string }) => {
    setBusy(true);
    setNote(null);
    try {
      const next = await api<RemoteSettings>("PUT", "/remote", patch);
      setR(next);
      setBaseUrl(next.baseUrl);
      if (patch.token !== undefined) setToken("");
      if (next.status.state === "error") setNote({ text: next.status.error ?? "Could not connect", error: true });
    } catch (e) {
      setNote({ text: (e as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    setBusy(true);
    try {
      const t = await api<{ ok: boolean; name?: string; error?: string }>("POST", "/remote/test", { baseUrl, token: token || undefined });
      setNote(t.ok ? { text: `Connected: the dashboard knows this token as "${t.name}".`, error: false } : { text: t.error ?? "Failed", error: true });
    } catch (e) {
      setNote({ text: (e as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  };
  const st = r.status;
  const stateText =
    st.state === "connected"
      ? `Connected · ${st.shared} session${st.shared === 1 ? "" : "s"} shared${st.lastPushAt ? ` · last push ${fmtAgo(st.lastPushAt, Date.now())}` : ""}`
      : st.state === "connecting"
        ? "Connecting…"
        : st.state === "error"
          ? `Error: ${st.error}`
          : st.state === "unconfigured"
            ? `Not connected: ${st.error}`
            : "Off";
  const dirty = baseUrl.trim() !== r.baseUrl || token.length > 0;
  return (
    <section className="card">
      <h3>Remote dashboard</h3>
      <p className="lead">
        Follow sessions and answer the inbox from your phone. Create a token in the dashboard (the <code>verstas</code> app), paste its address and the token here, then tick
        "Remote dashboard" on each session you want to see there. <strong>Sessions are not sent unless you tick them</strong>; for those, tickets, inbox, setup verdict, prompts and a short
        activity log go out, never tool output, file contents or diffs. Verstas connects out; nothing here listens for the dashboard.
      </p>
      <div className="two">
        <label>
          Base URL <span className="help">https, or http://localhost for testing</span>
          <input id="remote-url" className="mono" placeholder="https://porras.club" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        </label>
        <label>
          Token <span className="help">{r.hasToken ? "A token is saved; paste a new one to replace it" : "From the dashboard's Tokens page"}</span>
          <input id="remote-token" type="password" className="mono" autoComplete="off" placeholder={r.hasToken ? "••••••••" : "vst_…"} value={token} onChange={(e) => setToken(e.target.value)} />
        </label>
      </div>
      <label className="chk">
        <input type="checkbox" checked={r.enabled} disabled={busy} onChange={(e) => void save({ enabled: e.target.checked, baseUrl, ...(token ? { token } : {}) })} /> Connect to the remote dashboard
      </label>
      <div className="row">
        <button className="pri" disabled={busy || !dirty} onClick={() => void save({ baseUrl, ...(token ? { token } : {}) })}>Save</button>
        <button disabled={busy || !baseUrl.trim() || (!token && !r.hasToken)} onClick={() => void test()}>Test connection</button>
        <span className={`small ${st.state === "connected" ? "ok" : st.state === "error" ? "err" : "muted"}`}>{stateText}</span>
      </div>
      {note && <div className={`small ${note.error ? "err" : "ok"}`}>{note.text}</div>}
    </section>
  );
};

export const SettingsPage = ({ status }: { status: Status | null }) => {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null);
  const ok = (text: string) => setMsg({ text, error: false });
  const fail = (e: unknown) => setMsg({ text: (e as Error).message, error: true });
  const [token, setToken] = useState("");
  const [wt, setWt] = useState({ name: "", path: "" });
  const [root, setRoot] = useState("");
  const [ports, setPorts] = useState({ devboxImage: "", agentApiPort: "", uiPort: "" });
  const load = () =>
    api<Config>("GET", "/config")
      .then((c) => {
        setCfg(c);
        setRoot(c.sessionsRoot);
        setPorts({ devboxImage: c.devboxImage, agentApiPort: String(c.agentApiPort), uiPort: String(c.uiPort) });
      })
      .catch(fail);
  useEffect(() => {
    load();
  }, []);
  if (!cfg) return <div className={msg?.error ? "banner warn" : "loading"}>{msg?.text ?? "Loading…"}</div>;
  const save = async (patch: Partial<Config>, note = "Saved.") => {
    try {
      setCfg(await api<Config>("PUT", "/config", patch));
      ok(note);
    } catch (e) {
      fail(e);
    }
  };
  const addTarget = async () => {
    try {
      await api("POST", "/work-targets", wt);
      ok(`Work target ${wt.name} added.`);
      setWt({ name: "", path: "" });
      load();
    } catch (e) {
      fail(e);
    }
  };
  const removeTarget = async (name: string) => {
    try {
      await api("DELETE", `/work-targets/${encodeURIComponent(name)}`);
      ok(`Work target ${name} removed. Existing sessions keep their clones.`);
      load();
    } catch (e) {
      fail(e);
    }
  };
  const saveToken = async () => {
    try {
      await api("PUT", "/secrets", { claudeToken: token });
      setToken("");
      ok("Token saved to ~/.verstas/secrets.json (mode 0600). It applies to the next worker that starts.");
    } catch (e) {
      fail(e);
    }
  };
  const portsDirty = ports.devboxImage !== cfg.devboxImage || Number(ports.agentApiPort) !== cfg.agentApiPort || Number(ports.uiPort) !== cfg.uiPort;
  return (
    <div className="form">
      <h1>Settings</h1>
      {msg && (
        <div className={`banner ${msg.error ? "warn" : "good"}`} role="status">
          <span>{msg.error ? "Error: " : ""}{msg.text}</span>
          <button className="quiet sm end" onClick={() => setMsg(null)}>Dismiss</button>
        </div>
      )}

      <section className="card">
        <h3>Claude token</h3>
        <p className="lead">
          Run <code>claude setup-token</code> in a terminal and paste the result. It is stored in <code>~/.verstas/secrets.json</code> and passed to session containers as <code>CLAUDE_CODE_OAUTH_TOKEN</code>.{" "}
          {status?.hasClaudeToken ? <span className="ok">A token is configured.</span> : <span className="err">No token yet; nothing can run without one.</span>}
        </p>
        <div className="row">
          <input id="token" type="password" placeholder={status?.hasClaudeToken ? "paste a new token to replace the current one" : "paste token"} value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
          <button className="pri" onClick={saveToken} disabled={token.length < 10}>Save token</button>
        </div>
      </section>

      <RemoteDashboard />

      <section className="card">
        <h3>Work targets</h3>
        <p className="lead">Local git repositories a session may be created from. Sessions get a fresh clone; your checkout is never mounted.</p>
        <table>
          <tbody>
            {cfg.workTargets.map((w) => (
              <tr key={w.name}>
                <td style={{ paddingLeft: 0 }}><strong>{w.name}</strong></td>
                <td className="mono muted wrap">{w.path}</td>
                <td style={{ textAlign: "right", paddingRight: 0 }}><button className="quiet sm" onClick={() => removeTarget(w.name)}>Remove</button></td>
              </tr>
            ))}
            {cfg.workTargets.length === 0 && <tr><td className="muted" colSpan={3} style={{ paddingLeft: 0 }}>None yet. Add one below.</td></tr>}
          </tbody>
        </table>
        <div className="row">
          <input id="wt-name" placeholder="name (letters, digits, . _ -)" value={wt.name} onChange={(e) => setWt({ ...wt, name: e.target.value })} style={{ flex: "0 1 220px" }} />
          <input id="wt-path" className="mono" placeholder="/absolute/path/to/repo or ~/path" value={wt.path} onChange={(e) => setWt({ ...wt, path: e.target.value })} onKeyDown={(e) => e.key === "Enter" && wt.name && wt.path && addTarget()} />
          <button onClick={addTarget} disabled={!wt.name || !wt.path}>Add</button>
        </div>
      </section>

      <section className="card">
        <h3>Sessions root</h3>
        <p className="lead">Every session is a directory under this path. The app creates and deletes them; nothing else on your disk is touched. Takes effect after a restart.</p>
        <div className="row">
          <input id="root" className="mono" value={root} onChange={(e) => setRoot(e.target.value)} />
          <button onClick={() => save({ sessionsRoot: root }, "Saved. The new root is used after a restart.")} disabled={root === cfg.sessionsRoot || !root.trim()}>Save</button>
        </div>
      </section>

      <section className="card">
        <h3>Image and ports</h3>
        <div className="three">
          <label>Dev-box image <span className="help">Build with <code>npm run image:build</code></span><input id="image" className="mono" value={ports.devboxImage} onChange={(e) => setPorts({ ...ports, devboxImage: e.target.value })} /></label>
          <label>Agent API port <span className="help">Reachable from containers</span><input id="agentPort" type="number" value={ports.agentApiPort} onChange={(e) => setPorts({ ...ports, agentApiPort: e.target.value })} /></label>
          <label>UI port <span className="help">Loopback only</span><input id="uiPort" type="number" value={ports.uiPort} onChange={(e) => setPorts({ ...ports, uiPort: e.target.value })} /></label>
        </div>
        <label className="chk"><input type="checkbox" checked={cfg.linuxHost} onChange={(e) => save({ linuxHost: e.target.checked })} /> Linux host <span className="muted">(adds host-gateway so the proxy can reach the agent API)</span></label>
        <div className="row">
          <button onClick={() => save({ devboxImage: ports.devboxImage, agentApiPort: Number(ports.agentApiPort), uiPort: Number(ports.uiPort) }, "Saved. Port changes take effect after a restart; the image applies to new sessions.")} disabled={!portsDirty}>Save</button>
          {portsDirty && <span className="muted small">Unsaved changes</span>}
        </div>
      </section>
    </div>
  );
};

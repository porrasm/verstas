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
        Follow runs from your phone: the board, the activity log and the requests; start, pause or stop, approve and add tickets, ask the box. Create a token in the dashboard (the <code>verstas</code> app), paste its address and the token here, then tick
        "Remote dashboard" on each session you want to see there. <strong>Sessions are not sent unless you tick them</strong>, and only once initialized; for those, tickets, requests, your prompts and a short
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

/**
 * Agent credentials, one per driver. Each is stored in ~/.verstas/secrets.json
 * (mode 0600) and reaches only the worker process of a session that uses
 * that agent. Nothing here can turn on pay-as-you-go: that is an account
 * setting at each vendor, listed under the card.
 */
const Credentials = ({ ok, fail }: { ok: (text: string) => void; fail: (e: unknown) => void }) => {
  const [status, setStatus] = useState<Status | null>(null);
  const [claude, setClaude] = useState("");
  const [cursor, setCursor] = useState("");
  const [codexPaste, setCodexPaste] = useState("");
  const [showPaste, setShowPaste] = useState(false);
  const reload = () => api<Status>("GET", "/status").then(setStatus).catch(() => undefined);
  useEffect(() => {
    void reload();
  }, []);
  const d = (name: string) => status?.drivers?.find((x) => x.name === name);
  const save = async (body: Record<string, string>, note: string) => {
    try {
      await api("PUT", "/secrets", body);
      setClaude("");
      setCursor("");
      setCodexPaste("");
      ok(note);
      await reload();
    } catch (e) {
      fail(e);
    }
  };
  const remove = async (driver: string, title: string) => {
    try {
      await api("DELETE", `/secrets/${driver}`);
      ok(`${title} credential removed. Sessions on ${title} fail at their next worker until a new one is saved.`);
      await reload();
    } catch (e) {
      fail(e);
    }
  };
  const importCodex = async () => {
    try {
      const r = await api<{ from: string; refreshedAt?: string }>("POST", "/secrets/codex/import", {});
      ok(`Codex login imported from ${r.from}${r.refreshedAt ? ` (last refreshed ${fmtAgo(r.refreshedAt, Date.now())})` : ""}. Codex refreshes it on its own during runs; the refreshed login is stored here again.`);
      await reload();
    } catch (e) {
      fail(e);
    }
  };
  const state = (name: string) => {
    const x = d(name);
    if (!status) return <span className="muted">…</span>;
    return x?.configured ? <span className="ok">Configured.</span> : <span className="err">Not configured.</span>;
  };
  const codexAge = d("codex")?.codexAuthAgeDays;
  return (
    <section className="card">
      <h3>Agent credentials</h3>
      <p className="lead">
        One per coding agent. A session picks its agents under "Agent options"; Claude Code is the default. Each credential is stored in <code>~/.verstas/secrets.json</code> (mode 0600) and passed to the worker process only. Use subscription logins, not API keys, if you want a hard stop at the plan's limit.
      </p>
      <div style={{ display: "grid", gap: 14 }}>
        <div>
          <div className="row">
            <strong>Claude Code</strong> {state("claude")}
            {d("claude")?.configured && <button className="quiet sm end" onClick={() => remove("claude", "Claude Code")}>Remove</button>}
          </div>
          <p className="lead" style={{ margin: "4px 0 6px" }}>
            Run <code>claude setup-token</code> in a terminal (Claude Pro or Max) and paste the result. Passed as <code>CLAUDE_CODE_OAUTH_TOKEN</code>. Turn "extra usage" off in your Claude account to stop at the plan's limit.
          </p>
          <div className="row">
            <input id="token" type="password" placeholder={d("claude")?.configured ? "paste a new token to replace the current one" : "paste token"} value={claude} onChange={(e) => setClaude(e.target.value)} autoComplete="off" />
            <button className="pri" onClick={() => void save({ claudeToken: claude }, "Claude token saved. It applies to the next worker that starts.")} disabled={claude.length < 10}>Save token</button>
          </div>
        </div>

        <div>
          <div className="row">
            <strong>Codex</strong> {state("codex")}
            {codexAge !== undefined && <span className="muted small">login last refreshed {codexAge < 1 ? "today" : `${Math.floor(codexAge)} day${codexAge >= 2 ? "s" : ""} ago`}</span>}
            {d("codex")?.configured && <button className="quiet sm end" onClick={() => remove("codex", "Codex")}>Remove</button>}
          </div>
          <p className="lead" style={{ margin: "4px 0 6px" }}>
            Log in once on this machine with your ChatGPT account: <code>codex login --device-auth</code> (no browser needed here). Then import the login below. Codex rotates its tokens during runs; the refreshed login is stored here again, so leave it alone afterwards. In your ChatGPT account keep the usage-credit balance at zero and automatic reload off, or exhausted quota becomes a bill.
          </p>
          <div className="row">
            <button className="pri" onClick={() => void importCodex()}>Import login from ~/.codex/auth.json</button>
            <button className="quiet sm" onClick={() => setShowPaste((v) => !v)}>{showPaste ? "Hide paste" : "Paste auth.json instead"}</button>
          </div>
          {showPaste && (
            <div className="row" style={{ marginTop: 6 }}>
              <textarea id="codex-auth" className="mono" placeholder='{"tokens": {...}, "last_refresh": "..."}' value={codexPaste} onChange={(e) => setCodexPaste(e.target.value)} style={{ minHeight: 70 }} autoComplete="off" />
              <button onClick={() => void save({ codexAuth: codexPaste }, "Codex login saved. It applies to the next worker that starts.")} disabled={codexPaste.trim().length < 2}>Save</button>
            </div>
          )}
        </div>

        <div>
          <div className="row">
            <strong>Cursor</strong> {state("cursor")}
            {d("cursor")?.configured && <button className="quiet sm end" onClick={() => remove("cursor", "Cursor")}>Remove</button>}
          </div>
          <p className="lead" style={{ margin: "4px 0 6px" }}>
            Create a user API key in the Cursor dashboard (API Keys) and paste it. Passed as <code>CURSOR_API_KEY</code>; it draws on your Cursor plan, not on a provider key. Turn on-demand usage off in the Cursor dashboard to stop at the plan's limit.
          </p>
          <div className="row">
            <input id="cursor-key" type="password" placeholder={d("cursor")?.configured ? "paste a new key to replace the current one" : "paste key"} value={cursor} onChange={(e) => setCursor(e.target.value)} autoComplete="off" />
            <button className="pri" onClick={() => void save({ cursorApiKey: cursor }, "Cursor key saved. It applies to the next worker that starts.")} disabled={cursor.length < 10}>Save key</button>
          </div>
        </div>
      </div>
      <p className="small muted" style={{ marginTop: 10 }}>
        Codex and Cursor need their CLIs in the dev-box image (<code>npm run image:build</code> installs them when it can). A session on an agent that is missing fails its worker with a clear message; sessions on Claude Code are unaffected.
      </p>
    </section>
  );
};

export const SettingsPage = ({ status: _status }: { status: Status | null }) => {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null);
  const ok = (text: string) => setMsg({ text, error: false });
  const fail = (e: unknown) => setMsg({ text: (e as Error).message, error: true });
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

      <Credentials ok={ok} fail={fail} />

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

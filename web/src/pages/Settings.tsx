import { useEffect, useState } from "react";
import { api, fmtAgo, type Config, type RemoteSettings, type Status, type WorkTargetView } from "../api";

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

/**
 * GitHub: the token and the repositories sessions are made from. The token
 * stays in this app (~/.verstas/secrets.json); fetches, pushes and the API
 * use it on the host, and no session ever sees it. Each repository has a
 * mirror on this machine: GitHub is downloaded once, then fetched for what
 * is new, and sessions clone from the mirror.
 */
const Github = ({ ok, fail }: { ok: (text: string) => void; fail: (e: unknown) => void }) => {
  const [hasToken, setHasToken] = useState<boolean | null>(null);
  const [token, setToken] = useState("");
  const [targets, setTargets] = useState<WorkTargetView[] | null>(null);
  const [add, setAdd] = useState({ repo: "", name: "" });
  const [busy, setBusy] = useState<string | null>(null);
  const [test, setTest] = useState<{ ok: boolean; login?: string | null; error?: string; repos?: { name: string; github: string; ok: boolean; canPush?: boolean | null; error?: string }[] } | null>(null);
  const load = () => {
    api<{ hasToken: boolean }>("GET", "/github").then((g) => setHasToken(g.hasToken)).catch(fail);
    api<WorkTargetView[]>("GET", "/work-targets").then(setTargets).catch(fail);
  };
  useEffect(() => {
    load();
  }, []);
  // A first fetch runs in the background; poll while one is going.
  const fetching = targets?.some((t) => t.mirror.fetching);
  useEffect(() => {
    if (!fetching) return;
    const id = setInterval(() => api<WorkTargetView[]>("GET", "/work-targets").then(setTargets).catch(() => undefined), 2000);
    return () => clearInterval(id);
  }, [fetching]);
  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };
  const saveToken = (value: string) =>
    run("token", async () => {
      const g = await api<{ hasToken: boolean }>("PUT", "/github", { token: value });
      setHasToken(g.hasToken);
      setToken("");
      setTest(null);
      ok(value ? "GitHub token saved." : "GitHub token removed. Public repositories still fetch; private ones and pull requests need a token.");
    });
  const runTest = () =>
    run("test", async () => {
      setTest(await api("POST", "/github/test", { token: token || undefined }));
    });
  const addRepo = () =>
    run("add", async () => {
      const t = await api<WorkTargetView>("POST", "/work-targets", { repo: add.repo, name: add.name || undefined });
      setAdd({ repo: "", name: "" });
      ok(`${t.github} added as ${t.name}. Its first fetch runs now; a large repository takes a while once.`);
      load();
    });
  const fetchNow = (name: string) =>
    run(`fetch:${name}`, async () => {
      try {
        await api("POST", `/work-targets/${encodeURIComponent(name)}/fetch`);
      } finally {
        load();
      }
    });
  const remove = (name: string) =>
    run(`rm:${name}`, async () => {
      await api("DELETE", `/work-targets/${encodeURIComponent(name)}`);
      ok(`${name} removed. Existing sessions keep their clones.`);
      load();
    });
  return (
    <section className="card">
      <h3>GitHub</h3>
      <p className="lead">
        Sessions clone GitHub repositories. The token stays in <code>~/.verstas/secrets.json</code>; Verstas uses it on this machine only, when you press a button. No agent and no session ever sees it.
      </p>
      <details open={hasToken === false}>
        <summary className="small">How to make the token</summary>
        <ol className="small" style={{ margin: "6px 0 10px", paddingLeft: 20 }}>
          <li>
            Create a <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">fine-grained personal access token</a>.
          </li>
          <li><strong>Resource owner</strong>: the account or organization that owns the repositories. A token owned by your account cannot see an organization's repositories, and an organization may have to approve the token.</li>
          <li><strong>Repository access</strong>: Only select repositories, and pick the ones you add below.</li>
          <li>
            <strong>Repository permissions</strong>:
            <table className="small" style={{ margin: "4px 0" }}>
              <tbody>
                <tr><td style={{ paddingLeft: 0 }}><strong>Contents</strong></td><td>Read and write</td><td className="muted">fetch the repository, push <span className="mono">verstas/</span> branches</td></tr>
                <tr><td style={{ paddingLeft: 0 }}><strong>Pull requests</strong></td><td>Read and write</td><td className="muted">open and update draft pull requests, see when they are merged</td></tr>
                <tr><td style={{ paddingLeft: 0 }}><strong>Metadata</strong></td><td>Read-only</td><td className="muted">added by GitHub on its own; find the repository and its default branch</td></tr>
                <tr><td style={{ paddingLeft: 0 }}><strong>Workflows</strong></td><td className="warn">No access</td><td className="muted">so a push can never add or change CI workflows</td></tr>
              </tbody>
            </table>
            Everything else: No access.
          </li>
          <li>Paste it below, <strong>Save token</strong>, then <strong>Test</strong>: each repository should say it is reachable. Permissions changed later on GitHub apply to the same token.</li>
        </ol>
      </details>
      <div className="row">
        <input id="github-token" type="password" className="mono" autoComplete="off" placeholder={hasToken ? "A token is saved; paste a new one to replace it" : "github_pat_…"} value={token} onChange={(e) => setToken(e.target.value)} />
        <button className="pri" disabled={busy !== null || token.trim().length < 10} onClick={() => void saveToken(token.trim())}>Save token</button>
        <button disabled={busy !== null || (!token && !hasToken)} onClick={() => void runTest()}>{busy === "test" ? "Testing…" : "Test"}</button>
        {hasToken && <button className="quiet sm" disabled={busy !== null} onClick={() => void saveToken("")}>Remove</button>}
        <span className={`small ${hasToken ? "ok" : "muted"}`}>{hasToken === null ? "" : hasToken ? "Token saved." : "No token: public repositories only."}</span>
      </div>
      {test && (
        <div className={`small ${test.ok ? "" : "err"}`} style={{ marginTop: 6 }}>
          {test.ok ? (
            <>
              <div className="ok">{test.login ? `The token belongs to ${test.login}.` : "No token: anonymous access."}</div>
              {test.repos?.map((r) => (
                <div key={r.name} className={r.ok ? "" : "err"}>
                  {r.github}: {r.ok ? (r.canPush === false ? "readable, but the token cannot push (pull requests will fail)" : "reachable") : r.error}
                </div>
              ))}
            </>
          ) : (
            test.error
          )}
        </div>
      )}

      <h4 style={{ marginTop: 16 }}>Repositories</h4>
      <table>
        <tbody>
          {targets?.map((t) => (
            <tr key={t.name}>
              <td style={{ paddingLeft: 0 }}><strong>{t.name}</strong></td>
              <td className="mono">
                <a href={`https://github.com/${t.github}`} target="_blank" rel="noreferrer">{t.github}</a> <span className="muted">· {t.defaultBranch}</span>
              </td>
              <td className={`small ${t.mirror.error ? "err" : "muted"}`}>
                {t.mirror.fetching || busy === `fetch:${t.name}` ? "Fetching…" : t.mirror.error ? t.mirror.error : t.mirror.fetchedAt ? `fetched ${fmtAgo(t.mirror.fetchedAt, Date.now())}` : "not fetched yet"}
              </td>
              <td style={{ textAlign: "right", paddingRight: 0, whiteSpace: "nowrap" }}>
                <button className="quiet sm" disabled={busy !== null || t.mirror.fetching} onClick={() => void fetchNow(t.name)}>{busy === `fetch:${t.name}` ? "Fetching…" : "Fetch"}</button>
                <button className="quiet sm" disabled={busy !== null} onClick={() => void remove(t.name)}>Remove</button>
              </td>
            </tr>
          ))}
          {targets?.length === 0 && <tr><td className="muted" colSpan={4} style={{ paddingLeft: 0 }}>None yet. Add one below.</td></tr>}
        </tbody>
      </table>
      <div className="row">
        <input id="gh-repo" className="mono" placeholder="owner/name or https://github.com/owner/name" value={add.repo} onChange={(e) => setAdd({ ...add, repo: e.target.value })} onKeyDown={(e) => e.key === "Enter" && add.repo && void addRepo()} />
        <input id="gh-name" placeholder="name (optional)" value={add.name} onChange={(e) => setAdd({ ...add, name: e.target.value })} style={{ flex: "0 1 180px" }} />
        <button onClick={() => void addRepo()} disabled={busy !== null || !add.repo.trim()}>{busy === "add" ? "Adding…" : "Add"}</button>
      </div>
    </section>
  );
};

export const SettingsPage = ({ status: _status }: { status: Status | null }) => {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null);
  const ok = (text: string) => setMsg({ text, error: false });
  const fail = (e: unknown) => setMsg({ text: (e as Error).message, error: true });
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

      <Github ok={ok} fail={fail} />

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

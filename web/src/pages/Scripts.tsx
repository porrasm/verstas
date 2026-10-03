import { useEffect, useState } from "react";
import { api, copyText, type SetupScript } from "../api";

const EMPTY: SetupScript = { name: "", description: "", hosts: [], note: "", script: "#!/usr/bin/env bash\n# needs-hosts: \n# note: \nset -euo pipefail\nexport DEBIAN_FRONTEND=noninteractive\n\n" };

/**
 * The setup script library. A script runs once as root when a session's
 * container is created; sessions tick scripts at creation and get a copy.
 */
export const ScriptsPage = () => {
  const [list, setList] = useState<SetupScript[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [draft, setDraft] = useState<SetupScript>(EMPTY);
  const [hostsText, setHostsText] = useState("");
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api<SetupScript[]>("GET", "/scripts").then(setList).catch((e: Error) => setMsg({ text: e.message, error: true }));
  useEffect(() => {
    load();
  }, []);

  const pick = (s: SetupScript | null) => {
    setSel(s?.name ?? null);
    setDraft(s ?? EMPTY);
    setHostsText((s?.hosts ?? []).join(" "));
    setMsg(null);
  };
  const save = async () => {
    setBusy(true);
    try {
      const saved = await api<SetupScript>("PUT", `/scripts/${encodeURIComponent(draft.name)}`, { ...draft, hosts: hostsText.split(/[\s,]+/).filter(Boolean) });
      setMsg({ text: `Saved ${saved.name}. Sessions created from now on can tick it; existing sessions keep their copy.`, error: false });
      await load();
      pick(saved);
    } catch (e) {
      setMsg({ text: (e as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!sel || !confirm(`Delete script ${sel}? Existing sessions keep their copy.`)) return;
    await api("DELETE", `/scripts/${encodeURIComponent(sel)}`);
    pick(null);
    await load();
  };
  const copyContext = async () => {
    try {
      const md = await fetch("/api/context?tail=script").then((r) => r.text());
      await copyText(md);
      setMsg({ text: "Context copied. Paste it into any assistant, fill in what you need installed, and paste the script it returns here.", error: false });
    } catch (e) {
      setMsg({ text: (e as Error).message, error: true });
    }
  };

  if (!list) return <div className="loading">Loading…</div>;
  const dirty = sel ? JSON.stringify({ ...draft, hosts: hostsText }) !== JSON.stringify({ ...list.find((s) => s.name === sel), hosts: (list.find((s) => s.name === sel)?.hosts ?? []).join(" ") }) : draft.script !== EMPTY.script || Boolean(draft.name);
  return (
    <div className="form" style={{ maxWidth: 1100 }}>
      <div>
        <h1>Setup scripts</h1>
        <p className="muted" style={{ marginTop: 6 }}>
          Bash that runs once, as root, when a session's container is created. Tick scripts on the New session form. The hosts a script downloads from are added to that session's allowlist; the note tells the worker how to use what was installed.
        </p>
      </div>
      {msg && (
        <div className={`banner ${msg.error ? "warn" : "good"}`} role="status">
          <span>{msg.error ? "Error: " : ""}{msg.text}</span>
          <button className="quiet sm end" onClick={() => setMsg(null)}>Dismiss</button>
        </div>
      )}
      <div className="scripts-layout">
        <aside className="card stack" style={{ gap: 6 }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h3>Library</h3>
            <button className="sm" onClick={() => pick(null)}>New</button>
          </div>
          {list.length === 0 && <div className="muted small">Empty. Write one, or copy the LLM context and let an assistant write it.</div>}
          {list.map((s) => (
            <button key={s.name} className={`script-item ${sel === s.name ? "on" : ""}`} onClick={() => pick(s)}>
              <strong>{s.name}</strong>
              <span className="muted small">{s.description || `${s.script.split("\n").length} lines`}</span>
            </button>
          ))}
          <button className="quiet sm" onClick={copyContext} title="Markdown describing this sandbox, with instructions for writing a setup script">Copy context for an LLM</button>
        </aside>
        <section className="card stack">
          <div className="two">
            <label>Name <span className="help">letters, digits, . _ -</span><input id="sc-name" value={draft.name} disabled={Boolean(sel)} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="postgres" /></label>
            <label>Description<input id="sc-desc" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="Postgres 16 as a process on 5432" /></label>
          </div>
          <label>
            Hosts it downloads from <span className="help">Space-separated; also read from a <code>needs-hosts:</code> comment in the script. Added to the session allowlist.</span>
            <input id="sc-hosts" className="mono" value={hostsText} onChange={(e) => setHostsText(e.target.value)} placeholder="deb.debian.org security.debian.org" />
          </label>
          <label>
            Note for the worker <span className="help">One or two sentences in VERSTAS.md: what is installed, where, how to start it.</span>
            <input id="sc-note" value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} placeholder="Postgres is installed; start it with pg_ctlcluster 16 main start; connect with psql -U postgres." />
          </label>
          <label>
            Script <span className="help">Runs as root with <code>bash -e</code>, non-interactive. Make it idempotent.</span>
            <textarea id="sc-script" className="mono" value={draft.script} onChange={(e) => setDraft({ ...draft, script: e.target.value })} style={{ minHeight: 360 }} spellCheck={false} />
          </label>
          <div className="row">
            <button className="pri" onClick={save} disabled={busy || !draft.name.trim() || !draft.script.trim() || !dirty}>{sel ? "Save changes" : "Add to library"}</button>
            {sel && <button className="warn" onClick={remove} disabled={busy}>Delete</button>}
            <span className="muted small grow">{dirty ? "Unsaved changes" : ""}</span>
          </div>
        </section>
      </div>
    </div>
  );
};

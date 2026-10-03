import { useEffect, useState } from "react";
import { api, fmtBytes, MODEL_CHOICES, upload, type Config } from "../api";

type RepoPick = { target: string; branch: string; branches: string[]; on: boolean };

export const NewSessionPage = () => {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [repos, setRepos] = useState<RepoPick[]>([]);
  const [uploads, setUploads] = useState<{ id: string; name: string; bytes: number }[]>([]);
  const [board, setBoard] = useState("");
  const [allowlist, setAllowlist] = useState("api.anthropic.com\nregistry.npmjs.org\npypi.org\nfiles.pythonhosted.org\ngithub.com\nobjects.githubusercontent.com");
  const [caps, setCaps] = useState({ workerMinutes: 25, workerTurns: 60, runTickets: 40, budgetUsd: 50, ticketAttempts: 2, reviewer: true });
  const [limits, setLimits] = useState({ memory: "4g", cpus: 2, workspaceMb: 20000 });
  const [plan, setPlan] = useState(false);
  const [model, setModel] = useState("claude-sonnet-5-5");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    api<Config>("GET", "/config").then(async (c) => {
      setCfg(c);
      const picks: RepoPick[] = [];
      for (const w of c.workTargets) {
        const b = await api<{ current: string; branches: string[] }>("GET", `/work-targets/${encodeURIComponent(w.name)}/branches`).catch(() => ({ current: "", branches: [] }));
        picks.push({ target: w.name, branch: b.current, branches: b.branches, on: false });
      }
      setRepos(picks);
    });
  }, []);

  const addFiles = async (files: FileList | null) => {
    if (!files) return;
    setBusy("uploading…");
    try {
      const done: { id: string; name: string; bytes: number }[] = [];
      for (const f of Array.from(files)) done.push(await upload(f));
      setUploads((u) => [...u, ...done]);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const create = async () => {
    setErr("");
    setBusy("creating session (cloning repositories)…");
    try {
      const r = await api<{ session: { id: string }; imported?: { created: string[]; skipped: { title: string; reason: string }[] } }>("POST", "/sessions", {
        name,
        goal,
        repos: repos.filter((r) => r.on).map((r) => ({ target: r.target, branch: r.branch || undefined })),
        uploads: uploads.map((u) => ({ id: u.id, name: u.name })),
        allowlist: allowlist.split(/\n/).map((s) => s.trim()).filter(Boolean),
        caps,
        limits,
        model: model.trim() || undefined,
        board: board.trim() || undefined,
        plan,
      });
      location.hash = `#/s/${encodeURIComponent(r.session.id)}`;
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  if (!cfg) return <div className="muted">Loading…</div>;
  return (
    <div className="form">
      <h2>New session</h2>
      <p className="muted small">Everything the agent will ever have is on this form: the repositories (fresh clones), the attachments, the hosts it may reach, the goal, and the caps.</p>
      {err && <div className="err">{err}</div>}
      <div className="two">
        <label>Name<input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Nuppi MVP" /></label>
        <label>Model for every worker (empty = the token's default)
          <input id="model" list="models" value={model} onChange={(e) => setModel(e.target.value)} placeholder="claude-sonnet-5-5" />
          <datalist id="models">{MODEL_CHOICES.map((m) => <option key={m} value={m} />)}</datalist>
        </label>
      </div>
      <div className="two">
        <label>Image<input id="image" value={cfg.devboxImage} readOnly /></label>
        <span />
      </div>
      <label>Goal (the planner turns this into tickets, unless you paste a board below)
        <textarea id="goal" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Build the Nuppi desktop app MVP: layout editor, mapping engine, mock MIDI output…" />
      </label>
      <div className="card grid">
        <h3>Repositories</h3>
        {repos.length === 0 && <div className="muted small">No work targets yet. Add repositories in <a href="#/settings">Settings</a>.</div>}
        {repos.map((r, i) => (
          <div className="row" key={r.target}>
            <label className="chk"><input type="checkbox" checked={r.on} onChange={(e) => setRepos(repos.map((x, j) => (j === i ? { ...x, on: e.target.checked } : x)))} /> {r.target}</label>
            <select value={r.branch} onChange={(e) => setRepos(repos.map((x, j) => (j === i ? { ...x, branch: e.target.value } : x)))} style={{ maxWidth: 260 }}>
              {r.branches.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
            <span className="muted mono small">{cfg.workTargets.find((w) => w.name === r.target)?.path}</span>
          </div>
        ))}
      </div>
      <div className="card grid">
        <h3>Attachments (zip, extracted into workspace/attachments)</h3>
        <input id="zips" type="file" accept=".zip,application/zip" multiple onChange={(e) => addFiles(e.target.files)} />
        {uploads.filter((u) => u.id).map((u) => <div key={u.id} className="row small"><span>{u.name}</span><span className="muted mono">{fmtBytes(u.bytes)}</span></div>)}
      </div>
      <label>Board to import (optional; JSON or markdown, see docs/BOARD.md). Imported tickets start as ready.
        <textarea id="board" value={board} onChange={(e) => setBoard(e.target.value)} placeholder={'{ "tickets": [ { "title": "…", "spec": "…", "acceptance": ["…"] } ] }'} style={{ minHeight: 140 }} />
      </label>
      <div className="two">
        <label>Network allowlist (one host per line; HTTPS only; *.suffix allowed)
          <textarea id="allowlist" value={allowlist} onChange={(e) => setAllowlist(e.target.value)} style={{ minHeight: 140 }} />
        </label>
        <div className="grid">
          <div className="two">
            <label>Worker minutes<input type="number" value={caps.workerMinutes} onChange={(e) => setCaps({ ...caps, workerMinutes: Number(e.target.value) })} /></label>
            <label>Worker turns<input type="number" value={caps.workerTurns} onChange={(e) => setCaps({ ...caps, workerTurns: Number(e.target.value) })} /></label>
            <label>Run tickets<input type="number" value={caps.runTickets} onChange={(e) => setCaps({ ...caps, runTickets: Number(e.target.value) })} /></label>
            <label>Budget USD per worker<input type="number" value={caps.budgetUsd} onChange={(e) => setCaps({ ...caps, budgetUsd: Number(e.target.value) })} /></label>
            <label>Attempts per ticket<input type="number" value={caps.ticketAttempts} onChange={(e) => setCaps({ ...caps, ticketAttempts: Number(e.target.value) })} /></label>
            <label className="chk" style={{ alignSelf: "end" }}><input type="checkbox" checked={caps.reviewer} onChange={(e) => setCaps({ ...caps, reviewer: e.target.checked })} /> Reviewer on</label>
            <label>Memory<input value={limits.memory} onChange={(e) => setLimits({ ...limits, memory: e.target.value })} /></label>
            <label>CPUs<input type="number" step="0.5" value={limits.cpus} onChange={(e) => setLimits({ ...limits, cpus: Number(e.target.value) })} /></label>
            <label>Workspace limit MB<input type="number" value={limits.workspaceMb} onChange={(e) => setLimits({ ...limits, workspaceMb: Number(e.target.value) })} /></label>
          </div>
        </div>
      </div>
      <label className="chk"><input type="checkbox" checked={plan} onChange={(e) => setPlan(e.target.checked)} /> Start the planner right away (needs Docker, the image and a token)</label>
      <div className="foot">
        {err && <span className="err small" style={{ marginRight: "auto" }}>Error: {err}</span>}
        <span className="muted small">{busy}</span>
        <a href="#/"><button>Cancel</button></a>
        <button className="pri" onClick={create} disabled={!name || Boolean(busy)}>Create session</button>
      </div>
    </div>
  );
};

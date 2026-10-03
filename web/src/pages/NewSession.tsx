import { useEffect, useState } from "react";
import { api, copyText, fmtBytes, MODEL_CHOICES, upload, type Config, type SetupScript } from "../api";

type RepoPick = { target: string; branch: string; branches: string[]; on: boolean };

export const NewSessionPage = () => {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [repos, setRepos] = useState<RepoPick[]>([]);
  const [uploads, setUploads] = useState<{ id: string; name: string; bytes: number }[]>([]);
  const [board, setBoard] = useState("");
  const [allowlist, setAllowlist] = useState("api.anthropic.com\nregistry.npmjs.org\npypi.org\nfiles.pythonhosted.org\ngithub.com\nobjects.githubusercontent.com\ndeb.debian.org\nsecurity.debian.org");
  const [caps, setCaps] = useState({ preflight: false, workerMinutes: 25, workerTurns: 60, runTickets: 40, budgetUsd: 50, ticketAttempts: 2, reviewer: true });
  const [scripts, setScripts] = useState<SetupScript[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [copied, setCopied] = useState("");
  const [limits, setLimits] = useState({ memory: "4g", cpus: 2, workspaceMb: 20000 });
  const [plan, setPlan] = useState(false);
  const [model, setModel] = useState("claude-sonnet-5-5");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    api<Config>("GET", "/config")
      .then(async (c) => {
        setCfg(c);
        const picks: RepoPick[] = [];
        for (const w of c.workTargets) {
          const b = await api<{ current: string; branches: string[] }>("GET", `/work-targets/${encodeURIComponent(w.name)}/branches`).catch(() => ({ current: "", branches: [] }));
          picks.push({ target: w.name, branch: b.current, branches: b.branches, on: false });
        }
        setRepos(picks);
      })
      .catch((e: Error) => setErr(e.message));
    api<SetupScript[]>("GET", "/scripts").then(setScripts).catch(() => setScripts([]));
  }, []);

  const copyBoardContext = async () => {
    const names = repos.filter((r) => r.on).map((r) => r.target).join(",");
    const md = await fetch(`/api/context?tail=board&repos=${encodeURIComponent(names)}`).then((r) => r.text());
    await copyText(md);
    setCopied("Context copied. Paste it into any assistant with your feature description; paste the JSON it returns into the board box.");
    setTimeout(() => setCopied(""), 6000);
  };

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
      const r = await api<{ session: { id: string } }>("POST", "/sessions", {
        name,
        goal,
        repos: repos.filter((r) => r.on).map((r) => ({ target: r.target, branch: r.branch || undefined })),
        uploads: uploads.map((u) => ({ id: u.id, name: u.name })),
        allowlist: allowlist.split(/\n/).map((s) => s.trim()).filter(Boolean),
        caps,
        limits,
        model: model.trim() || undefined,
        setupScripts: picked,
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

  if (!cfg) return <div className={err ? "banner warn" : "loading"}>{err || "Loading…"}</div>;
  const needsPlan = !board.trim() && !goal.trim();
  return (
    <div className="form">
      <div>
        <h1>New session</h1>
        <p className="muted" style={{ marginTop: 6 }}>Everything the agent will ever have is on this form: fresh clones of the repositories, the attachments, the hosts it may reach, the goal, and the caps.</p>
      </div>
      {err && <div className="banner warn"><span>{err}</span><button className="quiet sm end" onClick={() => setErr("")}>Dismiss</button></div>}

      <section className="card">
        <h3>What to build</h3>
        <div className="two">
          <label>Name<input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Nuppi MVP" autoFocus /></label>
          <label>
            Model for every worker <span className="help">Any id or alias; empty uses the token's default</span>
            <input id="model" className="mono" list="models" value={model} onChange={(e) => setModel(e.target.value)} placeholder="claude-sonnet-5-5" />
            <datalist id="models">{MODEL_CHOICES.map((m) => <option key={m} value={m} />)}</datalist>
          </label>
        </div>
        <label>
          Goal <span className="help">The planner turns this into tickets. Workers read it on every ticket, so say what done looks like.</span>
          <textarea id="goal" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Build the Nuppi desktop app MVP: layout editor, mapping engine, mock MIDI output…" style={{ minHeight: 110 }} />
        </label>
        <label className="chk"><input type="checkbox" checked={plan} onChange={(e) => setPlan(e.target.checked)} /> Start the planner right away <span className="muted">(needs Docker, the image and a token)</span></label>
      </section>

      <section className="card">
        <h3>Repositories</h3>
        <p className="lead">Each one is cloned fresh at the chosen branch; your checkout is never mounted. Add repositories in <a href="#/settings">Settings</a>.</p>
        {repos.length === 0 && <div className="muted small">No work targets yet.</div>}
        {repos.map((r, i) => (
          <div className="repo-row" key={r.target}>
            <label className="chk"><input type="checkbox" checked={r.on} onChange={(e) => setRepos(repos.map((x, j) => (j === i ? { ...x, on: e.target.checked } : x)))} /> <strong>{r.target}</strong></label>
            <select value={r.branch} disabled={!r.on} onChange={(e) => setRepos(repos.map((x, j) => (j === i ? { ...x, branch: e.target.value } : x)))}>
              {r.branches.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
            <span className="path" title={cfg.workTargets.find((w) => w.name === r.target)?.path}>{cfg.workTargets.find((w) => w.name === r.target)?.path}</span>
          </div>
        ))}
      </section>

      <section className="card">
        <h3>Attachments</h3>
        <p className="lead">Zip files, extracted into <code>workspace/attachments</code>. Specs, designs, sample data.</p>
        <input id="zips" type="file" accept=".zip,application/zip" multiple onChange={(e) => addFiles(e.target.files)} />
        {uploads.filter((u) => u.id).map((u) => <div key={u.id} className="row small"><span>{u.name}</span><span className="muted mono">{fmtBytes(u.bytes)}</span></div>)}
      </section>

      <section className="card">
        <h3>Setup scripts</h3>
        <p className="lead">Run once as root when the container is created, in this order. Their download hosts join the allowlist. Manage them under <a href="#/scripts">Setup scripts</a>.</p>
        {scripts.length === 0 && <div className="muted small">The library is empty.</div>}
        {scripts.map((sc) => (
          <label className="chk" key={sc.name}>
            <input type="checkbox" checked={picked.includes(sc.name)} onChange={(e) => setPicked(e.target.checked ? [...picked, sc.name] : picked.filter((n) => n !== sc.name))} />
            <strong>{sc.name}</strong> <span className="muted">{sc.description}</span>
          </label>
        ))}
        <label className="chk" style={{ marginTop: 8 }}>
          <input type="checkbox" checked={caps.preflight} onChange={(e) => setCaps({ ...caps, preflight: e.target.checked })} />
          Agentic initialization <span className="muted">(before any ticket, a worker checks the box against the goal and the board, asks for what is missing, and work starts only after it reports ok)</span>
        </label>
      </section>

      <section className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h3>Board</h3>
          <button className="quiet sm" onClick={copyBoardContext} title="Markdown describing this sandbox and the board format, for an assistant to write the tickets">Copy context for an LLM</button>
        </div>
        {copied && <div className="small ok">{copied}</div>}
        <p className="lead">Optional. Paste tickets as JSON or markdown (see <code>docs/BOARD.md</code>); they start as ready. Leave empty to let the planner draft them from the goal.</p>
        <textarea id="board" className="mono" value={board} onChange={(e) => setBoard(e.target.value)} placeholder={'{ "tickets": [ { "title": "…", "spec": "…", "acceptance": ["…"] } ] }'} style={{ minHeight: 120 }} />
      </section>

      <section className="card">
        <h3>Network</h3>
        <label>
          Allowlist <span className="help">One host per line, HTTPS only; <code>*.suffix</code> allowed. The worker can ask for more hosts during the run.</span>
          <textarea id="allowlist" className="mono" value={allowlist} onChange={(e) => setAllowlist(e.target.value)} style={{ minHeight: 130 }} />
        </label>
      </section>

      <section className="card">
        <h3>Caps and limits</h3>
        <p className="lead">Every cap stops something gracefully: the worker files its report and the ticket goes back to the board. All of them can be changed while the session runs.</p>
        <div className="three">
          <label>Worker minutes <span className="help">Wall-clock cap for one worker</span><input type="number" min={1} value={caps.workerMinutes} onChange={(e) => setCaps({ ...caps, workerMinutes: Number(e.target.value) })} /></label>
          <label>Worker turns <span className="help">Model turns per worker</span><input type="number" min={1} value={caps.workerTurns} onChange={(e) => setCaps({ ...caps, workerTurns: Number(e.target.value) })} /></label>
          <label>Budget USD per worker <span className="help">Spend cap for one worker</span><input type="number" min={1} value={caps.budgetUsd} onChange={(e) => setCaps({ ...caps, budgetUsd: Number(e.target.value) })} /></label>
          <label>Tickets per run <span className="help">The run pauses after this many</span><input type="number" min={1} value={caps.runTickets} onChange={(e) => setCaps({ ...caps, runTickets: Number(e.target.value) })} /></label>
          <label>Attempts per ticket <span className="help">Then the ticket is blocked for you</span><input type="number" min={1} value={caps.ticketAttempts} onChange={(e) => setCaps({ ...caps, ticketAttempts: Number(e.target.value) })} /></label>
          <label className="chk" style={{ alignSelf: "end", paddingBottom: 8 }}><input type="checkbox" checked={caps.reviewer} onChange={(e) => setCaps({ ...caps, reviewer: e.target.checked })} /> Reviewer pass after each ticket</label>
          <label>Memory <span className="help">Container limit</span><input value={limits.memory} onChange={(e) => setLimits({ ...limits, memory: e.target.value })} /></label>
          <label>CPUs<input type="number" step="0.5" min={0.5} value={limits.cpus} onChange={(e) => setLimits({ ...limits, cpus: Number(e.target.value) })} /></label>
          <label>Workspace limit MB <span className="help">The run pauses if the workspace grows past it</span><input type="number" min={100} value={limits.workspaceMb} onChange={(e) => setLimits({ ...limits, workspaceMb: Number(e.target.value) })} /></label>
        </div>
        <div className="small faint">Image <code>{cfg.devboxImage}</code>, set in Settings.</div>
      </section>

      <div className="foot">
        <span className="muted small grow">{busy || (needsPlan ? "Write a goal or paste a board; a session needs one of them to do anything." : plan ? "The planner starts as soon as the session exists." : "")}</span>
        <a className="btn" href="#/">Cancel</a>
        <button className="pri" onClick={create} disabled={!name.trim() || Boolean(busy)}>Create session</button>
      </div>
    </div>
  );
};

import { useEffect, useState } from "react";
import { api, isInitialized, useLive, type Config, type DraftDetail, type SessionSummary } from "../api";
import { ConnectAssistant } from "./ConnectAssistant";

/**
 * A new session is a plan: a name, and optionally a board to start from.
 * Repositories, recipes, network, agents, caps and the setup mode are set
 * on the session page, over hours if need be; nothing is cloned and no
 * container exists until you press Initialize there.
 *
 * With `draftId` (#/new?draft=<id>) the session takes the draft's
 * repositories, requirements, packs, recipes and board as well.
 *
 * With "Start from: Environment of <session>" (#/new?from=<id>) it starts on
 * a copy of that session's box instead: its settings, home volume, snapshot
 * and chosen notes, fresh clones of its repositories, and it comes up
 * initialized (docs/BOARD.md, Sessions from an environment).
 */
export const NewSessionPage = ({ draftId = null, fromSession = null }: { draftId?: string | null; fromSession?: string | null }) => {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [sources, setSources] = useState<SessionSummary[]>([]);
  const [from, setFrom] = useState(fromSession ?? "");
  const [copy, setCopy] = useState({ projectNotes: true, allNotes: false, attachments: false });
  const [requirements, setRequirements] = useState<string | null>(null);
  const [branches, setBranches] = useState<Record<string, string>>({});
  const [unapplied, setUnapplied] = useState<Record<string, number | null>>({});
  const [name, setName] = useState("");
  const [board, setBoard] = useState("");
  const [preview, setPreview] = useState<{ ok: boolean; error?: string; tickets?: { id: string; title: string; repo?: string; state: string }[] } | null>(null);
  const [draft, setDraft] = useState<DraftDetail | null>(null);
  const [draftChanged, setDraftChanged] = useState(false);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");

  const applyDraft = (d: DraftDetail) => {
    setDraft(d);
    setName(d.draft.name);
    setBoard(d.draft.tickets.length ? d.boardText : "");
    setDraftChanged(false);
    if (d.draft.promotedTo) setErr(`This draft already became the session ${d.draft.promotedTo}.`);
  };
  const loadDraft = async () => {
    if (!draftId) return;
    try {
      applyDraft(await api<DraftDetail>("GET", `/drafts/${encodeURIComponent(draftId)}`));
    } catch (e) {
      setErr(`Could not load the draft: ${(e as Error).message}`);
    }
  };
  useLive((m) => {
    if (m.type === "draft" && draftId && m.draftId === draftId) setDraftChanged(true);
  });
  useEffect(() => {
    api<Config>("GET", "/config").then(setCfg).catch((e: Error) => setErr(e.message));
    void loadDraft();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId]);

  const draftRepos = draft?.draft.repos.map((r) => r.name ?? r.target) ?? [];
  /** Repositories are picked on the session page, so a board is checked against them only when a draft brings some. */
  const validateBoard = async (text: string) => {
    if (!text.trim()) return setPreview(null);
    try {
      setPreview(await api("POST", "/board/preview", { text, repos: draftRepos.length ? draftRepos : undefined }));
    } catch (e) {
      setPreview({ ok: false, error: (e as Error).message });
    }
  };
  useEffect(() => {
    const t = setTimeout(() => void validateBoard(board), 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board, draftRepos.join(",")]);

  // Sessions whose environment a new one can start from: initialized, and no run active (the volume would change while copied).
  useEffect(() => {
    api<SessionSummary[]>("GET", "/sessions")
      .then((rows) => setSources(rows.filter((r) => !r.error && isInitialized(r.session) && r.run?.state !== "running")))
      .catch(() => setSources([]));
  }, []);
  const source = sources.find((r) => r.session.id === from)?.session;
  useEffect(() => {
    setRequirements(source ? source.requirements : null);
    setBranches({});
    setUnapplied({});
    if (!source) return;
    api<{ repos: { name: string; commits: number | null }[] }>("GET", `/sessions/${encodeURIComponent(source.id)}/commits`)
      .then((r) => setUnapplied(Object.fromEntries(r.repos.map((x) => [x.name, x.commits]))))
      .catch(() => undefined);
  }, [source?.id]);

  const create = async () => {
    setErr("");
    if (source) {
      setBusy("copying the environment (a large home volume takes minutes)…");
      try {
        const r = await api<{ session: { id: string } }>("POST", "/sessions", {
          name,
          board: board.trim() || undefined,
          requirements: requirements ?? undefined,
          fromEnvironment: { session: source.id, ...copy, branches },
        });
        location.hash = `#/s/${encodeURIComponent(r.session.id)}`;
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setBusy("");
      }
      return;
    }
    setBusy("creating…");
    try {
      const x = draft?.draft;
      const r = await api<{ session: { id: string } }>("POST", "/sessions", {
        name,
        board: board.trim() || undefined,
        // The worker's model to start from; change it in Agent options on the session page.
        agents: { worker: { driver: "claude", model: "claude-sonnet-5-5" } },
        ...(x
          ? {
              goal: x.goal,
              repos: x.repos.map((p) => ({ target: p.target, branch: p.branch, name: p.name })),
              packs: x.packs,
              allowlist: x.extraHosts,
              setupScripts: x.recipes,
              requirements: x.requirements || undefined,
              planning: x.planning,
              draftId: x.id,
            }
          : {}),
      });
      location.hash = `#/s/${encodeURIComponent(r.session.id)}`;
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  if (!cfg) return <div className={err ? "banner warn" : "loading"}>{err || "Loading…"}</div>;
  const boardInvalid = Boolean(board.trim()) && preview !== null && !preview.ok;
  const x = draft?.draft;
  const boardRepos = [...new Set((preview?.tickets ?? []).map((t) => t.repo).filter((r): r is string => Boolean(r)))];
  return (
    <div className="form">
      <div>
        <h1>New session</h1>
        <p className="muted" style={{ marginTop: 6 }}>A session starts as a plan: a name and, if you have one, a board. Repositories, recipes, network, agents and caps are set on the session page, whenever you like. Nothing is cloned and no container exists until you press Initialize there.</p>
      </div>
      {err && <div className="banner warn"><span>{err}</span><button className="quiet sm end" onClick={() => setErr("")}>Dismiss</button></div>}
      {x && (
        <div className="banner info">
          <span>
            From the draft <a href={`#/d/${encodeURIComponent(x.id)}`}><strong>{x.name}</strong></a>: {x.repos.length} repositor{x.repos.length === 1 ? "y" : "ies"}{x.repos.length ? ` (${x.repos.map((r) => r.name ?? r.target).join(", ")})` : ""}, {x.packs.length} network pack{x.packs.length === 1 ? "" : "s"}, {x.recipes.length} recipe{x.recipes.length === 1 ? "" : "s"}, {x.tickets.length} ticket{x.tickets.length === 1 ? "" : "s"}{x.requirements ? ", setup instructions" : ""}{x.goal ? ", and its goal as the first planning request" : ""}. All of it can be changed on the session page before you initialize.
          </span>
        </div>
      )}
      {draftChanged && (
        <div className="banner signal">
          <span>The draft changed after you opened it.</span>
          <button className="quiet sm end" onClick={() => void loadDraft()}>Reload from the draft (replaces your edits)</button>
        </div>
      )}
      {!x && !source && <ConnectAssistant />}

      {!x && (
        <section className="card stack">
          <h3>Start from</h3>
          <select value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Start from">
            <option value="">Blank: a plan you set up and initialize</option>
            {sources.map((r) => <option key={r.session.id} value={r.session.id}>Environment of {r.session.name}</option>)}
          </select>
          {from && !source && <div className="small warn">{sources.length ? "That session is not initialized or has a run going; pick another." : "Loading sessions…"}</div>}
          {source && (
            <>
              <p className="lead">
                A fresh board on a copy of <strong>{source.name}</strong>'s box: its settings (image, recipes, network, agents, caps, limits, mode), a copy of its home volume and snapshot, the notes below, and fresh clones of its repositories. It comes up initialized{requirements === null || requirements.trim() === source.requirements.trim() ? ", without a setup worker" : "; the setup worker checks the box against the changed setup instructions"}. {source.name} itself is not changed.
              </p>
              <label className="chk"><input type="checkbox" checked={copy.projectNotes} onChange={(e) => setCopy({ ...copy, projectNotes: e.target.checked })} /> Copy brief.md and learnings.md (env.md, setup.sh, tools/ and INDEX.md always come along)</label>
              <label className="chk"><input type="checkbox" checked={copy.allNotes} onChange={(e) => setCopy({ ...copy, allNotes: e.target.checked })} /> Copy all notes (never the last lead's handoff, state.md)</label>
              <label className="chk"><input type="checkbox" checked={copy.attachments} onChange={(e) => setCopy({ ...copy, attachments: e.target.checked })} /> Copy attachments ({source.attachments.length})</label>
              {source.repos.map((r) => (
                <label key={r.name}>
                  {r.name} <span className="help">Branch to clone from <span className="mono">{r.sourcePath}</span></span>
                  <select value={branches[r.name] ?? r.branch} onChange={(e) => setBranches({ ...branches, [r.name]: e.target.value })}>
                    <option value={r.branch}>{r.branch} (what {source.name} started from)</option>
                    {(unapplied[r.name] ?? 0) > 0 && <option value={r.runBranch}>{r.runBranch} ({unapplied[r.name]} commit{unapplied[r.name] === 1 ? "" : "s"} of {source.name}, not applied)</option>}
                  </select>
                </label>
              ))}
              <label>
                Setup instructions <span className="help">Unchanged, the box's confirmed readiness carries over. Changed, the setup worker checks the box again.</span>
                <textarea value={requirements ?? ""} onChange={(e) => setRequirements(e.target.value)} style={{ minHeight: 90 }} />
              </label>
            </>
          )}
        </section>
      )}

      <section className="card">
        <h3>Name</h3>
        <input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Nuppi MVP" autoFocus />
      </section>

      <section className="card">
        <h3>Board</h3>
        <p className="lead">Optional. Paste tickets as JSON or markdown (see <code>docs/BOARD.md</code>); they start as ready. You can also import later, write tickets by hand, or have the planner draft them once the session is initialized.</p>
        <textarea id="board" className={`mono ${preview && !preview.ok ? "invalid" : ""}`} value={board} onChange={(e) => setBoard(e.target.value)} placeholder={'{ "tickets": [ { "title": "…", "spec": "…", "acceptance": ["…"] } ] }'} style={{ minHeight: 160 }} />
        {preview && !preview.ok && <div className="banner warn"><span>{preview.error}</span></div>}
        {preview?.ok && preview.tickets && (
          <div className="small ok">
            {preview.tickets.length} ticket{preview.tickets.length === 1 ? "" : "s"} will be imported as ready: {preview.tickets.map((t) => `${t.id} ${t.title}`).join(" · ").slice(0, 300)}
          </div>
        )}
        {preview?.ok && boardRepos.length > 0 && !x && (
          <div className="small muted">
            The tickets name the repositor{boardRepos.length === 1 ? "y" : "ies"} <span className="mono">{boardRepos.join(", ")}</span>: add {boardRepos.length === 1 ? "it" : "them"} under Environment on the session page before you initialize. A run refuses to start while a ready ticket names a repository the session lacks.
          </div>
        )}
      </section>

      <div className="foot">
        <span className="muted small grow">{busy || (boardInvalid ? "Fix the board before creating the session." : "")}</span>
        <a className="btn" href="#/">Cancel</a>
        <button className="pri" onClick={create} disabled={!name.trim() || Boolean(busy) || boardInvalid}>Create session</button>
      </div>
    </div>
  );
};

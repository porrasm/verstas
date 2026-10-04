import { useEffect, useState } from "react";
import { api, useLive, type Config, type DraftDetail } from "../api";
import { ConnectAssistant } from "./ConnectAssistant";

/**
 * A new session is a plan: a name, and optionally a board to start from.
 * Repositories, recipes, network, agents, caps and the setup mode are set
 * on the session page, over hours if need be; nothing is cloned and no
 * container exists until you press Initialize there.
 *
 * With `draftId` (#/new?draft=<id>) the session takes the draft's
 * repositories, requirements, packs, recipes and board as well.
 */
export const NewSessionPage = ({ draftId = null }: { draftId?: string | null }) => {
  const [cfg, setCfg] = useState<Config | null>(null);
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
  const validateBoard = async (text: string) => {
    if (!text.trim()) return setPreview(null);
    try {
      setPreview(await api("POST", "/board/preview", { text, repos: draftRepos }));
    } catch (e) {
      setPreview({ ok: false, error: (e as Error).message });
    }
  };
  useEffect(() => {
    const t = setTimeout(() => void validateBoard(board), 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board, draftRepos.join(",")]);

  const create = async () => {
    setErr("");
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
      {!x && <ConnectAssistant />}

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
      </section>

      <div className="foot">
        <span className="muted small grow">{busy || (boardInvalid ? "Fix the board before creating the session." : "")}</span>
        <a className="btn" href="#/">Cancel</a>
        <button className="pri" onClick={create} disabled={!name.trim() || Boolean(busy) || boardInvalid}>Create session</button>
      </div>
    </div>
  );
};

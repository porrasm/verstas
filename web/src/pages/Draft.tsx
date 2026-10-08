import { useEffect, useState } from "react";
import { api, fmtAgo, fmtDateTime, useLive, useNow, type DraftDetail, type DraftTicket } from "../api";

/**
 * Review a draft session an assistant prepared (or is still preparing: the
 * page follows its edits live). "Continue" opens the New session form filled
 * from it; nothing becomes a session until you press Create there.
 */
export const DraftPage = ({ id }: { id: string }) => {
  const [data, setData] = useState<DraftDetail | null>(null);
  const [gone, setGone] = useState(false);
  const [err, setErr] = useState("");
  const [arm, setArm] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const now = useNow();
  const load = () =>
    api<DraftDetail>("GET", `/drafts/${encodeURIComponent(id)}`)
      .then((d) => {
        setData(d);
        setGone(false);
      })
      .catch((e: Error & { status?: number }) => (e.status === 404 ? setGone(true) : setErr(e.message)));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  useLive((m) => {
    if (m.type === "draft" && m.draftId === id) {
      if (m.deleted) setGone(true);
      else void load();
    }
  });

  const del = async () => {
    try {
      await api("DELETE", `/drafts/${encodeURIComponent(id)}`);
      location.hash = "#/";
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  if (gone) return <div className="card empty-state"><h3>This draft no longer exists</h3><a className="btn" href="#/">Back to sessions</a></div>;
  if (!data) return <div className={err ? "banner warn" : "loading"}>{err || "Loading…"}</div>;
  const { draft, problems } = data;
  const promoted = Boolean(draft.promotedTo);
  const byState = { ready: draft.tickets.filter((t) => (t.state ?? "ready") === "ready").length, backlog: draft.tickets.filter((t) => t.state === "backlog").length };
  const tickets = [...draft.tickets].sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100) || Number(a.id.slice(2)) - Number(b.id.slice(2)));

  return (
    <div className="stack">
      <div className="row">
        <div className="grow">
          <div className="muted small">Draft session · prepared by {draft.createdBy === "agent" ? "an assistant" : "you"} · updated <span title={fmtDateTime(draft.updatedAt)}>{fmtAgo(draft.updatedAt, now)}</span></div>
          <h1>{draft.name}</h1>
          <div className="mono faint small">{draft.id}</div>
        </div>
        {arm ? (
          <span className="confirm">
            <button className="warn solid sm" onClick={() => void del()}>Delete this draft</button>
            <button className="quiet sm" onClick={() => setArm(false)}>Cancel</button>
          </span>
        ) : (
          <button className="quiet" onClick={() => setArm(true)}>Delete</button>
        )}
        {promoted ? (
          <a className="btn pri" href={`#/s/${encodeURIComponent(draft.promotedTo!)}`}>Open the session</a>
        ) : (
          <a
            className="btn pri"
            href={problems.errors.length ? undefined : `#/new?draft=${encodeURIComponent(draft.id)}`}
            aria-disabled={problems.errors.length > 0}
            title={problems.errors.length ? "Fix the errors first (ask the assistant, or edit on the form)" : "Opens the New session form filled from this draft; nothing is created until you press Create there"}
          >
            Continue to create session
          </a>
        )}
      </div>

      {err && <div className="banner warn"><span>{err}</span><button className="quiet sm end" onClick={() => setErr("")}>Dismiss</button></div>}
      {promoted && <div className="banner good">This draft became the session <a href={`#/s/${encodeURIComponent(draft.promotedTo!)}`}><code>{draft.promotedTo}</code></a>{draft.promotedAt ? ` on ${fmtDateTime(draft.promotedAt)}` : ""}. It is read-only now.</div>}
      {problems.errors.length > 0 && (
        <div className="card danger">
          <h3>Errors <span className="muted small">creating a session would refuse these</span></h3>
          <ul className="checks">{problems.errors.map((e) => <li key={e} className="err small">{e}</li>)}</ul>
        </div>
      )}
      {problems.warnings.length > 0 && (
        <div className="card">
          <h3>Warnings <span className="muted small">the session can still be created</span></h3>
          <ul className="checks">{problems.warnings.map((w) => <li key={w} className="small muted">{w}</li>)}</ul>
        </div>
      )}

      {draft.notes.trim() && (
        <section className="card attention">
          <h3>Notes for you</h3>
          <pre className="small" style={{ fontFamily: "inherit" }}>{draft.notes}</pre>
        </section>
      )}

      <section className="card">
        <h3>Goal</h3>
        {draft.goal.trim() ? <pre className="small" style={{ fontFamily: "inherit" }}>{draft.goal}</pre> : <div className="muted small">No goal.</div>}
      </section>

      <section className="card">
        <h3>Session requirements</h3>
        {draft.requirements.trim() ? (
          <>
            <ul className="checks">{draft.requirements.split("\n").filter((l) => l.trim()).map((l, i) => <li key={i} className="small">{l}</li>)}</ul>
            <p className="lead">A setup worker makes the box meet these right after the session is created; tickets start after you confirm.</p>
          </>
        ) : (
          <div className="muted small">None: there will be no setup phase.</div>
        )}
      </section>

      <div className="two">
        <section className="card">
          <h3>Repositories</h3>
          {draft.repos.length ? (
            <ul className="checks">
              {draft.repos.map((r) => (
                <li key={r.name ?? r.target} className="small">
                  <strong>{r.target}</strong> <span className="muted">{r.branch ? `branch ${r.branch}` : "checked-out branch"}</span>
                  {r.name && r.name !== r.target ? <span className="muted"> · as /workspace/{r.name}</span> : null}
                </li>
              ))}
            </ul>
          ) : (
            <div className="muted small">None.</div>
          )}
        </section>
        <section className="card">
          <h3>Network and recipes</h3>
          <div className="small"><b>Packs</b> {draft.packs.length ? draft.packs.join(", ") : "none"} <span className="faint">(plus the Claude API)</span></div>
          {draft.extraHosts.length > 0 && <div className="small"><b>Extra hosts</b> <span className="mono">{draft.extraHosts.join(", ")}</span></div>}
          <div className="small"><b>Recipes</b> {draft.recipes.length ? draft.recipes.join(", ") : "none"}</div>
        </section>
      </div>

      <section className="card">
        <div className="row">
          <h3>Board</h3>
          <span className="muted small">{draft.tickets.length} ticket{draft.tickets.length === 1 ? "" : "s"} · {byState.ready} ready · {byState.backlog} backlog · in run order</span>
        </div>
        {tickets.length === 0 && <div className="muted small" style={{ marginTop: 8 }}>No tickets yet{draft.goal.trim() ? "; the planner can draft them from the goal once the session exists." : "."}</div>}
        <div className="stack tight" style={{ marginTop: 10 }}>
          {tickets.map((t) => <TicketRow key={t.id} t={t} open={open === t.id} onToggle={() => setOpen(open === t.id ? null : t.id)} />)}
        </div>
      </section>
    </div>
  );
};

const TicketRow = ({ t, open, onToggle }: { t: DraftTicket; open: boolean; onToggle: () => void }) => (
  <div className={`tk ${t.state ?? "ready"}${open ? " open" : ""}`} onClick={onToggle} role="button" tabIndex={0} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onToggle()}>
    <div className="id">
      <span>{t.id}</span>
      <span className="k">{t.kind ?? "feature"} · {t.size ?? "M"} · p{t.priority ?? 100}</span>
      {t.pinned && <span className="pin">pinned</span>}
    </div>
    <div className="title">{t.title}</div>
    <div className="meta">
      {(t.repos ?? (t.repo ? [t.repo] : [])).map((r) => <span key={r} className="pill quiet mono">{r}</span>)}
      <span className={`pill ${t.state === "backlog" ? "quiet" : "sig"}`}>{t.state ?? "ready"}</span>
      {(t.deps ?? []).length > 0 && <span className="pill quiet">after {(t.deps ?? []).join(", ")}</span>}
      <span className="pill quiet">{(t.acceptance ?? []).length} criteria</span>
    </div>
    {open && (
      <div className="why" onClick={(e) => e.stopPropagation()} style={{ cursor: "text" }}>
        {t.spec?.trim() ? <pre className="small" style={{ fontFamily: "inherit", color: "var(--text-2)" }}>{t.spec}</pre> : <div className="warn">No spec.</div>}
        {(t.acceptance ?? []).length > 0 && (
          <>
            <div style={{ marginTop: 8 }}><b>Acceptance</b></div>
            <ul className="checks">{(t.acceptance ?? []).map((a, i) => <li key={i}>☐ {a}</li>)}</ul>
          </>
        )}
        {(t.notes ?? []).length > 0 && (
          <>
            <div style={{ marginTop: 8 }}><b>Notes</b></div>
            <ul className="checks">{(t.notes ?? []).map((n, i) => <li key={i}>{n}</li>)}</ul>
          </>
        )}
      </div>
    )}
  </div>
);

import { useEffect, useState } from "react";
import { api, fmtAgo, fmtDateTime, fmtUsd, STATE_LABEL, useLive, useNow, type DraftRow, type SessionSummary, type Status } from "../api";
import { ConnectAssistant } from "./ConnectAssistant";

const ORDER = ["done", "review", "in_progress", "waiting", "blocked", "ready", "backlog"];

const stateOf = (s: SessionSummary): { label: string; tone: string; dot: string } => {
  if (s.run?.state === "running") return { label: s.session.state === "planning" ? "planning" : s.run.currentTicket ? `working on ${s.run.currentTicket}` : "running", tone: "sig", dot: "run" };
  if (s.openRequests) return { label: "waiting for you", tone: "warn", dot: "bad" };
  switch (s.session.state) {
    case "finished":
      return { label: "finished", tone: "good", dot: "good" };
    case "created":
      return { label: "not started", tone: "quiet", dot: "" };
    case "halted":
      return { label: "halted by the agent", tone: "warn", dot: "bad" };
    case "paused":
      return { label: "paused", tone: "sig", dot: "" };
    default:
      return { label: s.session.state, tone: "quiet", dot: "" };
  }
};

export const SessionsPage = ({ status }: { status: Status | null }) => {
  const [rows, setRows] = useState<SessionSummary[] | null>(null);
  const [err, setErr] = useState("");
  const [arm, setArm] = useState<string | null>(null);
  const now = useNow();
  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const load = () => api<SessionSummary[]>("GET", "/sessions").then(setRows).catch((e: Error) => setErr(e.message));
  const loadDrafts = () => api<DraftRow[]>("GET", "/drafts").then(setDrafts).catch(() => setDrafts([]));
  useEffect(() => {
    load();
    void loadDrafts();
  }, []);
  useLive((m) => {
    if (m.type === "draft") void loadDrafts();
    if (m.type === "change") load();
    if (m.type === "event" && (m.event.kind === "run" || m.event.kind === "ticket")) load();
  });
  const del = async (id: string) => {
    setArm(null);
    try {
      await api("DELETE", `/sessions/${encodeURIComponent(id)}`);
      load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const sorted = rows ? [...rows].sort((a, b) => (b.totals?.lastActivityAt ?? b.session.createdAt).localeCompare(a.totals?.lastActivityAt ?? a.session.createdAt)) : null;
  return (
    <div className="stack">
      <div className="row">
        <h1>Sessions</h1>
        <span className="muted small" title="Every session is a directory under this path">root <code>{status?.sessionsRoot ?? "…"}</code></span>
        <a className="btn pri end" href="#/new">New session</a>
      </div>
      {err && <div className="banner warn"><span>{err}</span><button className="quiet sm end" onClick={() => setErr("")}>Dismiss</button></div>}
      {status && !status.docker.ok && <div className="banner warn">Docker is not reachable. Sessions can be created and edited, but not run.</div>}
      {status && !status.image && status.docker.ok && <div className="banner signal"><span>The dev-box image <code>{status.imageName}</code> is missing. Build it with <code>npm run image:build</code>.</span></div>}
      {status && !status.hasClaudeToken && <div className="banner signal"><span>No Claude token yet. Run <code>claude setup-token</code> and paste it in <a href="#/settings">Settings</a>.</span></div>}
      <Drafts rows={drafts.filter((d) => !d.promotedTo)} now={now} />
      {sorted && sorted.length === 0 ? (
        <div className="card empty-state">
          <h3>No sessions yet</h3>
          <p>Create one, paste a board or let the planner draft it, and start the run.</p>
          <a className="btn pri" href="#/new">New session</a>
        </div>
      ) : (
        <div className="tbl sessions">
          <table>
            <thead>
              <tr><th>Session</th><th>Progress</th><th>State</th><th>Spent</th><th>Last activity</th><th></th></tr>
            </thead>
            <tbody>
              {sorted?.map((s) => {
                const total = Object.values(s.counts).reduce((a, b) => a + b, 0);
                const st = stateOf(s);
                const last = s.totals?.lastActivityAt ?? s.session.createdAt;
                return (
                  <tr key={s.session.id}>
                    <td className="name">
                      <a href={`#/s/${encodeURIComponent(s.session.id)}`}><strong>{s.session.name}</strong></a>
                      {s.session.goal && <div className="goal ellipsis" title={s.session.goal}>{s.session.goal}</div>}
                      <div className="mono faint small">{s.session.id}{s.session.repos.length ? ` · ${s.session.repos.map((r) => r.name).join(", ")}` : ""}</div>
                      {s.error ? <div className="err small">{s.error}</div> : null}
                    </td>
                    <td className="prog">
                      {total === 0 ? (
                        <span className="muted small">empty board</span>
                      ) : (
                        <>
                          <div className="progress" title={ORDER.filter((k) => s.counts[k]).map((k) => `${s.counts[k]} ${STATE_LABEL[k]}`).join(", ")}>
                            {ORDER.filter((k) => s.counts[k]).map((k) => <span key={k} className={k} style={{ width: `${((s.counts[k] ?? 0) / total) * 100}%` }} />)}
                          </div>
                          <div className="small muted">{s.counts.done ?? 0}/{total} done{s.counts.in_progress ? ` · ${s.counts.in_progress} in progress` : ""}{s.counts.blocked ? ` · ${s.counts.blocked} blocked` : ""}</div>
                        </>
                      )}
                      {s.openRequests ? <div className="err small">{s.openRequests} request{s.openRequests > 1 ? "s" : ""} waiting for you</div> : null}
                      {s.ideas ? <div className="muted small">{s.ideas} idea{s.ideas > 1 ? "s" : ""}</div> : null}
                    </td>
                    <td>
                      <span className={`pill ${st.tone}`}>{st.dot ? <span className={`dot ${st.dot}`} /> : null}{st.label}</span>
                      {s.run?.pauseReason && s.run.state !== "running" ? <div className="muted small">{s.run.pauseReason}</div> : null}
                    </td>
                    <td className="mono">{s.totals ? fmtUsd(s.totals.usd) : "—"}{s.totals && s.totals.runs > 1 ? <div className="faint small">{s.totals.runs} runs</div> : null}</td>
                    <td title={fmtDateTime(last)}>{fmtAgo(last, now)}</td>
                    <td className="acts">
                      {arm === s.session.id ? (
                        <span className="confirm">
                          <button className="warn solid sm" onClick={() => del(s.session.id)}>Delete session and its directory</button>
                          <button className="quiet sm" onClick={() => setArm(null)}>Cancel</button>
                        </span>
                      ) : (
                        <>
                          <a className="btn" href={`#/s/${encodeURIComponent(s.session.id)}`}>Open</a>{" "}
                          <button className="quiet" onClick={() => setArm(s.session.id)} disabled={s.run?.state === "running"} title={s.run?.state === "running" ? "Stop the run first" : "Removes its containers, network and directory"}>Delete</button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
              {!sorted && <tr><td colSpan={6} className="loading">Loading…</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

/** Drafts an assistant prepared (or is preparing): review one, then create the session from it. */
const Drafts = ({ rows, now }: { rows: DraftRow[]; now: number }) => (
  <div className="stack tight">
    {rows.length > 0 && (
      <div className="tbl sessions">
        <table>
          <thead>
            <tr><th>Draft</th><th>Board</th><th>Check</th><th>Updated</th><th></th></tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.id}>
                <td className="name">
                  <a href={`#/d/${encodeURIComponent(d.id)}`}><strong>{d.name}</strong></a> <span className="pill quiet">draft</span>
                  {d.goal && <div className="goal ellipsis" title={d.goal}>{d.goal}</div>}
                  <div className="mono faint small">{d.id}{d.repos.length ? ` · ${d.repos.join(", ")}` : ""}</div>
                </td>
                <td className="small muted">{d.tickets} ticket{d.tickets === 1 ? "" : "s"}</td>
                <td>{d.errors ? <span className="pill warn">{d.errors} error{d.errors > 1 ? "s" : ""}</span> : <span className="pill good">ready to create</span>}{d.warnings ? <div className="muted small">{d.warnings} warning{d.warnings > 1 ? "s" : ""}</div> : null}</td>
                <td title={fmtDateTime(d.updatedAt)}>{fmtAgo(d.updatedAt, now)}</td>
                <td className="acts"><a className="btn" href={`#/d/${encodeURIComponent(d.id)}`}>Review</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}
    <ConnectAssistant />
  </div>
);

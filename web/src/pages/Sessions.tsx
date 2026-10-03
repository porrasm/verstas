import { useEffect, useState } from "react";
import { api, fmtUsd, useLive, type SessionSummary, type Status } from "../api";

const stateDot = (s: SessionSummary): string => (s.run?.state === "running" ? "run" : s.session.state === "finished" ? "good" : s.openRequests ? "bad" : "");

export const SessionsPage = ({ status }: { status: Status | null }) => {
  const [rows, setRows] = useState<SessionSummary[] | null>(null);
  const [err, setErr] = useState("");
  const load = () => api<SessionSummary[]>("GET", "/sessions").then(setRows).catch((e: Error) => setErr(e.message));
  useEffect(() => {
    load();
  }, []);
  useLive((m) => {
    if (m.type === "change") load();
    if (m.type === "event" && (m.event.kind === "run" || m.event.kind === "ticket")) load();
  });
  const del = async (id: string) => {
    if (!confirm(`Delete session ${id}? This removes its containers and its directory.`)) return;
    try {
      await api("DELETE", `/sessions/${id}`);
      load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <div className="grid">
      <div className="row">
        <h2>Sessions</h2>
        <span className="muted small">root: <code>{status?.sessionsRoot ?? "…"}</code></span>
        <span style={{ marginLeft: "auto" }}><a href="#/new"><button className="pri">New session</button></a></span>
      </div>
      {err && <div className="err">{err}</div>}
      {!status?.docker.ok && <div className="card err">Docker is not reachable. Sessions can be created and edited, but not run.</div>}
      {status && !status.image && status.docker.ok && <div className="card">The dev-box image <code>{status.imageName}</code> is missing. Build it with <code>npm run image:build</code>.</div>}
      {status && !status.hasClaudeToken && <div className="card">No Claude token yet. Run <code>claude setup-token</code> and paste it in <a href="#/settings">Settings</a>.</div>}
      <table>
        <thead>
          <tr><th>Session</th><th>Repos</th><th>Board</th><th>State</th><th>Cost</th><th></th></tr>
        </thead>
        <tbody>
          {rows?.map((s) => (
            <tr key={s.session.id}>
              <td>
                <a href={`#/s/${encodeURIComponent(s.session.id)}`}><strong>{s.session.name}</strong></a>
                <div className="muted small">{s.session.goal.slice(0, 120)}</div>
                <div className="mono muted">{s.session.id}</div>
              </td>
              <td className="mono">{s.session.repos.map((r) => r.name).join(" · ") || "—"}</td>
              <td className="mono small">
                {Object.entries(s.counts).map(([k, v]) => `${v} ${k}`).join(" · ") || "empty"}
                {s.openRequests ? <div className="err">{s.openRequests} request{s.openRequests > 1 ? "s" : ""} waiting</div> : null}
                {s.ideas ? <div className="muted">{s.ideas} idea{s.ideas > 1 ? "s" : ""}</div> : null}
              </td>
              <td>
                <span className={`dot ${stateDot(s)}`} />
                {s.run?.state === "running" ? `running${s.run.currentTicket ? ` · ${s.run.currentTicket}` : ""}` : s.session.state}
                {s.run?.pauseReason && s.run.state !== "running" ? <div className="muted small">{s.run.pauseReason}</div> : null}
              </td>
              <td className="mono">{fmtUsd(s.run?.cost.usd)}</td>
              <td className="row" style={{ justifyContent: "flex-end" }}>
                <a href={`#/s/${encodeURIComponent(s.session.id)}`}><button>Open</button></a>
                <button className="warn" onClick={() => del(s.session.id)} disabled={s.run?.state === "running"}>Delete</button>
              </td>
            </tr>
          ))}
          {rows && rows.length === 0 && (
            <tr><td colSpan={6} className="muted">No sessions yet. Create one, paste a board or let the planner draft it, and start the run.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
};

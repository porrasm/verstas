import { useEffect, useState } from "react";
import { api, type SessionDetail } from "../api";

/**
 * PLACEHOLDER. The session page (board columns, live log, inbox with
 * approve/deny, ticket drawer, run controls, export) is the next piece of
 * work; see the design artifact's "Session" mockup. The API it needs is
 * complete in src/web/api.ts. This stub only proves the route and the data.
 */
export const SessionPage = ({ id }: { id: string }) => {
  const [d, setD] = useState<SessionDetail | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    api<SessionDetail>("GET", `/sessions/${encodeURIComponent(id)}`).then(setD).catch((e: Error) => setErr(e.message));
  }, [id]);
  if (err) return <div className="err">{err}</div>;
  if (!d) return <div className="muted">Loading…</div>;
  return (
    <div className="grid">
      <h2>{d.session.name}</h2>
      <div className="muted small">Session page not built yet. Raw state below.</div>
      <pre className="card" style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify({ session: d.session, run: d.run, sandbox: d.sandbox, tickets: d.board.tickets.map((t) => `${t.id} [${t.state}] ${t.title}`), inbox: d.inbox }, null, 2)}</pre>
    </div>
  );
};

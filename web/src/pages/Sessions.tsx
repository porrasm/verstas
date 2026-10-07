import { useEffect, useState } from "react";
import { api, ApiError, upload, fmtAgo, fmtDateTime, fmtUsd, STATE_LABEL, useLive, useNow, type DraftRow, type SessionSummary, type Status } from "../api";

const ORDER = ["done", "review", "in_progress", "waiting", "blocked", "ready", "backlog"];

const stateOf = (s: SessionSummary): { label: string; tone: string; dot: string } => {
  if (s.run?.state === "running") {
    const label = s.session.state === "planning" ? "planning" : s.session.state === "checking" ? (s.session.initializedAt ? "checking the environment" : "initializing") : s.run.currentTicket ? `working on ${s.run.currentTicket}` : "running";
    return { label, tone: "sig", dot: "run" };
  }
  if (s.openRequests) return { label: "waiting for you", tone: "warn", dot: "bad" };
  if (!s.session.initializedAt) return s.session.readiness?.verdict === "needs" ? { label: "initialization needs you", tone: "warn", dot: "bad" } : { label: "not initialized", tone: "quiet", dot: "" };
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
  const [note, setNote] = useState("");
  const [quitArm, setQuitArm] = useState(false);
  const [busy, setBusy] = useState("");
  const hostAct = async (label: string, fn: () => Promise<string>) => {
    setBusy(label);
    setErr("");
    try {
      setNote(await fn());
      load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const pauseAll = () =>
    hostAct("pausing", async () => {
      const r = await api<{ sessions: string[] }>("POST", "/host/runs", { action: "pause" });
      return r.sessions.length ? `${r.sessions.length} run${r.sessions.length > 1 ? "s" : ""} will pause after the current ticket.` : "No run is active.";
    });
  const stopContainers = () =>
    hostAct("stopping containers", async () => {
      const r = await api<{ stopped: string[]; skipped: string[] }>("POST", "/host/sandboxes", { action: "stop" });
      const skipped = r.skipped.length ? ` ${r.skipped.length} with an active run kept running; pause or stop those runs first.` : "";
      return `${r.stopped.length ? `Stopped ${r.stopped.length} container${r.stopped.length > 1 ? "s" : ""}.` : "No idle container was running."}${skipped} A stopped box starts again with its next run.`;
    });
  const stopOne = (id: string) =>
    hostAct("stopping container", async () => {
      await api("POST", `/sessions/${encodeURIComponent(id)}/sandbox`, { action: "stop" });
      return `Container of ${id} stopped. It starts again with the next run.`;
    });
  const quit = () =>
    hostAct("quitting", async () => {
      setQuitArm(false);
      await api("POST", "/host/quit");
      return "Verstas is shutting down: runs stop and requeue their tickets, containers stop.";
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
  /** An archive whose id exists here waits for your choice: replace that session or import a copy. */
  const [clash, setClash] = useState<{ upload: string; id: string; name: string } | null>(null);
  /** On replace, keep this machine's home volume and snapshot of the session: Initialize after the import is then quick. */
  const [keepEnv, setKeepEnv] = useState(true);
  const runImport = async (uploadId: string, as?: "replace" | "copy"): Promise<string> => {
    setClash(null);
    try {
      const r = await api<{ session: { id: string; name: string }; unmapped: string[]; skipped: string[] }>("POST", "/sessions/import", { upload: uploadId, as, ...(as === "replace" ? { keepEnvironment: keepEnv } : {}) });
      const unmapped = r.unmapped.length ? ` No work target here for ${r.unmapped.join(", ")}: add one with the same name to apply its work to a repository here (exporting bundles works regardless).` : "";
      return `Imported ${r.session.name} (${r.session.id}). Open it and press Initialize: the container, recipes and setup are rebuilt here; the clones, board and notes are kept.${unmapped}`;
    } catch (e) {
      const exists = e instanceof ApiError && e.status === 409 ? (e.body as { exists?: { id: string; name: string } } | null)?.exists : undefined;
      if (!exists) throw e;
      setClash({ upload: uploadId, ...exists });
      return "";
    }
  };
  const importArchive = (uploadId: string, as: "replace" | "copy") => hostAct("importing", () => runImport(uploadId, as));
  const pickArchive = (file: File | undefined) => {
    if (!file) return;
    void hostAct("uploading", async () => {
      const u = await upload(file);
      return runImport(u.id);
    });
  };
  const sorted = rows ? [...rows].sort((a, b) => (b.totals?.lastActivityAt ?? b.session.createdAt).localeCompare(a.totals?.lastActivityAt ?? a.session.createdAt)) : null;
  return (
    <div className="stack">
      <div className="row">
        <h1>Sessions</h1>
        <span className="muted small" title="Every session is a directory under this path">root <code>{status?.sessionsRoot ?? "…"}</code></span>
        <span className="end row" style={{ gap: 6 }}>
          <button className="quiet sm" onClick={pauseAll} disabled={Boolean(busy) || !rows?.some((r) => r.run?.state === "running")} title="Every active run finishes its current ticket, then stops">Pause all runs</button>
          <button className="quiet sm" onClick={stopContainers} disabled={Boolean(busy) || !rows?.some((r) => r.sandbox === "running")} title="Stops every idle session container and proxy; a stopped box starts again with its next run">Stop all containers</button>
          {quitArm ? (
            <span className="confirm">
              <button className="warn solid sm" onClick={quit}>Quit: stop runs, requeue tickets, stop containers</button>
              <button className="quiet sm" onClick={() => setQuitArm(false)}>Cancel</button>
            </span>
          ) : (
            <button className="quiet sm" onClick={() => setQuitArm(true)} disabled={Boolean(busy)} title="Shut Verstas down: active runs stop and requeue their tickets, containers stop, the app exits">Quit Verstas</button>
          )}
          <label className="btn" aria-disabled={Boolean(busy)} title="A session exported from another machine (.ver)">
            Import session…
            <input type="file" accept=".ver,.zip" hidden disabled={Boolean(busy)} onChange={(e) => { pickArchive(e.target.files?.[0]); e.target.value = ""; }} />
          </label>
          <a className="btn pri" href="#/new">New session</a>
        </span>
      </div>
      {clash && (
        <div className="banner warn">
          <span>
            A session <code>{clash.id}</code> ({clash.name}) exists here already. Replace it with the imported one (its container, clones and history here are removed), or import a copy under a new id?
            <label className="chk small" title="Replace removes the container, proxy and network either way. Kept, the home volume (toolchains, caches) and the snapshot stay, so Initialize after the import finds everything installed."><input type="checkbox" checked={keepEnv} onChange={(e) => setKeepEnv(e.target.checked)} /> Keep this machine's environment (home volume and snapshot)</label>
          </span>
          <span className="end row" style={{ gap: 6 }}>
            <button className="warn solid sm" onClick={() => importArchive(clash.upload, "replace")} disabled={Boolean(busy)}>Replace</button>
            <button className="sm" onClick={() => importArchive(clash.upload, "copy")} disabled={Boolean(busy)}>Import a copy</button>
            <button className="quiet sm" onClick={() => setClash(null)}>Cancel</button>
          </span>
        </div>
      )}
      {err && <div className="banner warn"><span>{err}</span><button className="quiet sm end" onClick={() => setErr("")}>Dismiss</button></div>}
      {note && <div className="banner good" role="status"><span>{note}</span><button className="quiet sm end" onClick={() => setNote("")}>Dismiss</button></div>}
      {status && !status.docker.ok && <div className="banner warn">Docker is not reachable. Sessions can be created and edited, but not run.</div>}
      {status && !status.image && status.docker.ok && <div className="banner signal"><span>The dev-box image <code>{status.imageName}</code> is missing. Build it with <code>npm run image:build</code>.</span></div>}
      {status && !Object.values(status.credentials ?? {}).some(Boolean) && <div className="banner signal"><span>No agent credential yet. Run <code>claude setup-token</code> and paste it in <a href="#/settings">Settings</a>, or add a Codex login or a Cursor key there.</span></div>}
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
                      {s.sandbox === "running" && (
                        <div className="small muted" style={{ marginTop: 4 }}>
                          container running
                          {s.run?.state !== "running" && <> · <button className="quiet sm" style={{ padding: "0 4px" }} onClick={() => stopOne(s.session.id)} disabled={Boolean(busy)} title="Stop this session's container and proxy; they start again with the next run">stop</button></>}
                        </div>
                      )}
                      {s.sandbox === "stopped" && <div className="small faint" style={{ marginTop: 4 }}>container stopped</div>}
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
  </div>
);

import { useEffect, useMemo, useRef, useState } from "react";
import { api, fmtTime, fmtUsd, useLive, type Board, type Inbox, type Run, type Session, type SessionDetail, type Ticket, type VEvent } from "../api";

const COLUMNS: { key: string; title: string; states: string[] }[] = [
  { key: "backlog", title: "Backlog", states: ["backlog"] },
  { key: "ready", title: "Ready", states: ["ready"] },
  { key: "in_progress", title: "In progress", states: ["in_progress"] },
  { key: "review", title: "Review", states: ["review"] },
  { key: "waiting", title: "Waiting · blocked", states: ["waiting", "blocked"] },
  { key: "done", title: "Done", states: ["done"] },
];

const USER_MOVES: Record<string, string[]> = {
  backlog: ["ready"],
  ready: ["backlog"],
  in_progress: [],
  review: [],
  waiting: ["ready", "backlog", "blocked"],
  blocked: ["ready", "backlog"],
  done: ["ready"],
};

const evClass = (e: VEvent): string => {
  if (e.kind === "gate") return `gate ${e.ok ? "ok" : "fail"}`;
  if (e.kind === "tool_result") return e.ok ? "tool" : "fail";
  if (e.kind === "tool_use") return "tool";
  if (e.kind === "worker_done") return e.ok ? "ok" : "fail";
  return e.kind;
};

const evText = (e: VEvent): JSX.Element | string => {
  switch (e.kind) {
    case "text":
      return `${e.role ? `[${String(e.role)}] ` : ""}${String(e.text)}`;
    case "tool_use":
      return <><b>{String(e.tool).replace(/^mcp__board__/, "board:")}</b> {String(e.summary)}</>;
    case "tool_result":
      return `→ ${String(e.summary)}`;
    case "gate":
      return `gate ${String(e.name)}: ${e.ok ? "ok" : "FAILED"} ${String(e.summary)}`;
    case "ticket":
      return `${String(e.ticket)} ${String(e.from)} → ${String(e.to)}${e.note ? ` · ${String(e.note)}` : ""}`;
    case "run":
      return `run ${String(e.state)}${e.reason ? ` · ${String(e.reason)}` : ""}`;
    case "denied_network":
      return `proxy denied ${String(e.host)}:${String(e.port)}`;
    case "worker_done":
      return `${String(e.role)} done · ${String(e.stopReason)} · ${String(e.turns)} turns · ${String(e.seconds)}s · ${fmtUsd(Number(e.costUsd))}`;
    case "cost":
      return "";
    default:
      return String(e.text ?? e.summary ?? JSON.stringify(e));
  }
};

export const SessionPage = ({ id }: { id: string }) => {
  const [session, setSession] = useState<Session | null>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [run, setRun] = useState<Run | undefined>();
  const [active, setActive] = useState(false);
  const [sandbox, setSandbox] = useState<SessionDetail["sandbox"]>(null);
  const [events, setEvents] = useState<VEvent[]>([]);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [importText, setImportText] = useState<string | null>(null);
  const [exportInfo, setExportInfo] = useState<string[] | null>(null);
  const [busy, setBusy] = useState("");
  const logRef = useRef<HTMLDivElement>(null);

  const load = async () => {
    try {
      const d = await api<SessionDetail>("GET", `/sessions/${encodeURIComponent(id)}`);
      setSession(d.session);
      setBoard(d.board);
      setInbox(d.inbox);
      setRun(d.run);
      setActive(d.active);
      setSandbox(d.sandbox);
      const ev = await api<{ events: VEvent[] }>("GET", `/sessions/${encodeURIComponent(id)}/events?limit=400`);
      setEvents(ev.events.filter((e) => e.kind !== "cost"));
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  useEffect(() => {
    void load();
  }, [id]);
  const live = useLive((m) => {
    if (m.sessionId !== id) return;
    if (m.type === "change") {
      if (m.board) setBoard(m.board);
      if (m.inbox) setInbox(m.inbox);
      if (m.session) setSession(m.session);
    } else if (m.type === "event") {
      if (m.event.kind === "cost") return;
      setEvents((ev) => [...ev.slice(-999), m.event]);
      if (m.event.kind === "run" || m.event.kind === "ticket") void refreshRun();
    }
  });
  const refreshRun = async () => {
    const d = await api<SessionDetail>("GET", `/sessions/${encodeURIComponent(id)}`).catch(() => null);
    if (d) {
      setRun(d.run);
      setActive(d.active);
      setSandbox(d.sandbox);
    }
  };
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [events.length]);

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setErr("");
    try {
      await fn();
      await refreshRun();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const runAction = (action: string) => act(action, () => api("POST", `/sessions/${encodeURIComponent(id)}/run`, { action }));
  const doExport = () =>
    act("exporting", async () => {
      const r = await api<{ howTo: string[] }>("POST", `/sessions/${encodeURIComponent(id)}/export`);
      setExportInfo(r.howTo);
    });
  const doImport = () =>
    act("importing", async () => {
      const r = await api<{ created: string[]; updated: string[]; skipped: { title: string; reason: string }[] }>("POST", `/sessions/${encodeURIComponent(id)}/board/import`, { text: importText, state: "ready" });
      setImportText(null);
      setErr(r.skipped.length ? `Imported ${r.created.length}, updated ${r.updated.length}; skipped: ${r.skipped.map((s) => `${s.title} (${s.reason})`).join("; ")}` : "");
    });
  const decide = (rid: string, decision: "approve" | "deny", answer: string) =>
    act(decision, () => api("POST", `/sessions/${encodeURIComponent(id)}/requests/${rid}`, { decision, answer: answer || undefined }));

  const ticket = useMemo(() => board?.tickets.find((t) => t.id === open) ?? null, [board, open]);
  if (err && !session) return <div className="err">{err}</div>;
  if (!session || !board || !inbox) return <div className="muted">Loading…</div>;

  const openRequests = inbox.requests.filter((r) => r.state === "open");
  const done = board.tickets.filter((t) => t.state === "done").length;

  return (
    <div className="grid">
      <div className="row">
        <h2>{session.name}</h2>
        <span className={`pill ${active ? "sig" : session.state === "finished" ? "good" : openRequests.length ? "warn" : ""}`}>
          {active ? `running${run?.currentTicket ? ` · ${run.currentTicket}` : ""}` : session.state}
          {run?.pauseReason && !active ? ` · ${run.pauseReason}` : ""}
        </span>
        <span className="muted small">{done}/{board.tickets.length} done · {fmtUsd(run?.cost.usd)} · sandbox {sandbox ? `${sandbox.container}/${sandbox.proxy}` : "?"} · {live ? "live" : "reconnecting…"}</span>
        <span className="row" style={{ marginLeft: "auto" }}>
          {!active && <button className="pri" onClick={() => runAction("start")} disabled={Boolean(busy)}>Start run</button>}
          {!active && <button onClick={() => runAction("plan")} disabled={Boolean(busy)}>Plan (planner adds tickets)</button>}
          {active && <button onClick={() => runAction("pause")}>Pause after ticket</button>}
          {active && <button className="warn" onClick={() => runAction("stop")}>Stop now</button>}
          <button onClick={() => setImportText("")} disabled={Boolean(busy)}>Import board</button>
          <a href={`/api/sessions/${encodeURIComponent(id)}/board/export`} target="_blank" rel="noreferrer"><button>Export board</button></a>
          <button onClick={doExport} disabled={active || Boolean(busy)}>Export bundles</button>
        </span>
      </div>
      {err && <div className="err small">{err}</div>}
      {busy && <div className="muted small">{busy}…</div>}
      <div className="muted small">Goal: {session.goal || "(none)"} · repos: <span className="mono">{session.repos.map((r) => r.name).join(", ") || "none"}</span> · allowlist: <span className="mono">{session.allowlist.join(", ")}</span></div>

      {exportInfo && (
        <div className="card">
          <div className="row"><h3>Take the work back</h3><button style={{ marginLeft: "auto" }} onClick={() => setExportInfo(null)}>Close</button></div>
          <p className="muted small">Bundles are pure data; fetching from them runs nothing from the repository. One line per repository:</p>
          {exportInfo.map((l) => <pre key={l} className="mono" style={{ whiteSpace: "pre-wrap" }}>{l}</pre>)}
        </div>
      )}

      {importText !== null && (
        <div className="card grid">
          <div className="row"><h3>Import board (JSON or markdown, see docs/BOARD.md)</h3><button style={{ marginLeft: "auto" }} onClick={() => setImportText(null)}>Cancel</button></div>
          <textarea id="import" value={importText} onChange={(e) => setImportText(e.target.value)} style={{ minHeight: 200 }} />
          <div className="row"><span className="muted small">New tickets start as ready; known ids are updated.</span><button className="pri" style={{ marginLeft: "auto" }} onClick={doImport} disabled={!importText.trim()}>Import</button></div>
        </div>
      )}

      <div className="session">
        <div className="grid">
          <div className="board">
            {COLUMNS.map((c) => {
              const items = board.tickets.filter((t) => c.states.includes(t.state)).sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id, undefined, { numeric: true }));
              return (
                <div className="col" key={c.key}>
                  <div className="h"><span>{c.title}</span><span>{items.length}</span></div>
                  {items.map((t) => (
                    <div key={t.id} className={`tk ${run?.currentTicket === t.id && active ? "active" : ""} ${t.state === "blocked" ? "blocked" : ""} ${t.state === "waiting" ? "waiting" : ""}`} onClick={() => setOpen(t.id)}>
                      <div className="id">{t.id} · {t.size} · {t.kind}{t.repo ? ` · ${t.repo}` : ""}{t.pinned ? " · pinned" : ""}</div>
                      {t.title}
                      <div className="meta">
                        {t.deps.length ? <span className="pill">deps {t.deps.join(" ")}</span> : null}
                        {t.attempts ? <span className="pill">attempt {t.attempts}</span> : null}
                        {t.diff ? <span className="pill">+{t.diff.added} −{t.diff.removed}</span> : null}
                        {t.state === "waiting" ? <span className="pill sig">{inbox.requests.find((r) => r.ticketId === t.id && r.state === "open")?.detail.kind ?? "waiting"}</span> : null}
                      </div>
                      {(t.state === "blocked" || t.state === "waiting") && t.notes.length ? <div className="muted small" style={{ marginTop: 5 }}>{t.notes[t.notes.length - 1]!.text.slice(0, 160)}</div> : null}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
          <div className="log" ref={logRef}>
            <div className="h muted small">Live log · run {run?.id ?? "—"}</div>
            {events.map((e, i) => (
              <div className={`ev ${evClass(e)}`} key={i}>
                <span className="t">{fmtTime(e.t)}</span>
                <span>{e.ticket ? <span className="muted">{e.ticket} </span> : null}{evText(e)}</span>
              </div>
            ))}
            {events.length === 0 && <div className="muted">No events yet.</div>}
          </div>
        </div>

        <div className="grid">
          <InboxPanel inbox={inbox} onDecide={decide} onRead={(mid) => act("read", () => api("POST", `/sessions/${encodeURIComponent(id)}/messages/${mid}/read`))} onPromote={(iid) => act("promote", () => api("POST", `/sessions/${encodeURIComponent(id)}/ideas/${iid}/promote`))} />
          <SessionSettings session={session} onSave={(patch) => act("saving", async () => {
            if (patch.allowlist) await api("PUT", `/sessions/${encodeURIComponent(id)}/allowlist`, { allowlist: patch.allowlist });
            if (patch.caps || patch.limits) await api("PUT", `/sessions/${encodeURIComponent(id)}/caps`, { caps: patch.caps, limits: patch.limits });
          })} />
        </div>
      </div>

      {ticket && (
        <TicketDrawer
          ticket={ticket}
          held={active && run?.currentTicket === ticket.id}
          runId={run?.id}
          sessionId={id}
          onClose={() => setOpen(null)}
          onAction={act}
        />
      )}
    </div>
  );
};

const InboxPanel = ({ inbox, onDecide, onRead, onPromote }: { inbox: Inbox; onDecide: (rid: string, d: "approve" | "deny", answer: string) => void; onRead: (mid: string) => void; onPromote: (iid: string) => void }) => {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const open = inbox.requests.filter((r) => r.state === "open");
  const unread = inbox.messages.filter((m) => !m.read);
  const ideas = inbox.ideas.filter((i) => !i.promotedTo);
  return (
    <div className="card inbox">
      <h3>Inbox · {open.length} request{open.length === 1 ? "" : "s"} · {unread.length} message{unread.length === 1 ? "" : "s"} · {ideas.length} idea{ideas.length === 1 ? "" : "s"}</h3>
      {open.map((r) => {
        const { kind, ...rest } = r.detail;
        return (
          <div className="item" key={r.id}>
            <div><span className="pill warn">{kind}</span> <span className="muted small">{r.id}{r.ticketId ? ` · ${r.ticketId}` : ""} · {fmtTime(r.createdAt)}</span></div>
            <div className="mono small">{Object.entries(rest).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`).join(" · ")}</div>
            <div className="small">{r.why}</div>
            <div className="row" style={{ marginTop: 6 }}>
              <input placeholder="answer / note for the worker (optional)" value={answers[r.id] ?? ""} onChange={(e) => setAnswers({ ...answers, [r.id]: e.target.value })} />
              <button className="pri" onClick={() => onDecide(r.id, "approve", answers[r.id] ?? "")}>Approve</button>
              <button className="warn" onClick={() => onDecide(r.id, "deny", answers[r.id] ?? "")}>Deny</button>
            </div>
          </div>
        );
      })}
      {unread.map((m) => (
        <div className="item" key={m.id}>
          <div><span className="pill">message</span> <span className="muted small">{m.ticketId ? `${m.ticketId} · ` : ""}{fmtTime(m.createdAt)}</span></div>
          <div className="small">{m.text}</div>
          <button className="small" style={{ marginTop: 6 }} onClick={() => onRead(m.id)}>Mark read</button>
        </div>
      ))}
      {ideas.map((i) => (
        <div className="item" key={i.id}>
          <div><span className="pill acc">idea</span> <strong>{i.title}</strong> <span className="muted small">{i.ticketId ? `from ${i.ticketId}` : ""}</span></div>
          <div className="small">{i.pitch}</div>
          <button style={{ marginTop: 6 }} onClick={() => onPromote(i.id)}>Turn into a ticket</button>
        </div>
      ))}
      {open.length + unread.length + ideas.length === 0 && <div className="muted small">Nothing waiting for you.</div>}
      {inbox.requests.filter((r) => r.state !== "open").length > 0 && (
        <details style={{ marginTop: 8 }}>
          <summary className="muted small">Decided requests</summary>
          {inbox.requests.filter((r) => r.state !== "open").map((r) => (
            <div className="small muted" key={r.id}>{r.id} {r.detail.kind} · {r.state}{r.answer ? ` · ${r.answer}` : ""}</div>
          ))}
        </details>
      )}
    </div>
  );
};

const SessionSettings = ({ session, onSave }: { session: Session; onSave: (patch: { allowlist?: string[]; caps?: Partial<Session["caps"]>; limits?: Partial<Session["limits"]> }) => void }) => {
  const [allow, setAllow] = useState(session.allowlist.join("\n"));
  useEffect(() => setAllow(session.allowlist.join("\n")), [session.allowlist]);
  return (
    <details className="card">
      <summary><strong>Session settings</strong> <span className="muted small">allowlist, caps, limits, installs</span></summary>
      <div className="grid" style={{ marginTop: 10 }}>
        <label>Network allowlist (applies live)
          <textarea id="allow" value={allow} onChange={(e) => setAllow(e.target.value)} onBlur={() => onSave({ allowlist: allow.split(/\n/).map((s) => s.trim()).filter(Boolean) })} />
        </label>
        <div className="form two">
          <label>Worker minutes<input type="number" defaultValue={session.caps.workerMinutes} onBlur={(e) => onSave({ caps: { workerMinutes: Number(e.target.value) } })} /></label>
          <label>Worker turns<input type="number" defaultValue={session.caps.workerTurns} onBlur={(e) => onSave({ caps: { workerTurns: Number(e.target.value) } })} /></label>
          <label>Budget USD per worker<input type="number" defaultValue={session.caps.budgetUsd} onBlur={(e) => onSave({ caps: { budgetUsd: Number(e.target.value) } })} /></label>
          <label>Run tickets<input type="number" defaultValue={session.caps.runTickets} onBlur={(e) => onSave({ caps: { runTickets: Number(e.target.value) } })} /></label>
          <label>Attempts per ticket<input type="number" defaultValue={session.caps.ticketAttempts} onBlur={(e) => onSave({ caps: { ticketAttempts: Number(e.target.value) } })} /></label>
          <label className="chk" style={{ alignSelf: "end" }}><input type="checkbox" defaultChecked={session.caps.reviewer} onChange={(e) => onSave({ caps: { reviewer: e.target.checked } })} /> Reviewer</label>
          <label>Memory<input defaultValue={session.limits.memory} onBlur={(e) => onSave({ limits: { memory: e.target.value } })} /></label>
          <label>CPUs<input type="number" step="0.5" defaultValue={session.limits.cpus} onBlur={(e) => onSave({ limits: { cpus: Number(e.target.value) } })} /></label>
        </div>
        <div className="small muted">Installs approved so far: {session.installs.length ? session.installs.map((i) => `${i.manager} ${i.packages.join(" ")}`).join("; ") : "none"}. Container changes (memory, CPUs, installs) apply when the next run recreates the container.</div>
        <div className="small muted mono">image {session.image} · {session.id}</div>
      </div>
    </details>
  );
};

const TicketDrawer = ({ ticket, held, runId, sessionId, onClose, onAction }: { ticket: Ticket; held: boolean; runId?: number; sessionId: string; onClose: () => void; onAction: (label: string, fn: () => Promise<unknown>) => Promise<void> }) => {
  const [note, setNote] = useState("");
  const [edit, setEdit] = useState(false);
  const [draft, setDraft] = useState({ title: ticket.title, spec: ticket.spec, acceptance: ticket.acceptance.join("\n"), priority: ticket.priority, size: ticket.size, repo: ticket.repo ?? "", deps: ticket.deps.join(", ") });
  const [report, setReport] = useState<string | null>(null);
  useEffect(() => {
    setDraft({ title: ticket.title, spec: ticket.spec, acceptance: ticket.acceptance.join("\n"), priority: ticket.priority, size: ticket.size, repo: ticket.repo ?? "", deps: ticket.deps.join(", ") });
    setReport(null);
    if (runId) fetch(`/api/sessions/${encodeURIComponent(sessionId)}/runs/${runId}/tickets/${ticket.id}`).then((r) => (r.ok ? r.text() : "")).then((t) => setReport(t || null)).catch(() => undefined);
  }, [ticket.id, ticket.updatedAt, runId, sessionId]);
  const base = `/sessions/${encodeURIComponent(sessionId)}/tickets/${ticket.id}`;
  const move = (state: string) => onAction(`moving to ${state}`, () => api("POST", `${base}/state`, { state }));
  const save = () =>
    onAction("saving", () =>
      api("PUT", base, {
        title: draft.title,
        spec: draft.spec,
        acceptance: draft.acceptance.split(/\n/).map((s) => s.trim()).filter(Boolean),
        priority: Number(draft.priority),
        size: draft.size,
        repo: draft.repo || null,
        deps: draft.deps.split(/[,\s]+/).filter(Boolean),
      }),
    ).then(() => setEdit(false));
  return (
    <div className="drawer grid">
      <div className="row">
        <h3>{ticket.id} · {ticket.title}</h3>
        <span className={`pill ${ticket.state === "done" ? "good" : ticket.state === "blocked" ? "warn" : ticket.state === "in_progress" ? "sig" : ""}`}>{ticket.state}</span>
        <button style={{ marginLeft: "auto" }} onClick={onClose}>Close</button>
      </div>
      <div className="muted small mono">{ticket.kind} · {ticket.size} · priority {ticket.priority} · repo {ticket.repo ?? "—"} · deps {ticket.deps.join(", ") || "—"} · attempts {ticket.attempts}{ticket.diff ? ` · +${ticket.diff.added} −${ticket.diff.removed} in ${ticket.diff.files} files` : ""}{ticket.cost?.usd ? ` · ${fmtUsd(ticket.cost.usd)}` : ""}</div>
      {held && <div className="err small">A worker holds this ticket. Stop the run to edit or move it.</div>}
      <div className="row">
        {USER_MOVES[ticket.state]?.map((s) => <button key={s} onClick={() => move(s)} disabled={held}>Move to {s}</button>)}
        <button onClick={() => onAction("pin", () => api("PUT", base, { pinned: !ticket.pinned }))}>{ticket.pinned ? "Unpin" : "Pin (agent may not reprioritise)"}</button>
        <button onClick={() => setEdit(!edit)} disabled={held}>{edit ? "Cancel edit" : "Edit"}</button>
        <button className="warn" onClick={() => confirm(`Delete ${ticket.id}?`) && onAction("deleting", () => api("DELETE", base)).then(onClose)} disabled={held}>Delete</button>
      </div>
      {edit ? (
        <div className="grid">
          <label>Title<input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></label>
          <label>Spec<textarea value={draft.spec} onChange={(e) => setDraft({ ...draft, spec: e.target.value })} style={{ minHeight: 160 }} /></label>
          <label>Acceptance criteria (one per line)<textarea value={draft.acceptance} onChange={(e) => setDraft({ ...draft, acceptance: e.target.value })} /></label>
          <div className="form two">
            <label>Priority<input type="number" value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: Number(e.target.value) })} /></label>
            <label>Size<select value={draft.size} onChange={(e) => setDraft({ ...draft, size: e.target.value })}><option>S</option><option>M</option><option>L</option></select></label>
            <label>Repo<input value={draft.repo} onChange={(e) => setDraft({ ...draft, repo: e.target.value })} /></label>
            <label>Deps (ids)<input value={draft.deps} onChange={(e) => setDraft({ ...draft, deps: e.target.value })} /></label>
          </div>
          <div className="row"><button className="pri" onClick={save}>Save</button></div>
        </div>
      ) : (
        <>
          <h3>Spec</h3>
          <pre>{ticket.spec || "(none)"}</pre>
          <h3>Acceptance criteria</h3>
          {ticket.acceptance.length ? <ul>{ticket.acceptance.map((a, i) => <li key={i}>{a}</li>)}</ul> : <div className="muted small">none</div>}
        </>
      )}
      {ticket.report && (<><h3>Implementer's report</h3><pre>{ticket.report}</pre></>)}
      {report && (<details><summary className="muted small">Worker reports in run {runId}</summary><pre>{report}</pre></details>)}
      <h3>Notes</h3>
      <ul className="notes small">
        {ticket.notes.map((n, i) => <li key={i}><span className="muted">{fmtTime(n.at)} {n.by}:</span> {n.text}</li>)}
        {ticket.notes.length === 0 && <li className="muted">none</li>}
      </ul>
      <div className="row">
        <input placeholder="add a note for the next worker" value={note} onChange={(e) => setNote(e.target.value)} />
        <button onClick={() => onAction("note", () => api("POST", `${base}/notes`, { text: note })).then(() => setNote(""))} disabled={!note.trim()}>Add</button>
      </div>
    </div>
  );
};

import { useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  copyText,
  fmtAgo,
  fmtDateTime,
  fmtDuration,
  fmtTime,
  fmtUsd,
  MODEL_CHOICES,
  STATE_LABEL,
  useLive,
  useNow,
  type AgentRequest,
  type Board,
  type Inbox,
  type Run,
  type Sandbox,
  type Session,
  type SessionDetail,
  type Ticket,
  type Totals,
  type VEvent,
} from "../api";

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

const REQUEST_LABELS: Record<string, { title: string; yes: string; no: string; tone: string }> = {
  network: { title: "Wants to reach a host", yes: "Allow host", no: "Deny", tone: "sig" },
  resources: { title: "Wants more resources", yes: "Apply", no: "Deny", tone: "sig" },
  root_command: { title: "Wants a command run as root", yes: "Run as root in the box", no: "Decline", tone: "warn" },
  ask: { title: "Needs something only you can do", yes: "Done, continue", no: "Decline", tone: "sig" },
  halt: { title: "Stopped itself", yes: "Acknowledge", no: "Dismiss", tone: "warn" },
};

const PAUSE_REASON: Record<string, string> = {
  user: "paused by you",
  rate_limit: "rate limited",
  workspace_size: "workspace over its size limit",
  requests: "waiting for your answer",
};

type Tone = "sig" | "good" | "warn" | "quiet" | "info";
/** One label and colour for the header pill from session state, run state and the live flag. */
const sessionStatus = (session: Session, run: Run | undefined, active: boolean): { label: string; tone: Tone } => {
  if (active) {
    if (session.state === "checking") return { label: "init check in progress", tone: "sig" };
    if (session.state === "planning") return { label: "planning", tone: "sig" };
    if (run?.state === "paused") return { label: `pausing · ${PAUSE_REASON[run.pauseReason ?? ""] ?? run.pauseReason ?? ""}`, tone: "sig" };
    return { label: run?.currentTicket ? `working on ${run.currentTicket}` : "running", tone: "sig" };
  }
  switch (session.state) {
    case "created":
      return { label: "not started", tone: "quiet" };
    case "finished":
      return { label: "finished", tone: "good" };
    case "halted":
      return { label: session.preflight && !session.preflight.ok ? "init check failed" : "halted by the agent", tone: "warn" };
    case "waiting":
      return { label: "waiting for you", tone: "warn" };
    case "paused":
      return { label: run?.pauseReason ? PAUSE_REASON[run.pauseReason] ?? `paused · ${run.pauseReason}` : "paused", tone: "sig" };
    default:
      return { label: session.state, tone: "quiet" };
  }
};

const sandboxLabel = (s: Sandbox | null): { text: string; tone: Tone } => {
  if (!s) return { text: "sandbox unknown", tone: "quiet" };
  if (s.container === "running") return { text: "sandbox running", tone: "good" };
  if (s.container === "stopped") return { text: "sandbox stopped", tone: "quiet" };
  return { text: "no sandbox yet", tone: "quiet" };
};

export const SessionPage = ({ id, ticketId }: { id: string; ticketId: string | null }) => {
  const [session, setSession] = useState<Session | null>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [run, setRun] = useState<Run | undefined>();
  const [runs, setRuns] = useState<Run[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [active, setActive] = useState(false);
  const [sandbox, setSandbox] = useState<Sandbox | null>(null);
  const [events, setEvents] = useState<VEvent[]>([]);
  const [eventsRun, setEventsRun] = useState<number | null>(null);
  /** null = follow the latest run; a number = read an earlier one. */
  const [pickedRun, setPickedRun] = useState<number | null>(null);
  const [err, setErr] = useState("");
  const [notice, setNotice] = useState("");
  const [importText, setImportText] = useState<string | null>(null);
  const [exportInfo, setExportInfo] = useState<string[] | null>(null);
  const [busy, setBusy] = useState("");
  const [logTicket, setLogTicket] = useState("");
  const [lastEventAt, setLastEventAt] = useState<string | null>(null);
  const now = useNow();

  const base = `/sessions/${encodeURIComponent(id)}`;
  const applyDetail = (d: SessionDetail) => {
    setSession(d.session);
    setBoard(d.board);
    setInbox(d.inbox);
    setRun(d.run);
    setRuns(d.runs);
    setTotals(d.totals);
    setActive(d.active);
    setSandbox(d.sandbox);
  };
  const loadEvents = async (runId: number | null) => {
    const q = runId ? `?run=${runId}&limit=1000` : "?limit=1000";
    const ev = await api<{ runId: number | null; events: VEvent[] }>("GET", `${base}/events${q}`);
    setEvents(ev.events.filter((e) => e.kind !== "cost"));
    setEventsRun(ev.runId);
    const last = ev.events[ev.events.length - 1];
    if (last) setLastEventAt(last.t);
  };
  const load = async () => {
    try {
      applyDetail(await api<SessionDetail>("GET", base));
      await loadEvents(pickedRun);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  useEffect(() => {
    setPickedRun(null);
    setLogTicket("");
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  useEffect(() => {
    void loadEvents(pickedRun).catch((e: Error) => setErr(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedRun]);

  const refreshRun = async () => {
    const d = await api<SessionDetail>("GET", base).catch(() => null);
    if (d) {
      applyDetail(d);
      // A new run started while we follow the latest: switch the log to it.
      if (pickedRun === null && d.run && eventsRun !== null && d.run.id !== eventsRun) void loadEvents(null);
    }
  };
  const live = useLive((m) => {
    if (m.sessionId !== id) return;
    if (m.type === "change") {
      if (m.board) setBoard(m.board);
      if (m.inbox) setInbox(m.inbox);
      if (m.session) setSession(m.session);
    } else if (m.type === "event") {
      if (m.event.kind === "cost") return;
      setLastEventAt(m.event.t);
      notifyFor(session?.name ?? id, m.event);
      if (pickedRun === null) {
        if (eventsRun !== null && m.runId !== eventsRun) {
          setEvents([m.event]);
          setEventsRun(m.runId);
        } else setEvents((ev) => [...ev.slice(-1999), m.event]);
      }
      if (m.event.kind === "run" || m.event.kind === "ticket" || m.event.kind === "worker_done") void refreshRun();
    }
  });

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setErr("");
    try {
      await fn();
      await refreshRun();
    } catch (e) {
      setErr((e as Error).message);
      throw e;
    } finally {
      setBusy("");
    }
  };
  const tryAct = (label: string, fn: () => Promise<unknown>) => act(label, fn).catch(() => undefined);
  const runAction = (action: string) => tryAct(action, () => api("POST", `${base}/run`, { action }));
  const doExport = () =>
    tryAct("exporting", async () => {
      const r = await api<{ howTo: string[] }>("POST", `${base}/export`);
      setExportInfo(r.howTo);
    });
  const doImport = () =>
    tryAct("importing", async () => {
      const r = await api<{ created: string[]; updated: string[]; skipped: { title: string; reason: string }[] }>("POST", `${base}/board/import`, { text: importText, state: "ready" });
      setImportText(null);
      const parts = [`Imported ${r.created.length} new`, r.updated.length ? `updated ${r.updated.length}` : ""].filter(Boolean).join(", ");
      setNotice(r.skipped.length ? `${parts}. Skipped: ${r.skipped.map((s) => `${s.title} (${s.reason})`).join("; ")}` : `${parts}.`);
    });
  const decide = (rid: string, decision: "approve" | "deny", answer: string) => tryAct(decision, () => api("POST", `${base}/requests/${rid}`, { decision, answer: answer || undefined }));
  const openTicket = (tid: string | null) => {
    location.hash = tid ? `#/s/${encodeURIComponent(id)}/t/${encodeURIComponent(tid)}` : `#/s/${encodeURIComponent(id)}`;
  };

  const ticket = useMemo(() => board?.tickets.find((t) => t.id === ticketId) ?? null, [board, ticketId]);
  if (err && !session) return <div className="banner warn">{err}</div>;
  if (!session || !board || !inbox) return <div className="loading">Loading session…</div>;

  const openRequests = inbox.requests.filter((r) => r.state === "open");
  const counts: Record<string, number> = {};
  for (const t of board.tickets) counts[t.state] = (counts[t.state] ?? 0) + 1;
  const done = counts.done ?? 0;
  const status = sessionStatus(session, run, active);
  const sb = sandboxLabel(sandbox);
  const lastActivity = lastEventAt && lastEventAt > (totals?.lastActivityAt ?? "") ? lastEventAt : totals?.lastActivityAt;
  const pausedBanner = !active && run && (run.state === "paused" || run.state === "halted" || run.state === "failed") && session.state !== "finished";

  return (
    <div className="stack" style={{ gap: 16 }}>
      <header className="sess-head">
        <div className="sess-title">
          <h1>{session.name}</h1>
          <span className={`pill ${status.tone}`}>{active ? <span className="dot run" /> : null}{status.label}</span>
          <div className="actions">
            {!active && <button className="pri" onClick={() => runAction("start")} disabled={Boolean(busy)} title="Work through the ready tickets">Start run</button>}
            {!active && <button onClick={() => runAction("plan")} disabled={Boolean(busy)} title="A planner worker reads the goal and adds tickets to the backlog">Plan tickets</button>}
            {active && <button onClick={() => runAction("pause")} disabled={Boolean(busy)} title="Finish the current ticket, then stop">Pause after ticket</button>}
            {active && <button className="warn" onClick={() => runAction("stop")} disabled={Boolean(busy)} title="Stop the worker now; its ticket goes back to ready">Stop now</button>}
            <MoreMenu
              items={[
                { label: "Import board…", onClick: () => setImportText("") },
                { label: "Export board (JSON)", href: `/api${base}/board/export` },
                { label: active ? "Export bundles (stop the run first)" : "Export bundles…", onClick: doExport, disabled: active },
              ]}
            />
          </div>
        </div>
        <div className="facts">
          <span><b>{done}/{board.tickets.length}</b> done</span>
          <span><b>{fmtUsd(totals?.usd ?? 0)}</b> spent{totals && totals.runs > 1 ? ` over ${totals.runs} runs` : ""}{active && run?.cost.usd ? ` · ${fmtUsd(run.cost.usd)} this run` : ""}</span>
          {run && active && <span>running for <b>{fmtDuration(run.startedAt, undefined, now)}</b></span>}
          {lastActivity && !active && <span>last activity <b title={fmtDateTime(lastActivity)}>{fmtAgo(lastActivity, now)}</b></span>}
          <span>created <b title={fmtDateTime(session.createdAt)}>{fmtAgo(session.createdAt, now)}</b></span>
          <span className={sb.tone === "good" ? "ok" : ""}>{sb.text}</span>
          <span>{session.repos.length ? <>repos <span className="mono">{session.repos.map((r) => r.name).join(", ")}</span></> : "no repositories"}</span>
          <ModelPicker session={session} onChange={(model) => tryAct("model", () => api("PUT", `${base}/caps`, { model }))} />
          <NotifyToggle />
          <span className={live ? "" : "err"} title={live ? "Live updates connected" : "Reconnecting to the host app"}><span className={`dot ${live ? "good" : "bad"}`} /> {live ? "live" : "reconnecting…"}</span>
        </div>
        <Goal text={session.goal} />
        {board.tickets.length > 0 && <ProgressStrip counts={counts} total={board.tickets.length} />}
      </header>

      {pausedBanner && run && (
        <div className={`banner ${run.state === "paused" ? "signal" : "warn"}`}>
          <strong>Run {run.id} {run.state}</strong>
          <span>{run.pauseReason ? PAUSE_REASON[run.pauseReason] ?? run.pauseReason : ""}{run.resumeAt ? ` · resumes ${fmtAgo(run.resumeAt, now).replace(" ago", "")} (${fmtDateTime(run.resumeAt)})` : ""}</span>
          {run.endedAt && <span className="muted">ended {fmtAgo(run.endedAt, now)}</span>}
          <button className="pri sm end" onClick={() => runAction("start")} disabled={Boolean(busy)}>Resume</button>
        </div>
      )}
      {err && <div className="banner warn"><span>{err}</span><button className="quiet sm end" onClick={() => setErr("")}>Dismiss</button></div>}
      {notice && <div className="banner good"><span>{notice}</span><button className="quiet sm end" onClick={() => setNotice("")}>Dismiss</button></div>}
      {busy && <div className="muted small">{busy}…</div>}

      {openRequests.length > 0 && (
        <section className="card attention">
          <h3>Needs you · {openRequests.length} request{openRequests.length === 1 ? "" : "s"}</h3>
          <p className="lead">The worker parked its ticket until you answer. Nothing else moves while a request is open.</p>
          <div className="attention-grid">
            {openRequests.map((r) => <RequestItem key={r.id} r={r} onDecide={decide} onOpenTicket={openTicket} />)}
          </div>
        </section>
      )}

      {exportInfo && (
        <section className="card stack tight">
          <div className="row"><h3>Take the work back</h3><button className="quiet sm end" onClick={() => setExportInfo(null)}>Close</button></div>
          <p className="muted small">Bundles are pure data; fetching from them runs nothing from the repository. One command per repository:</p>
          {exportInfo.map((l) => <CopyLine key={l} text={l} />)}
        </section>
      )}

      {importText !== null && (
        <section className="card stack tight">
          <div className="row"><h3>Import board</h3><span className="muted small">JSON or markdown, see docs/BOARD.md. New tickets start as ready; known ids are updated.</span><button className="quiet sm end" onClick={() => setImportText(null)}>Cancel</button></div>
          <textarea id="import" className="mono" value={importText} onChange={(e) => setImportText(e.target.value)} style={{ minHeight: 200 }} placeholder={'{ "tickets": [ { "title": "…", "spec": "…", "acceptance": ["…"] } ] }'} />
          <div className="row"><button className="pri end" onClick={doImport} disabled={!importText.trim() || Boolean(busy)}>Import</button></div>
        </section>
      )}

      <div className="sess-body">
        <div className="main">
          {board.tickets.length === 0 ? (
            <div className="card empty-state">
              <h3>No tickets yet</h3>
              <p>Paste a board, or let the planner draft tickets from the goal.</p>
              <div className="row">
                <button onClick={() => setImportText("")}>Import board…</button>
                <button className="pri" onClick={() => runAction("plan")} disabled={active || Boolean(busy)}>Plan tickets</button>
              </div>
            </div>
          ) : (
            <BoardView board={board} inbox={inbox} run={run} active={active} openId={ticketId} onOpen={openTicket} onRetry={(tid) => tryAct("retrying", () => api("POST", `${base}/tickets/${tid}/state`, { state: "ready" }))} onShowLog={setLogTicket} />
          )}
          <LogPanel
            events={events}
            runs={runs}
            liveRun={active ? run : undefined}
            shownRun={eventsRun}
            picked={pickedRun}
            onPick={setPickedRun}
            ticket={logTicket}
            onTicket={setLogTicket}
            tickets={board.tickets.map((t) => t.id)}
          />
        </div>
        <aside className="side">
          <SetupPanel session={session} base={base} active={active} onDone={refreshRun} />
          <InboxPanel inbox={inbox} onRead={(mid) => tryAct("read", () => api("POST", `${base}/messages/${mid}/read`))} onPromote={(iid) => tryAct("promote", () => api("POST", `${base}/ideas/${iid}/promote`))} onOpenTicket={openTicket} />
          <SessionSettings
            session={session}
            onSave={async (patch) => {
              if (patch.allowlist) await api("PUT", `${base}/allowlist`, { allowlist: patch.allowlist });
              if (patch.caps || patch.limits) await api("PUT", `${base}/caps`, { caps: patch.caps, limits: patch.limits });
              await refreshRun();
            }}
          />
        </aside>
      </div>

      {ticketId && !ticket && <div className="banner warn"><span>No ticket {ticketId} on this board.</span><button className="quiet sm end" onClick={() => openTicket(null)}>Close</button></div>}
      {ticket && (
        <TicketDrawer
          ticket={ticket}
          board={board}
          held={active && run?.currentTicket === ticket.id}
          sessionId={id}
          onClose={() => openTicket(null)}
          onOpen={openTicket}
          onAction={act}
          onShowLog={() => {
            setLogTicket(ticket.id);
            openTicket(null);
          }}
        />
      )}
    </div>
  );
};

// --- setup and init check -------------------------------------------------------

const SetupPanel = ({ session, base, active, onDone }: { session: Session; base: string; active: boolean; onDone: () => Promise<void> }) => {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [openLog, setOpenLog] = useState<string | null>(null);
  const [logs, setLogs] = useState<Record<string, string>>({});
  if (!session.setupScripts.length && !session.caps.preflight && !session.preflight) return null;
  const rerun = async () => {
    setBusy(true);
    setMsg("");
    try {
      await api("POST", `${base}/setup/rerun`);
      setMsg("Setup scripts ran again.");
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
      await onDone();
    }
  };
  const showLog = async (name: string) => {
    if (openLog === name) return setOpenLog(null);
    const r = await api<{ logs: Record<string, string> }>("GET", `${base}/setup`);
    setLogs(r.logs);
    setOpenLog(name);
  };
  const resetPreflight = async () => {
    await api("POST", `${base}/preflight/reset`);
    await onDone();
  };
  const copyContext = async () => {
    const md = await fetch(`/api/context?tail=free&session=${encodeURIComponent(session.id)}`).then((r) => r.text());
    await copyText(md);
    setMsg("Session context copied for an assistant.");
  };
  return (
    <section className="card stack" style={{ gap: 8 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h3>Setup</h3>
        <button className="quiet sm" onClick={copyContext} title="Markdown describing this box and session, to paste into any assistant">Copy context for an LLM</button>
      </div>
      {session.setupScripts.map((sc) => {
        const r = session.setup.find((x) => x.name === sc.name);
        return (
          <div key={sc.name} className="small">
            <span className={`dot ${!r ? "" : r.ok ? "good" : "bad"}`} /> <strong>{sc.name}</strong>{" "}
            <span className="muted">{!r ? "not run yet (runs when the container is created)" : r.ok ? `ok · ${fmtAgo(r.at)}` : `failed, exit ${r.code} · ${fmtAgo(r.at)}`}</span>{" "}
            {r && <button className="quiet sm" onClick={() => showLog(sc.name)}>{openLog === sc.name ? "hide log" : "log"}</button>}
            {openLog === sc.name && <pre className="mono" style={{ whiteSpace: "pre-wrap", maxHeight: 240, overflow: "auto", marginTop: 6 }}>{logs[sc.name] || r?.tail || "(empty)"}</pre>}
          </div>
        );
      })}
      {session.setupScripts.length > 0 && (
        <div className="row">
          <button className="sm" onClick={rerun} disabled={busy || active} title={active ? "Pause or stop the run first" : "Run every setup script again as root"}>Re-run setup</button>
          <span className="muted small">{msg}</span>
        </div>
      )}
      {(session.caps.preflight || session.preflight) && (
        <div className="small" style={{ borderTop: "1px solid var(--line)", paddingTop: 8 }}>
          <span className={`dot ${!session.preflight ? "" : session.preflight.ok ? "good" : "bad"}`} /> <strong>Init check</strong>{" "}
          <span className="muted">{!session.caps.preflight ? "off" : !session.preflight ? "runs at the start of the next run" : session.preflight.ok ? `passed · ${fmtAgo(session.preflight.at)}` : `not passed · ${fmtAgo(session.preflight.at)}`}</span>
          {session.preflight && <div className="muted" style={{ marginTop: 4, whiteSpace: "pre-wrap" }}>{session.preflight.summary}</div>}
          {session.preflight?.ok && <button className="quiet sm" style={{ marginTop: 4 }} onClick={resetPreflight} disabled={active}>Check again on the next run</button>}
        </div>
      )}
    </section>
  );
};

// --- header pieces ---------------------------------------------------------

const NOTIFY_KEY = "verstas.notify";
const notifyOn = (): boolean => {
  try {
    return localStorage.getItem(NOTIFY_KEY) === "1" && "Notification" in window && Notification.permission === "granted";
  } catch {
    return false;
  }
};
/** A desktop notification when the agent needs you or a run stops; only when the person opted in. */
const notifyFor = (sessionName: string, e: VEvent) => {
  if (!notifyOn()) return;
  let body = "";
  if (e.kind === "request") body = `Needs you: ${String(e.summary)}`;
  else if (e.kind === "run" && ["paused", "finished", "halted", "failed"].includes(String(e.state))) body = `Run ${String(e.state)}${e.reason ? `: ${String(e.reason)}` : ""}`;
  else if (e.kind === "denied_network") body = `Proxy denied ${String(e.host)}`;
  if (!body) return;
  try {
    new Notification(sessionName, { body, tag: `${sessionName}:${e.kind}` });
  } catch {
    // ignore
  }
};

const NotifyToggle = () => {
  const [on, setOn] = useState(notifyOn());
  const supported = "Notification" in window;
  if (!supported) return null;
  const toggle = async () => {
    if (on) {
      try {
        localStorage.setItem(NOTIFY_KEY, "0");
      } catch {
        // ignore
      }
      setOn(false);
      return;
    }
    const perm = await Notification.requestPermission();
    if (perm === "granted") {
      try {
        localStorage.setItem(NOTIFY_KEY, "1");
      } catch {
        // ignore
      }
      setOn(true);
    }
  };
  return (
    <button className={`chip ${on ? "on" : ""}`} onClick={toggle} title={on ? "Desktop notifications on: requests, pauses, finishes. Click to turn off." : "Notify me on this desktop when the agent needs me or a run stops"} aria-pressed={on}>
      {on ? "🔔 notifying" : "🔕 notify me"}
    </button>
  );
};

const Goal = ({ text }: { text: string }) => {
  const [open, setOpen] = useState(false);
  const long = text.length > 220;
  if (!text) return <p className="goal muted">No goal written. The planner needs one; a pasted board does not.</p>;
  return (
    <p className={`goal clamp ${open ? "open" : ""}`}>
      <b>Goal</b>
      {text}
      {long && <button className="quiet sm" onClick={() => setOpen(!open)}>{open ? "less" : "more"}</button>}
    </p>
  );
};

const ORDER = ["done", "review", "in_progress", "waiting", "blocked", "ready", "backlog"];
const ProgressStrip = ({ counts, total }: { counts: Record<string, number>; total: number }) => (
  <div className="stack" style={{ gap: 5 }}>
    <div className="progress" role="img" aria-label={ORDER.filter((k) => counts[k]).map((k) => `${counts[k]} ${STATE_LABEL[k]}`).join(", ")}>
      {ORDER.filter((k) => counts[k]).map((k) => <span key={k} className={k} style={{ width: `${((counts[k] ?? 0) / total) * 100}%` }} title={`${counts[k]} ${STATE_LABEL[k]}`} />)}
    </div>
    <div className="legend">{ORDER.filter((k) => counts[k]).map((k) => <span key={k} className={k}>{counts[k]} {STATE_LABEL[k]?.toLowerCase()}</span>)}</div>
  </div>
);

const ModelPicker = ({ session, onChange }: { session: Session; onChange: (model: string | null) => void }) => {
  const [custom, setCustom] = useState<string | null>(null);
  const current = session.model ?? "";
  const known = !current || MODEL_CHOICES.includes(current);
  if (custom !== null) {
    return (
      <label title="Any model id or alias claude --model accepts">
        <span>model</span>
        <input
          autoFocus
          className="mono"
          style={{ width: 200 }}
          value={custom}
          placeholder="model id or alias"
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              onChange(custom.trim() || null);
              setCustom(null);
            }
            if (e.key === "Escape") setCustom(null);
          }}
        />
        <button className="sm" onClick={() => { onChange(custom.trim() || null); setCustom(null); }}>Set</button>
        <button className="quiet sm" onClick={() => setCustom(null)}>Cancel</button>
      </label>
    );
  }
  return (
    <label title="Applies to the next worker that starts; a running worker keeps its model">
      <span>model</span>
      <select
        id="model-select"
        value={known ? current : "__custom"}
        onChange={(e) => {
          if (e.target.value === "__custom") setCustom(current);
          else onChange(e.target.value || null);
        }}
      >
        <option value="">token default</option>
        {MODEL_CHOICES.map((m) => <option key={m} value={m}>{m}</option>)}
        {known ? <option value="__custom">other…</option> : <option value="__custom">{current} (other…)</option>}
      </select>
    </label>
  );
};

const MoreMenu = ({ items }: { items: { label: string; onClick?: () => void; href?: string; disabled?: boolean }[] }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const on = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    addEventListener("mousedown", on);
    addEventListener("keydown", key);
    return () => {
      removeEventListener("mousedown", on);
      removeEventListener("keydown", key);
    };
  }, [open]);
  return (
    <div className="menu" ref={ref}>
      <button onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open}>More ▾</button>
      {open && (
        <div className="items" role="menu">
          {items.map((it) =>
            it.href ? (
              <a key={it.label} href={it.href} target="_blank" rel="noreferrer" role="menuitem" onClick={() => setOpen(false)}>{it.label}</a>
            ) : (
              <button key={it.label} role="menuitem" disabled={it.disabled} onClick={() => { setOpen(false); it.onClick?.(); }}>{it.label}</button>
            ),
          )}
        </div>
      )}
    </div>
  );
};

const CopyLine = ({ text }: { text: string }) => {
  const [done, setDone] = useState(false);
  return (
    <div className="row">
      <pre className="mono grow" style={{ background: "var(--panel-2)", padding: "8px 10px", borderRadius: 6, border: "1px solid var(--line)" }}>{text}</pre>
      <button className="sm" onClick={() => navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); })}>{done ? "Copied" : "Copy"}</button>
    </div>
  );
};

/** A button that asks once, inline, before doing something destructive. */
const ConfirmButton = ({ label, confirm, onConfirm, disabled, className }: { label: string; confirm: string; onConfirm: () => void; disabled?: boolean; className?: string }) => {
  const [arm, setArm] = useState(false);
  useEffect(() => {
    if (!arm) return;
    const t = setTimeout(() => setArm(false), 6000);
    return () => clearTimeout(t);
  }, [arm]);
  if (!arm) return <button className={className ?? "warn"} onClick={() => setArm(true)} disabled={disabled}>{label}</button>;
  return (
    <span className="confirm">
      <button className="warn solid" onClick={() => { setArm(false); onConfirm(); }}>{confirm}</button>
      <button className="quiet" onClick={() => setArm(false)}>Cancel</button>
    </span>
  );
};

// --- requests ---------------------------------------------------------------

const RequestItem = ({ r, onDecide, onOpenTicket }: { r: AgentRequest; onDecide: (rid: string, d: "approve" | "deny", answer: string) => void; onOpenTicket: (tid: string) => void }) => {
  const [answer, setAnswer] = useState("");
  const d = r.detail;
  const l = REQUEST_LABELS[d.kind] ?? { title: d.kind, yes: "Approve", no: "Deny", tone: "sig" };
  return (
    <div className="req">
      <div className="head">
        <span className={`pill ${l.tone}`}>{d.kind.replace("_", " ")}</span>
        <strong style={{ color: "var(--text)" }}>{l.title}</strong>
        {r.ticketId && <a href="#" onClick={(e) => { e.preventDefault(); onOpenTicket(r.ticketId!); }} className="mono">{r.ticketId}</a>}
        <span title={fmtDateTime(r.createdAt)}>{fmtTime(r.createdAt)}</span>
      </div>
      {d.kind === "root_command" && (
        <>
          <pre className="mono">{String(d.command)}</pre>
          <div className="muted small">Runs as root inside the session container{d.cwd ? ` in ${String(d.cwd)}` : ""}. Read it first; the output tail goes back to the worker.</div>
        </>
      )}
      {d.kind === "ask" && (
        <div className="kv">
          <div><b>Needs</b>{String(d.what)}</div>
          {d.how ? <div><b>Please</b>{String(d.how)}</div> : null}
          {d.verify ? <div className="muted"><b>Will verify by</b>{String(d.verify)}</div> : null}
        </div>
      )}
      {d.kind === "network" && <div className="mono">allow {String(d.host)}{d.port ? `:${String(d.port)}` : ""} (HTTPS)</div>}
      {d.kind === "resources" && <div className="mono small">{["workerMinutes", "workerTurns", "memoryMb"].filter((k) => d[k] !== undefined).map((k) => `${k}: ${String(d[k])}`).join(" · ")}</div>}
      {d.kind === "halt" && <div className="err">{String(d.severity)}: {String(d.reason)}</div>}
      <div className="why">{r.why}</div>
      <textarea placeholder={d.kind === "ask" ? "What you did: paths, decisions, anything the worker needs to continue" : "Note for the worker (optional)"} value={answer} onChange={(e) => setAnswer(e.target.value)} style={{ minHeight: d.kind === "ask" ? 70 : 38 }} />
      <div className="row">
        <button className={l.tone === "warn" ? "warn" : "pri"} onClick={() => onDecide(r.id, "approve", answer)}>{l.yes}</button>
        <button onClick={() => onDecide(r.id, "deny", answer)}>{l.no}</button>
      </div>
    </div>
  );
};

// --- board ------------------------------------------------------------------

const BoardView = ({ board, inbox, run, active, openId, onOpen, onRetry, onShowLog }: { board: Board; inbox: Inbox; run?: Run; active: boolean; openId: string | null; onOpen: (tid: string) => void; onRetry: (tid: string) => void; onShowLog: (tid: string) => void }) => {
  const doneIds = new Set(board.tickets.filter((t) => t.state === "done").map((t) => t.id));
  return (
    <div className="board-wrap">
      <div className="board">
        {COLUMNS.map((c) => {
          const items = board.tickets.filter((t) => c.states.includes(t.state)).sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id, undefined, { numeric: true }));
          const hot = c.key === "in_progress" && items.length > 0 && active;
          const attn = c.key === "waiting" && items.length > 0;
          return (
            <div className={`col ${hot ? "hot" : ""} ${attn ? "attn" : ""}`} key={c.key}>
              <div className="h"><span>{c.title}</span><span className="n">{items.length}</span></div>
              <div className="items">
                {items.length === 0 && <div className="empty">—</div>}
                {items.map((t) => (
                  <TicketCard key={t.id} t={t} doneIds={doneIds} request={t.state === "waiting" ? inbox.requests.find((r) => r.ticketId === t.id && r.state === "open") : undefined} active={Boolean(active && run?.currentTicket === t.id)} open={openId === t.id} onOpen={() => onOpen(t.id)} onRetry={() => onRetry(t.id)} onShowLog={() => onShowLog(t.id)} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

const TicketCard = ({ t, doneIds, request, active, open, onOpen, onRetry, onShowLog }: { t: Ticket; doneIds: Set<string>; request?: AgentRequest; active: boolean; open: boolean; onOpen: () => void; onRetry: () => void; onShowLog: () => void }) => {
  const depsDone = t.deps.filter((d) => doneIds.has(d)).length;
  const depsOk = depsDone === t.deps.length;
  const lastNote = t.notes[t.notes.length - 1];
  return (
    <button className={`tk ${t.state} ${active ? "active" : ""} ${open ? "open" : ""}`} onClick={onOpen} aria-label={`${t.id} ${t.title}`}>
      <div className="id">
        <span>{t.id}</span>
        <span className="k">{t.kind}</span>
        <span className="k">{t.size}</span>
        {t.priority <= 2 && <span className="k" title={`priority ${t.priority}`}>p{t.priority}</span>}
        {t.pinned && <span className="pin" title="Pinned: the agent may not reprioritise it">⚲</span>}
      </div>
      <div className="title">{t.title}</div>
      {(t.deps.length > 0 || t.attempts > 0 || t.diff || active) && (
        <div className="meta">
          {active && <span className="pill sig">working</span>}
          {t.deps.length > 0 && <span className={`pill ${depsOk ? "quiet" : t.state === "ready" ? "sig" : "quiet"}`} title={`Depends on ${t.deps.join(", ")}`}>deps {depsDone}/{t.deps.length}</span>}
          {t.attempts > 1 && <span className="pill quiet">attempt {t.attempts}</span>}
          {t.diff && <span className="pill quiet mono">+{t.diff.added} −{t.diff.removed}</span>}
        </div>
      )}
      {t.state === "waiting" && <div className="why">Waiting for you: {request ? REQUEST_LABELS[request.detail.kind]?.title.toLowerCase() ?? request.detail.kind : "an answer"}</div>}
      {t.state === "blocked" && lastNote && <div className="why warn">{lastNote.text.slice(0, 160)}{lastNote.text.length > 160 ? "…" : ""}</div>}
      {t.state === "blocked" && (
        <div className="act" onClick={(e) => e.stopPropagation()}>
          <button className="sm" onClick={onRetry}>Retry</button>
          <button className="quiet sm" onClick={onShowLog}>Log</button>
        </div>
      )}
    </button>
  );
};

// --- log --------------------------------------------------------------------

type KindGroup = "tools" | "text" | "board" | "network";
const KIND_GROUP: Record<string, KindGroup> = {
  tool_use: "tools",
  tool_result: "tools",
  text: "text",
  status: "board",
  gate: "board",
  ticket: "board",
  run: "board",
  worker_done: "board",
  request: "board",
  error: "board",
  denied_network: "network",
};
const GROUPS: { key: KindGroup; label: string }[] = [
  { key: "tools", label: "Tool calls" },
  { key: "text", label: "Worker text" },
  { key: "board", label: "Board & run" },
  { key: "network", label: "Network" },
];

type Row = { e: VEvent };

const LogPanel = ({ events, runs, liveRun, shownRun, picked, onPick, ticket, onTicket, tickets }: { events: VEvent[]; runs: Run[]; liveRun?: Run; shownRun: number | null; picked: number | null; onPick: (r: number | null) => void; ticket: string; onTicket: (t: string) => void; tickets: string[] }) => {
  const [groups, setGroups] = useState<Set<KindGroup>>(new Set(["tools", "text", "board", "network"]));
  const [follow, setFollow] = useState(true);
  const bodyRef = useRef<HTMLDivElement>(null);
  const now = useNow();

  const rows = useMemo(() => {
    const out: Row[] = [];
    const filtered = events.filter((e) => (!ticket || e.ticket === ticket || (!e.ticket && e.kind === "run")) && groups.has(KIND_GROUP[e.kind] ?? "board"));
    for (const e of filtered) {
      // Results carry the call id, not the tool name, and parallel calls return out of order,
      // so they stay separate rows; an empty, successful one says nothing and is dropped.
      if (e.kind === "tool_result" && e.ok && !String(e.summary ?? "").trim()) continue;
      out.push({ e });
    }
    return out;
  }, [events, ticket, groups]);

  const ticketsSeen = useMemo(() => {
    const s = new Set<string>();
    for (const e of events) if (e.ticket) s.add(e.ticket);
    return tickets.filter((t) => s.has(t));
  }, [events, tickets]);

  useEffect(() => {
    if (follow && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [rows.length, follow]);
  const onScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (atBottom !== follow) setFollow(atBottom);
  };
  const toggle = (g: KindGroup) => {
    const next = new Set(groups);
    if (next.has(g)) next.delete(g);
    else next.add(g);
    setGroups(next);
  };

  const shown = runs.find((r) => r.id === shownRun) ?? (liveRun?.id === shownRun ? liveRun : undefined);
  return (
    <section className="log" aria-label="Live log">
      <div className="bar">
        <strong style={{ color: "var(--text)" }}>Log</strong>
        <select value={picked ?? ""} onChange={(e) => onPick(e.target.value ? Number(e.target.value) : null)} title="Which run to read">
          <option value="">{liveRun ? `run ${liveRun.id} (live)` : runs.length ? `run ${runs[runs.length - 1]!.id} (latest)` : "no runs yet"}</option>
          {[...runs].reverse().filter((r) => r.id !== (liveRun?.id ?? runs[runs.length - 1]?.id)).map((r) => (
            <option key={r.id} value={r.id}>run {r.id} · {r.state} · {fmtDuration(r.startedAt, r.endedAt, now)} · {fmtUsd(r.cost.usd ?? 0)}</option>
          ))}
        </select>
        {shown && <span title={`${fmtDateTime(shown.startedAt)}${shown.endedAt ? ` → ${fmtDateTime(shown.endedAt)}` : ""}`}>{shown.state}{shown.state !== "running" && shown.endedAt ? ` ${fmtAgo(shown.endedAt, now)}` : ""} · {fmtDuration(shown.startedAt, shown.endedAt, now)} · {shown.ticketsDone} done · {fmtUsd(shown.cost.usd ?? 0)}</span>}
        <select value={ticket} onChange={(e) => onTicket(e.target.value)} title="Only this ticket's events">
          <option value="">all tickets</option>
          {ticketsSeen.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <div className="chips">
          {GROUPS.map((g) => <button key={g.key} className={`chip ${groups.has(g.key) ? "on" : ""}`} onClick={() => toggle(g.key)} aria-pressed={groups.has(g.key)}>{g.label}</button>)}
        </div>
        <span className="end">{rows.length} of {events.length} events</span>
      </div>
      <div className="body" ref={bodyRef} onScroll={onScroll}>
        {rows.map((r, i) => <EventRow key={i} row={r} onTicket={onTicket} />)}
        {rows.length === 0 && <div className="none">{events.length === 0 ? "Nothing logged yet. Start a run and the workers' steps appear here." : "No events match the filters."}</div>}
        {!follow && rows.length > 0 && <button className="jump sm" onClick={() => { setFollow(true); if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight; }}>↓ Latest</button>}
      </div>
    </section>
  );
};

const fmtSecs = (s: number): string => (s < 90 ? `${s} s` : `${Math.round(s / 60)} min`);

const evClass = (e: VEvent): string => {
  if (e.kind === "gate") return `gate ${e.ok ? "ok" : "fail"}`;
  if (e.kind === "tool_result") return e.ok ? "tool" : "fail";
  if (e.kind === "tool_use") return "tool";
  if (e.kind === "worker_done") return e.ok ? "ok" : "fail";
  return e.kind;
};

const EventRow = ({ row, onTicket }: { row: Row; onTicket: (t: string) => void }) => {
  const { e } = row;
  return (
    <div className={`ev ${evClass(e)}`}>
      <span className="t" title={fmtDateTime(e.t)}>{fmtTime(e.t)}</span>
      <span className="tid" onClick={() => e.ticket && onTicket(e.ticket)} title={e.ticket ? `Only ${e.ticket}` : ""}>{e.ticket ?? ""}</span>
      <span className="m"><EventText e={e} /></span>
    </div>
  );
};

const EventText = ({ e }: { e: VEvent }) => {
  const [open, setOpen] = useState(false);
  switch (e.kind) {
    case "text": {
      const text = String(e.text ?? "");
      const long = text.length > 400;
      return (
        <>
          {e.role ? <span className="role">[{String(e.role)}] </span> : null}
          {long && !open ? `${text.slice(0, 400).trimEnd()}…` : text}
          {long && <button className="more" onClick={() => setOpen(!open)}>{open ? "less" : "more"}</button>}
        </>
      );
    }
    case "tool_use":
      return <><b>{String(e.tool).replace(/^mcp__board__/, "board:")}</b> {String(e.summary)}</>;
    case "tool_result": {
      const res = String(e.summary ?? "").trim();
      const long = res.length > 240;
      return (
        <span className={`res ${e.ok ? "" : "bad"}`}>
          → {res ? (long && !open ? `${res.slice(0, 240).trimEnd()}…` : res) : "failed"}
          {long && <button className="more" onClick={() => setOpen(!open)}>{open ? "less" : "more"}</button>}
        </span>
      );
    }
    case "gate":
      return <>gate {String(e.name)}: {e.ok ? "ok" : "FAILED"} {String(e.summary)}</>;
    case "ticket":
      return <>{String(e.ticket)} {STATE_LABEL[String(e.from)] ?? String(e.from)} → {STATE_LABEL[String(e.to)] ?? String(e.to)}{e.note ? ` · ${String(e.note)}` : ""}</>;
    case "run":
      return <>run {String(e.state)}{e.reason ? ` · ${String(e.reason)}` : ""}</>;
    case "denied_network":
      return <>proxy denied {String(e.host)}:{String(e.port)}</>;
    case "request":
      return <>request {String(e.requestId)} · {String(e.summary)}</>;
    case "worker_done":
      return <>{String(e.role)} {e.ok ? "finished" : "stopped"} · {String(e.stopReason)} · {String(e.turns)} turns · {fmtSecs(Number(e.seconds))} · {fmtUsd(Number(e.costUsd))}</>;
    case "cost":
      return null;
    default:
      return <>{String(e.text ?? e.summary ?? JSON.stringify(e))}</>;
  }
};

// --- inbox -----------------------------------------------------------------

const InboxPanel = ({ inbox, onRead, onPromote, onOpenTicket }: { inbox: Inbox; onRead: (mid: string) => void; onPromote: (iid: string) => void; onOpenTicket: (tid: string) => void }) => {
  const unread = inbox.messages.filter((m) => !m.read);
  const ideas = inbox.ideas.filter((i) => !i.promotedTo);
  const decided = inbox.requests.filter((r) => r.state !== "open").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const total = unread.length + ideas.length;
  return (
    <section className="card">
      <h3>Inbox{total ? ` · ${total}` : ""}</h3>
      {total === 0 && <p className="lead" style={{ marginBottom: 0 }}>No messages or ideas from the workers.</p>}
      {unread.map((m) => (
        <div className="req" key={m.id}>
          <div className="head"><span className="pill info">message</span>{m.ticketId && <a href="#" className="mono" onClick={(e) => { e.preventDefault(); onOpenTicket(m.ticketId!); }}>{m.ticketId}</a>}<span title={fmtDateTime(m.createdAt)}>{fmtAgo(m.createdAt)}</span></div>
          <div className="wrap" style={{ fontSize: 13 }}>{m.text}</div>
          <div><button className="sm" onClick={() => onRead(m.id)}>Mark read</button></div>
        </div>
      ))}
      {ideas.map((i) => (
        <div className="req" key={i.id}>
          <div className="head"><span className="pill acc">idea</span>{i.ticketId && <span>from <a href="#" className="mono" onClick={(e) => { e.preventDefault(); onOpenTicket(i.ticketId!); }}>{i.ticketId}</a></span>}</div>
          <strong className="wrap" style={{ fontSize: 13 }}>{i.title}</strong>
          <div className="wrap muted" style={{ fontSize: 12.5 }}>{i.pitch}</div>
          <div><button className="sm" onClick={() => onPromote(i.id)}>Turn into a ticket</button></div>
        </div>
      ))}
      {decided.length > 0 && (
        <details style={{ marginTop: 8 }}>
          <summary className="muted small">{decided.length} decided request{decided.length === 1 ? "" : "s"}</summary>
          <div className="decided">
            {decided.map((r) => (
              <div key={r.id}>
                <span className={`pill ${r.state === "approved" ? "good" : "quiet"}`}>{r.state}</span>
                <span>{r.detail.kind.replace("_", " ")}</span>
                {r.ticketId && <a href="#" className="mono" onClick={(e) => { e.preventDefault(); onOpenTicket(r.ticketId!); }}>{r.ticketId}</a>}
                <span className="faint" title={fmtDateTime(r.createdAt)}>{fmtAgo(r.createdAt)}</span>
                <span className="wrap" style={{ flexBasis: "100%", color: "var(--text-2)" }}>{requestSummary(r)}{r.answer ? <span className="faint"> · {r.answer.split("\n")[0]}</span> : null}</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </section>
  );
};

const requestSummary = (r: AgentRequest): string => {
  const d = r.detail;
  switch (d.kind) {
    case "network":
      return `allow ${String(d.host)}${d.port ? `:${String(d.port)}` : ""}`;
    case "root_command":
      return String(d.command).split("\n")[0]!.slice(0, 90);
    case "ask":
      return String(d.what).slice(0, 120);
    case "halt":
      return `${String(d.severity)}: ${String(d.reason)}`.slice(0, 120);
    default:
      return r.why.slice(0, 120);
  }
};

// --- settings --------------------------------------------------------------

type SettingsPatch = { allowlist?: string[]; caps?: Partial<Session["caps"]>; limits?: Partial<Session["limits"]> };
const CAP_HELP: Record<string, string> = {
  workerMinutes: "Wall-clock cap for one worker",
  workerTurns: "Model turns per worker",
  budgetUsd: "Spend cap per worker",
  runTickets: "Tickets per run before it pauses",
  ticketAttempts: "Tries before a ticket is blocked",
};

const SessionSettings = ({ session, onSave }: { session: Session; onSave: (patch: SettingsPatch) => Promise<void> }) => {
  const fromSession = () => ({
    allow: session.allowlist.join("\n"),
    workerMinutes: String(session.caps.workerMinutes),
    workerTurns: String(session.caps.workerTurns),
    budgetUsd: String(session.caps.budgetUsd),
    runTickets: String(session.caps.runTickets),
    ticketAttempts: String(session.caps.ticketAttempts),
    reviewer: session.caps.reviewer,
    memory: session.limits.memory,
    cpus: String(session.limits.cpus),
  });
  const [f, setF] = useState(fromSession);
  const [state, setState] = useState<"clean" | "dirty" | "saving" | "saved" | "error">("clean");
  const [msg, setMsg] = useState("");
  useEffect(() => {
    setF(fromSession());
    setState("clean");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.allowlist, session.caps, session.limits]);
  const set = <K extends keyof ReturnType<typeof fromSession>>(k: K, v: ReturnType<typeof fromSession>[K]) => {
    setF({ ...f, [k]: v });
    setState("dirty");
  };
  const save = async () => {
    setState("saving");
    try {
      await onSave({
        allowlist: f.allow.split(/\n/).map((s) => s.trim()).filter(Boolean),
        caps: { workerMinutes: Number(f.workerMinutes), workerTurns: Number(f.workerTurns), budgetUsd: Number(f.budgetUsd), runTickets: Number(f.runTickets), ticketAttempts: Number(f.ticketAttempts), reviewer: f.reviewer },
        limits: { memory: f.memory, cpus: Number(f.cpus) },
      });
      setState("saved");
      setMsg("");
    } catch (e) {
      setState("error");
      setMsg((e as Error).message);
    }
  };
  return (
    <details className="card">
      <summary><strong>Session settings</strong><span className="muted small">allowlist, caps, limits</span></summary>
      <div className="stack" style={{ marginTop: 12 }}>
        <label>
          Network allowlist <span className="help">One host per line, HTTPS only; *.suffix allowed. Applies live.</span>
          <textarea id="allow" className="mono" value={f.allow} onChange={(e) => set("allow", e.target.value)} />
        </label>
        <div className="two">
          {(["workerMinutes", "workerTurns", "budgetUsd", "runTickets", "ticketAttempts"] as const).map((k) => (
            <label key={k}>
              {{ workerMinutes: "Worker minutes", workerTurns: "Worker turns", budgetUsd: "Budget USD per worker", runTickets: "Tickets per run", ticketAttempts: "Attempts per ticket" }[k]}
              <span className="help">{CAP_HELP[k]}</span>
              <input type="number" min={1} value={f[k]} onChange={(e) => set(k, e.target.value)} />
            </label>
          ))}
          <label className="chk" style={{ alignSelf: "end" }}><input type="checkbox" checked={f.reviewer} onChange={(e) => set("reviewer", e.target.checked)} /> Reviewer pass after each ticket</label>
          <label>Memory <span className="help">Container limit, e.g. 4g</span><input value={f.memory} onChange={(e) => set("memory", e.target.value)} /></label>
          <label>CPUs<input type="number" step="0.5" min={0.5} value={f.cpus} onChange={(e) => set("cpus", e.target.value)} /></label>
        </div>
        <div className="save-row">
          <button className="pri" onClick={save} disabled={state !== "dirty" && state !== "error"}>Save</button>
          {state === "dirty" && <button className="quiet" onClick={() => { setF(fromSession()); setState("clean"); }}>Discard</button>}
          <span className={`state ${state === "saved" ? "ok" : state === "error" ? "err" : ""}`}>{state === "saving" ? "Saving…" : state === "saved" ? "Saved" : state === "error" ? msg : state === "dirty" ? "Unsaved changes" : ""}</span>
        </div>
        <div className="small muted">
          Root commands approved so far: {session.rootCommands.length ? session.rootCommands.map((c) => <code key={c.at} style={{ marginRight: 6 }}>{c.command.slice(0, 60)}</code>) : "none"}. They are replayed if the container is recreated.
        </div>
        <div className="small faint mono">{session.image} · {session.id}</div>
      </div>
    </details>
  );
};

// --- drawer ------------------------------------------------------------------

const TicketDrawer = ({ ticket, board, held, sessionId, onClose, onOpen, onAction, onShowLog }: { ticket: Ticket; board: Board; held: boolean; sessionId: string; onClose: () => void; onOpen: (tid: string) => void; onAction: (label: string, fn: () => Promise<unknown>) => Promise<void>; onShowLog: () => void }) => {
  const [note, setNote] = useState("");
  const neededBy = board.tickets.filter((t) => t.deps.includes(ticket.id));
  const [edit, setEdit] = useState(false);
  const toDraft = (t: Ticket) => ({ title: t.title, spec: t.spec, acceptance: t.acceptance.join("\n"), priority: t.priority, size: t.size, repo: t.repo ?? "", deps: t.deps.join(", ") });
  const [draft, setDraft] = useState(toDraft(ticket));
  const [reports, setReports] = useState<{ runId: number; text: string }[]>([]);
  useEffect(() => {
    setDraft(toDraft(ticket));
    setEdit(false);
    api<{ reports: { runId: number; text: string }[] }>("GET", `/sessions/${encodeURIComponent(sessionId)}/tickets/${ticket.id}/reports`).then((r) => setReports(r.reports)).catch(() => setReports([]));
  }, [ticket.id, ticket.updatedAt, sessionId]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !(e.target instanceof HTMLTextAreaElement)) onClose();
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [onClose]);
  const base = `/sessions/${encodeURIComponent(sessionId)}/tickets/${ticket.id}`;
  const move = (state: string) => onAction(`moving to ${state}`, () => api("POST", `${base}/state`, { state })).catch(() => undefined);
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
    )
      .then(() => setEdit(false))
      .catch(() => undefined);
  const tone = ticket.state === "done" ? "good" : ticket.state === "blocked" ? "warn" : ticket.state === "in_progress" || ticket.state === "waiting" ? "sig" : ticket.state === "review" ? "info" : "quiet";
  return (
    <>
      <div className="backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label={`Ticket ${ticket.id}`}>
        <div className="head">
          <h2><span className="id">{ticket.id}</span>{ticket.title}</h2>
          <span className={`pill ${tone}`}>{STATE_LABEL[ticket.state] ?? ticket.state}</span>
          <button className="quiet" onClick={onClose} title="Close (Esc)">✕</button>
        </div>
        <div className="facts">
          <span>{ticket.kind}</span>
          <span>size <b>{ticket.size}</b></span>
          <span>priority <b>{ticket.priority}</b></span>
          {ticket.repo && <span>repo <span className="mono">{ticket.repo}</span></span>}
          {ticket.deps.length > 0 && (
            <span>
              depends on{" "}
              {ticket.deps.map((d) => {
                const dep = board.tickets.find((t) => t.id === d);
                return <a key={d} href="#" className={`pill mono ${dep?.state === "done" ? "good" : "sig"}`} style={{ marginRight: 4 }} title={dep ? `${STATE_LABEL[dep.state]}: ${dep.title}` : "not on the board"} onClick={(ev) => { ev.preventDefault(); onOpen(d); }}>{d}</a>;
              })}
            </span>
          )}
          {neededBy.length > 0 && (
            <span>
              needed by {neededBy.map((t) => <a key={t.id} href="#" className="pill mono quiet" style={{ marginRight: 4 }} title={t.title} onClick={(ev) => { ev.preventDefault(); onOpen(t.id); }}>{t.id}</a>)}
            </span>
          )}
          {ticket.attempts > 0 && <span>attempts <b>{ticket.attempts}</b></span>}
          {ticket.diff && <span className="mono">+{ticket.diff.added} −{ticket.diff.removed} in {ticket.diff.files} file{ticket.diff.files === 1 ? "" : "s"}</span>}
          {ticket.cost?.usd ? <span>cost <b>{fmtUsd(ticket.cost.usd)}</b></span> : null}
          {ticket.pinned && <span className="pill sig">pinned</span>}
        </div>
        {held && <div className="banner signal">A worker holds this ticket. Stop the run to edit or move it.</div>}
        <div className="row">
          {USER_MOVES[ticket.state]?.map((s) => <button key={s} onClick={() => move(s)} disabled={held}>Move to {STATE_LABEL[s]?.toLowerCase()}</button>)}
          <button onClick={() => onAction("pin", () => api("PUT", base, { pinned: !ticket.pinned })).catch(() => undefined)} title="A pinned ticket keeps its priority; the planner may not reorder it">{ticket.pinned ? "Unpin" : "Pin"}</button>
          <button onClick={() => setEdit(!edit)} disabled={held}>{edit ? "Cancel edit" : "Edit"}</button>
          <button className="quiet" onClick={onShowLog}>Show in log</button>
          <span className="end"><ConfirmButton label="Delete" confirm={`Delete ${ticket.id}`} disabled={held} onConfirm={() => onAction("deleting", () => api("DELETE", base)).then(onClose).catch(() => undefined)} /></span>
        </div>
        {edit ? (
          <div className="stack">
            <label>Title<input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></label>
            <label>Spec<textarea value={draft.spec} onChange={(e) => setDraft({ ...draft, spec: e.target.value })} style={{ minHeight: 160 }} /></label>
            <label>Acceptance criteria <span className="help">one per line</span><textarea value={draft.acceptance} onChange={(e) => setDraft({ ...draft, acceptance: e.target.value })} /></label>
            <div className="two">
              <label>Priority <span className="help">1 is first</span><input type="number" min={1} value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: Number(e.target.value) })} /></label>
              <label>Size<select value={draft.size} onChange={(e) => setDraft({ ...draft, size: e.target.value })}><option>S</option><option>M</option><option>L</option></select></label>
              <label>Repo<input value={draft.repo} onChange={(e) => setDraft({ ...draft, repo: e.target.value })} /></label>
              <label>Deps <span className="help">ticket ids, comma separated</span><input value={draft.deps} onChange={(e) => setDraft({ ...draft, deps: e.target.value })} /></label>
            </div>
            <div className="row"><button className="pri" onClick={save}>Save</button><button className="quiet" onClick={() => { setDraft(toDraft(ticket)); setEdit(false); }}>Cancel</button></div>
          </div>
        ) : (
          <>
            <section>
              <h4>Spec</h4>
              <pre>{ticket.spec || "(none)"}</pre>
            </section>
            <section>
              <h4>Acceptance criteria</h4>
              {ticket.acceptance.length ? <ul>{ticket.acceptance.map((a, i) => <li key={i}>{a}</li>)}</ul> : <div className="muted small">none</div>}
            </section>
          </>
        )}
        {ticket.report && (
          <section>
            <h4>Implementer's report</h4>
            <pre>{ticket.report}</pre>
          </section>
        )}
        {reports.length > 0 && (
          <details>
            <summary className="muted small">Worker reports from {reports.length} run{reports.length === 1 ? "" : "s"}</summary>
            <div className="stack" style={{ marginTop: 8 }}>
              {reports.map((r) => (
                <section key={r.runId}>
                  <h4>Run {r.runId}</h4>
                  <pre>{r.text}</pre>
                </section>
              ))}
            </div>
          </details>
        )}
        <section>
          <h4>Notes</h4>
          <ul className="notes">
            {ticket.notes.map((n, i) => <li key={i}><span className="by" title={fmtDateTime(n.at)}>{fmtTime(n.at)} {n.by}</span><span className="wrap">{n.text}</span></li>)}
            {ticket.notes.length === 0 && <li className="muted">none</li>}
          </ul>
          <div className="row" style={{ marginTop: 6 }}>
            <input placeholder="Add a note for the next worker" value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.key === "Enter" && note.trim() && onAction("note", () => api("POST", `${base}/notes`, { text: note })).then(() => setNote("")).catch(() => undefined)} />
            <button onClick={() => onAction("note", () => api("POST", `${base}/notes`, { text: note })).then(() => setNote("")).catch(() => undefined)} disabled={!note.trim()}>Add</button>
          </div>
        </section>
      </aside>
    </>
  );
};

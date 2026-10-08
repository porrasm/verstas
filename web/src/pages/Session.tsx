import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  api,
  type RemoteSettings,
  copyText,
  type ApplyResult,
  type RequestAction,
  fmtAgo,
  fmtBytes,
  fmtDateTime,
  fmtDuration,
  fmtSpan,
  fmtTime,
  fmtUsd,
  isInitialized,
  REVIEW_LABEL,
  STATE_LABEL,
  ticketTiming,
  upload,
  useLive,
  useNow,
  type AgentRequest,
  type Board,
  type Chore,
  type Config,
  type Inbox,
  type NetworkPack,
  type Readiness,
  type ReviewMode,
  type Run,
  type Sandbox,
  type Session,
  type SessionDetail,
  type SetupScript,
  type Ticket,
  type Totals,
  type VEvent,
} from "../api";
import { AgentOptionsButton, useDrivers } from "./AgentOptions";
import { AgentTerminal } from "./Terminal";

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

const ACTION_LABELS: Record<string, { title: string; yes: string; no: string; tone: string }> = {
  network: { title: "Allow a host", yes: "Allow", no: "Decline", tone: "sig" },
  pack: { title: "Allow a toolchain's hosts", yes: "Allow all", no: "Decline", tone: "sig" },
  resources: { title: "Change caps", yes: "Apply", no: "Decline", tone: "sig" },
  instruction: { title: "For you to do", yes: "Done", no: "Decline", tone: "sig" },
  question: { title: "A question", yes: "Answer", no: "Skip", tone: "info" },
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
    if (run?.terminal) return { label: `agent terminal · ${run.terminal.driver === "codex" ? "Codex" : "Claude Code"}`, tone: "sig" };
    if (session.state === "checking") return { label: isInitialized(session) ? "checking the environment" : "initializing the environment", tone: "sig" };
    if (session.state === "planning") return { label: "planning", tone: "sig" };
    if (run?.state === "paused") return { label: `pausing · ${PAUSE_REASON[run.pauseReason ?? ""] ?? run.pauseReason ?? ""}`, tone: "sig" };
    return { label: run?.currentTicket ? `working on ${run.currentTicket}` : "running", tone: "sig" };
  }
  if (!isInitialized(session)) {
    if (session.state === "waiting") return { label: "initialization waits for you", tone: "warn" };
    if (session.readiness?.verdict === "needs") return { label: "initialization needs you", tone: "warn" };
    return { label: "not initialized", tone: "quiet" };
  }
  switch (session.state) {
    case "created":
    case "setup":
      return { label: "not started", tone: "quiet" };
    case "finished":
      return { label: "finished", tone: "good" };
    case "halted":
      return { label: "halted by the agent", tone: "warn" };
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
  const [newTicket, setNewTicket] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [busy, setBusy] = useState("");
  const [logTicket, setLogTicket] = useState("");
  const [lastEventAt, setLastEventAt] = useState<string | null>(null);
  const [dir, setDir] = useState("");
  /** The agent terminal's run while its pane is open; it stays open after the terminal ends until you close it. */
  const [terminalPane, setTerminalPane] = useState<{ run: number; driver: "claude" | "codex" | "cursor" } | null>(null);
  const drivers = useDrivers();
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
    setDir(d.dir);
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
    if (m.type === "draft" || m.sessionId !== id) return;
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
  /** Initialize: clone the repositories, create the container, run the recipes and the setup worker; with start, the tickets follow. */
  const init = (start: boolean) => tryAct(start ? "initializing and starting" : "initializing", () => api("POST", `${base}/init`, { start }));
  const plan = (prompt: string) =>
    act("planning", async () => {
      await api("POST", `${base}/run`, { action: "plan", prompt });
      setPlanning(false);
    }).catch(() => undefined);
  /** Stop or remove this session's container and proxy; either comes back on the next run. */
  const runSandbox = (action: "stop" | "remove") => tryAct(action === "stop" ? "stopping container" : "removing sandbox", () => api("POST", `${base}/sandbox`, { action }));
  const doExport = () =>
    tryAct("exporting", async () => {
      const r = await api<{ howTo: string[] }>("POST", `${base}/export`);
      setExportInfo(r.howTo);
    });
  /** The whole session as <id>.ver, for Import on another machine; the browser saves it. */
  const doArchive = () =>
    tryAct("exporting the session", async () => {
      const r = await api<{ bytes: number; skipped: string[]; download: string }>("POST", `${base}/archive`);
      const a = document.createElement("a");
      a.href = r.download;
      a.download = `${id}.ver`;
      a.click();
      const mb = (r.bytes / 1_048_576).toFixed(1);
      setNotice(`Exported ${id}.ver (${mb} MB). Import it on the other machine from the Sessions page; Initialize there rebuilds the environment.${r.skipped.length ? ` Left out: ${r.skipped.join("; ")}.` : ""}`);
    });
  const doImport = () =>
    tryAct("importing", async () => {
      const r = await api<{ created: string[]; updated: string[]; skipped: { title: string; reason: string }[] }>("POST", `${base}/board/import`, { text: importText, state: "ready" });
      setImportText(null);
      const parts = [`Imported ${r.created.length} new`, r.updated.length ? `updated ${r.updated.length}` : ""].filter(Boolean).join(", ");
      setNotice(r.skipped.length ? `${parts}. Skipped: ${r.skipped.map((s) => `${s.title} (${s.reason})`).join("; ")}` : `${parts}.`);
    });
  const decide = (rid: string, body: { answer?: string; actions?: { id: string; decision: "approve" | "decline"; note?: string }[]; declineAll?: boolean }) => tryAct("deciding", () => api("POST", `${base}/requests/${rid}`, body));
  const openTicket = (tid: string | null) => {
    location.hash = tid ? `#/s/${encodeURIComponent(id)}/t/${encodeURIComponent(tid)}` : `#/s/${encodeURIComponent(id)}`;
  };

  /** Claude Code or Codex in their own interface, in the box, with the board tools; a run of its own. */
  const launchTerminal = (driver: "claude" | "codex") =>
    tryAct("starting the agent terminal", async () => {
      const r = await api<{ run: Run }>("POST", `${base}/terminal`, { driver });
      setTerminalPane({ run: r.run.id, driver });
    });
  // A terminal already running when the page opens (a reload, another window) shows its pane.
  useEffect(() => {
    if (active && run?.terminal) setTerminalPane({ run: run.id, driver: run.terminal.driver });
  }, [active, run?.id, run?.terminal]);

  const ticket = useMemo(() => board?.tickets.find((t) => t.id === ticketId) ?? null, [board, ticketId]);
  if (err && !session) return <div className="banner warn">{err}</div>;
  if (!session || !board || !inbox) return <div className="loading">Loading session…</div>;

  const openRequests = inbox.requests.filter((r) => r.state === "open");
  const counts: Record<string, number> = {};
  for (const t of board.tickets) counts[t.state] = (counts[t.state] ?? 0) + 1;
  const done = counts.done ?? 0;
  const timings = board.tickets.map((t) => ticketTiming(t, session.mode ?? "loop", now)).filter((x) => x !== null);
  const waitingOnYou = timings.length ? timings.reduce((sum, x) => sum + x.waitingOnYou, 0) : null;
  const status = sessionStatus(session, run, active);
  const sb = sandboxLabel(sandbox);
  const lastActivity = lastEventAt && lastEventAt > (totals?.lastActivityAt ?? "") ? lastEventAt : totals?.lastActivityAt;
  const pausedBanner = !active && run && (run.state === "paused" || run.state === "halted" || run.state === "failed") && session.state !== "finished";
  const initialized = isInitialized(session);
  const terminalActive = Boolean(active && run?.terminal);
  /** The setup worker left the box short of ready and nobody accepted it: the one state that needs a decision before anything else. */
  const initNeeds = !initialized && !active && session.readiness?.verdict === "needs" && !session.readiness.confirmedAt;
  const saveSettings = async (patch: SettingsPatch) => {
    if (patch.allowlist || patch.packs) await api("PUT", `${base}/allowlist`, { allowlist: patch.allowlist, packs: patch.packs });
    if (patch.caps || patch.limits || patch.mode || patch.planning !== undefined) await api("PUT", `${base}/caps`, { caps: patch.caps, limits: patch.limits, mode: patch.mode, planning: patch.planning });
    await refreshRun();
  };
  const bodyProps: BodyProps = {
    session,
    board,
    inbox,
    base,
    active,
    busy,
    run,
    runs,
    counts,
    ticketId,
    events,
    eventsRun,
    pickedRun,
    setPickedRun,
    logTicket,
    setLogTicket,
    openTicket,
    tryAct,
    refreshRun,
    onImport: () => setImportText(""),
    onNewTicket: () => setNewTicket(true),
    onExport: doExport,
    onPlan: () => setPlanning(true),
    onInit: init,
    saveSettings,
  };

  return (
    <div className="stack" style={{ gap: 16 }}>
      <header className="sess-head">
        <div className="sess-title">
          <h1>{session.name}</h1>
          <span className={`pill ${status.tone}`}>{active ? <span className="dot run" /> : null}{status.label}</span>
          <div className="actions">
            {initialized && !active && <button className="pri" onClick={() => runAction("start")} disabled={Boolean(busy)} title="Work through the ready tickets">Start run</button>}
            {terminalActive && <ConfirmButton className="pri" label="Start run" confirm="End the terminal and start" onConfirm={() => runAction("start")} disabled={Boolean(busy)} />}
            {initialized && (!active || terminalActive) && <button onClick={() => setPlanning(true)} disabled={Boolean(busy)} title={terminalActive ? "Planning ends the agent terminal first; its changes are committed" : "Describe what to build; a planner worker turns it into backlog tickets"}>Plan tickets…</button>}
            {initialized && !active && (
              <MoreMenu
                label="Agent terminal ▾"
                items={(["claude", "codex"] as const).map((d) => {
                  const info = drivers.find((x) => x.name === d);
                  const configured = info ? info.configured : d === "claude";
                  return { label: `${info?.title ?? (d === "claude" ? "Claude Code" : "Codex")}${configured ? "" : " (no credential; see Settings)"}`, onClick: () => void launchTerminal(d), disabled: !configured };
                })}
              />
            )}
            {active && !terminalActive && <button onClick={() => runAction("pause")} disabled={Boolean(busy)} title="Finish the current ticket, then stop">Pause after ticket</button>}
            {active && !terminalActive && <button className="warn" onClick={() => runAction("stop")} disabled={Boolean(busy)} title="Stop the worker now; its ticket goes back to ready">Stop now</button>}
            {initialized && <button onClick={() => setNewTicket(true)} disabled={Boolean(busy)} title="Write a ticket by hand">New ticket</button>}
            <MoreMenu
              items={[
                { label: "Import board…", onClick: () => setImportText("") },
                { label: "Export board (JSON)", href: `/api${base}/board/export` },
                { label: active ? "Export session (stop the run first)" : "Export session (.ver)…", onClick: doArchive, disabled: active },
                ...(initialized
                  ? [
                      { label: active ? "Export bundles (stop the run first)" : "Export bundles…", onClick: doExport, disabled: active },
                      { label: sandbox?.container === "running" ? "Stop container" : "Stop container (not running)", onClick: () => runSandbox("stop"), disabled: active || sandbox?.container !== "running" },
                      { label: "Remove sandbox (keeps the home volume)", onClick: () => runSandbox("remove"), disabled: active || !sandbox || sandbox.container === "absent" },
                    ]
                  : []),
              ]}
            />
          </div>
        </div>
        <div className="facts">
          {initialized && <span><b>{done}/{board.tickets.length}</b> done</span>}
          {initialized && waitingOnYou !== null && <span title="Time tickets spent waiting for your answers, summed over the board: how unattended the loop is">waiting on you <b>{fmtSpan(waitingOnYou)}</b></span>}
          {initialized && <span><b>{fmtUsd(totals?.usd ?? 0)}</b> spent{totals && totals.runs > 1 ? ` over ${totals.runs} runs` : ""}{active && run?.cost.usd ? ` · ${fmtUsd(run.cost.usd)} this run` : ""}</span>}
          {run && active && <span>running for <b>{fmtDuration(run.startedAt, undefined, now)}</b></span>}
          {initialized && lastActivity && !active && <span>last activity <b title={fmtDateTime(lastActivity)}>{fmtAgo(lastActivity, now)}</b></span>}
          <span>created <b title={fmtDateTime(session.createdAt)}>{fmtAgo(session.createdAt, now)}</b></span>
          {initialized && <span className={sb.tone === "good" ? "ok" : ""}>{sb.text}</span>}
          {initialized && <span>{session.repos.length ? <>repos <span className="mono">{session.repos.map((r) => r.name).join(", ")}</span></> : "no repositories"}</span>}
          {dir && <SessionDir dir={dir} />}
          {initialized && <AgentOptionsButton compact agents={session.agents ?? {}} legacyModel={session.model} reviewerOn={session.caps.reviewer} title="Applies to the next worker that starts; a running worker keeps its agent" onChange={(agents) => tryAct("agents", () => api("PUT", `${base}/caps`, { agents }))} />}
          <NotifyToggle />
          <RemoteToggle session={session} onSet={(remote) => tryAct("remote", () => api("PUT", `${base}/remote`, { remote }))} />
          <span className={live ? "" : "err"} title={live ? "Live updates connected" : "Reconnecting to the host app"}><span className={`dot ${live ? "good" : "bad"}`} /> {live ? "live" : "reconnecting…"}</span>
        </div>
        {initialized && board.tickets.length > 0 && <ProgressStrip counts={counts} total={board.tickets.length} />}
      </header>

      {pausedBanner && run && (
        <div className={`banner ${run.state === "paused" ? "signal" : "warn"}`}>
          <strong>Run {run.id} {run.state}</strong>
          <span>{run.pauseReason ? PAUSE_REASON[run.pauseReason] ?? run.pauseReason : ""}{run.resumeAt ? ` · resumes ${fmtAgo(run.resumeAt, now).replace(" ago", "")} (${fmtDateTime(run.resumeAt)})` : ""}</span>
          {run.endedAt && <span className="muted">ended {fmtAgo(run.endedAt, now)}</span>}
          {initialized && <button className="pri sm end" onClick={() => runAction("start")} disabled={Boolean(busy)}>Resume</button>}
        </div>
      )}
      {err && <div className="banner warn"><span>{err}</span><button className="quiet sm end" onClick={() => setErr("")}>Dismiss</button></div>}
      {busy in EXPORT_MODAL && <WorkingModal title={EXPORT_MODAL[busy]!.title} detail={EXPORT_MODAL[busy]!.detail} />}
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

      {initNeeds && <InitNeedsCard session={session} now={now} busy={Boolean(busy)} onInit={() => init(false)} onAccept={() => tryAct("accepting", () => api("POST", `${base}/setup/confirm`, { start: false }))} />}

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

      {!active && (counts.backlog ?? 0) > 0 && (
        <div className="banner signal">
          <span><b>{counts.backlog}</b> ticket{counts.backlog === 1 ? "" : "s"} in the backlog wait for your approval. The run only takes ready tickets.</span>
          <button className="pri sm end" onClick={() => tryAct("approving", () => api("POST", `${base}/tickets/approve-all`))} disabled={Boolean(busy)}>Approve all</button>
        </div>
      )}

      {planning && <PlanDialog session={session} busy={Boolean(busy)} onCancel={() => setPlanning(false)} onPlan={plan} />}

      {newTicket && (
        <NewTicketForm
          session={session}
          board={board}
          onCancel={() => setNewTicket(false)}
          onCreate={async (body) => {
            await act("creating ticket", () => api("POST", `${base}/tickets`, body));
            setNewTicket(false);
          }}
        />
      )}

      {terminalPane !== null && (
        <AgentTerminal
          key={terminalPane.run}
          sessionId={id}
          base={base}
          title={terminalPane.driver === "codex" ? "Codex" : "Claude Code"}
          driver={terminalPane.driver === "codex" ? "codex" : "claude"}
          onEnd={() => runAction("stop")}
          onClose={() => setTerminalPane(null)}
        />
      )}

      {initialized ? <RunBody {...bodyProps} /> : <PlanBody {...bodyProps} />}

      {ticketId && !ticket && <div className="banner warn"><span>No ticket {ticketId} on this board.</span><button className="quiet sm end" onClick={() => openTicket(null)}>Close</button></div>}
      {ticket && (
        <TicketDrawer
          ticket={ticket}
          board={board}
          clock={ticketClock(session)}
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

// --- the two bodies: a plan to configure, a box to oversee -----------------------

/** What both bodies need from the page: the loaded session, the log state, and the page's actions. */
type BodyProps = {
  session: Session;
  board: Board;
  inbox: Inbox;
  base: string;
  active: boolean;
  busy: string;
  run?: Run;
  runs: Run[];
  counts: Record<string, number>;
  ticketId: string | null;
  events: VEvent[];
  eventsRun: number | null;
  pickedRun: number | null;
  setPickedRun: (r: number | null) => void;
  logTicket: string;
  setLogTicket: (t: string) => void;
  openTicket: (tid: string | null) => void;
  tryAct: (label: string, fn: () => Promise<unknown>) => Promise<unknown>;
  refreshRun: () => Promise<void>;
  onImport: () => void;
  onNewTicket: () => void;
  onExport: () => void;
  onPlan: () => void;
  onInit: (start: boolean) => void;
  saveSettings: (patch: SettingsPatch) => Promise<void>;
};

const useBoardActions = (p: BodyProps) => ({
  onRetry: (tid: string) => void p.tryAct("retrying", () => api("POST", `${p.base}/tickets/${tid}/state`, { state: "ready" })),
  onApprove: (tid: string) => void p.tryAct("approving", () => api("POST", `${p.base}/tickets/${tid}/state`, { state: "ready", note: "Approved" })),
});

const SessionLog = (p: BodyProps) => (
  <LogPanel
    events={p.events}
    runs={p.runs}
    liveRun={p.active ? p.run : undefined}
    shownRun={p.eventsRun}
    picked={p.pickedRun}
    onPick={p.setPickedRun}
    ticket={p.logTicket}
    onTicket={p.setLogTicket}
    tickets={p.board.tickets.map((t) => t.id)}
  />
);

/**
 * The box exists: the board and the live log in front, the inbox and the
 * work beside them. The environment and the settings fold away; they
 * still apply to the next worker.
 */
const RunBody = (p: BodyProps) => {
  const { session, board, inbox, base, active, run, counts } = p;
  const env = useEnvironment(session, base, active, p.refreshRun);
  const { onRetry, onApprove } = useBoardActions(p);
  return (
    <div className="sess-body">
      <div className="main">
        {board.tickets.length === 0 ? (
          <div className="card empty-state">
            <h3>No tickets yet</h3>
            <p>Paste a board, write tickets by hand, or describe what to build and let the planner draft them from the repositories.</p>
            <div className="row">
              <button onClick={p.onImport}>Import board…</button>
              <button className="pri" onClick={p.onPlan} disabled={active || Boolean(p.busy)}>Plan tickets…</button>
            </div>
          </div>
        ) : (
          <BoardView board={board} inbox={inbox} run={run} active={active} clock={ticketClock(session)} openId={p.ticketId} onOpen={p.openTicket} onRetry={onRetry} onApprove={onApprove} onShowLog={p.setLogTicket} />
        )}
        <SessionLog {...p} />
      </div>
      <aside className="side">
        <InboxPanel inbox={inbox} onRead={(mid) => void p.tryAct("read", () => api("POST", `${base}/messages/${mid}/read`))} onPromote={(iid) => void p.tryAct("promote", () => api("POST", `${base}/ideas/${iid}/promote`))} onOpenTicket={p.openTicket} />
        <ChoresPanel board={board} base={base} tryAct={p.tryAct} onOpenTicket={p.openTicket} />
        <WorkPanel session={session} base={base} active={active} done={counts.done ?? 0} onExport={p.onExport} />
        <PromptBox session={session} base={base} active={active} onDone={p.refreshRun} />
        <EnvironmentPanel env={env} />
        <SessionSettings session={session} onSave={p.saveSettings} />
      </aside>
    </div>
  );
};

/**
 * The session is a plan: a setup sheet, section by section in the order
 * that matters at initialization, with the launch panel beside it. While
 * the box is being made the sheet gives way to the log.
 */
const PlanBody = (p: BodyProps) => {
  const { session, board, inbox, base, active, run, counts } = p;
  const env = useEnvironment(session, base, active, p.refreshRun);
  const { onRetry, onApprove } = useBoardActions(p);
  const total = board.tickets.length;
  const ready = counts.ready ?? 0;
  const worker = session.setupMode !== "skip";
  return (
    <div className="sess-body">
      <div className="main">
        {active ? (
          <>
            <InitProgress session={session} />
            <SessionLog {...p} />
          </>
        ) : (
          <>
            <section className="card stack" style={{ gap: 10 }}>
              <SheetHead title="Repositories" mark={session.repos.length ? `${session.repos.length} to clone` : "none yet"} tone={session.repos.length ? "good" : "warn"} />
              <p className="lead" style={{ margin: 0 }}>Cloned fresh at initialization, at the branch chosen here. The workers commit on a branch of their own; Apply brings it back to your checkout.</p>
              <RepoSection env={env} bare />
            </section>

            <section className="stack tight">
              <SheetHead title="Board" mark={total ? `${total} ticket${total === 1 ? "" : "s"} · ${ready} ready` : "empty"} tone={ready ? "good" : total ? "info" : "quiet"}>
                <button className="sm" onClick={p.onImport} disabled={Boolean(p.busy)}>Import board…</button>
                <button className="sm" onClick={p.onNewTicket} disabled={Boolean(p.busy)}>New ticket</button>
              </SheetHead>
              {total === 0 ? (
                <div className="card empty-state">
                  <h3>No tickets yet</h3>
                  <p>Paste a board or write tickets by hand. Or initialize first and let the planner draft them: it reads the repositories, so it needs the box.</p>
                </div>
              ) : (
                <BoardView board={board} inbox={inbox} run={run} active={active} clock={ticketClock(session)} openId={p.ticketId} onOpen={p.openTicket} onRetry={onRetry} onApprove={onApprove} onShowLog={p.setLogTicket} />
              )}
            </section>

            <section className="card stack" style={{ gap: 10 }}>
              <SheetHead title="Environment" mark={worker ? `setup worker · ${session.setupScripts.length} recipe${session.setupScripts.length === 1 ? "" : "s"}` : `setup skipped · ${session.setupScripts.length} recipe${session.setupScripts.length === 1 ? "" : "s"}`} tone="quiet" />
              <SetupSection env={env} />
              <Divider />
              <RecipeSection env={env} />
              <Divider />
              <AttachmentSection env={env} />
              {hasNotes(env) && (
                <>
                  <Divider />
                  <div className="muted small">Left from an earlier box; the next setup worker rewrites them.</div>
                  <NotesSection env={env} />
                </>
              )}
            </section>

            <section className="card stack" style={{ gap: 10 }}>
              <SheetHead title="Network" mark={session.packs.length ? `${session.packs.length} pack${session.packs.length === 1 ? "" : "s"}` : "agents' backends only"} tone="quiet" />
              <SessionSettings session={session} onSave={p.saveSettings} part="network" />
            </section>

            <section className="card stack" style={{ gap: 10 }}>
              <SheetHead title="Agents, caps and limits" mark="every worker" tone="quiet" />
              <AgentOptionsButton agents={session.agents ?? {}} legacyModel={session.model} reviewerOn={session.caps.reviewer} onChange={(agents) => void p.tryAct("agents", () => api("PUT", `${base}/caps`, { agents }))} />
              <SessionSettings session={session} onSave={p.saveSettings} part="caps" />
            </section>

            {p.runs.length > 0 && <SessionLog {...p} />}
          </>
        )}
      </div>
      <aside className="side sticky">
        <LaunchPanel env={env} counts={counts} total={total} busy={Boolean(p.busy)} onInit={p.onInit} />
      </aside>
    </div>
  );
};
// --- taking the work back --------------------------------------------------------

const WorkPanel = ({ session, base, active, done, onExport }: { session: Session; base: string; active: boolean; done: number; onExport: () => void }) => {
  const [busy, setBusy] = useState("");
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [err, setErr] = useState("");
  if (!session.repos.length || !isInitialized(session)) return null;
  const apply = async (repo: string) => {
    setBusy(repo);
    setErr("");
    setResult(null);
    try {
      setResult(await api<ApplyResult>("POST", `${base}/apply`, { repo }));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  return (
    <section className="card stack" style={{ gap: 8 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h3>Work</h3>
        <span className="muted small">{done} ticket{done === 1 ? "" : "s"} committed</span>
      </div>
      <p className="lead">Apply puts a repository's commits on the branch <span className="mono">{session.repos[0]?.runBranch}</span> in your real checkout. Your current branch is not touched; merge or cherry-pick when you are ready.</p>
      {session.repos.map((r) => (
        <div className="row" key={r.name} style={{ justifyContent: "space-between" }}>
          <span><strong>{r.name}</strong> <span className="muted small mono" title={r.sourcePath}>{r.sourcePath.replace(/^\/Users\/[^/]+/, "~")}</span></span>
          <button className="sm" onClick={() => apply(r.name)} disabled={Boolean(busy) || active} title={active ? "Pause or stop the run first" : `Create or update ${r.runBranch} in ${r.sourcePath}`}>{busy === r.name ? "Applying…" : "Apply to repo"}</button>
        </div>
      ))}
      <div className="row"><button className="quiet sm" onClick={onExport} disabled={active}>Export bundles instead…</button></div>
      {err && <div className="banner warn"><span>{err}</span><button className="quiet sm end" onClick={() => setErr("")}>Dismiss</button></div>}
      {result && (
        <div className="stack" style={{ gap: 6 }}>
          <div className="small ok">Branch <span className="mono">{result.branch}</span> is up to date in <span className="mono">{result.targetPath}</span>: {result.commits.length} commit{result.commits.length === 1 ? "" : "s"} since the session started.</div>
          {result.commits.length > 0 && (
            <ul className="small mono" style={{ margin: 0, paddingLeft: 18 }}>
              {result.commits.map((c) => <li key={c.sha}><span className="muted">{c.sha}</span> {c.subject}</li>)}
            </ul>
          )}
          <details>
            <summary className="muted small">Next steps in a terminal</summary>
            <pre className="mono" style={{ whiteSpace: "pre-wrap" }}>{result.howTo.join("\n")}</pre>
          </details>
          <button className="quiet sm" onClick={() => setResult(null)}>Close</button>
        </div>
      )}
    </section>
  );
};

// --- the environment: repositories, attachments, recipes, setup mode, initialization ------

type SetupInfo = { requirements: string; readiness: Readiness | null; env: string; recipe: string; recipeLog: string; logs: Record<string, string> };
type RepoChoice = { target: string; path: string; branches: string[]; current: string };
type Brief = { text: string; updatedAt: string | null; words: number };

/**
 * Everything the box is made of, shared by the sections below. While the
 * session is a plan the sections are cards of the setup sheet; once the
 * box exists they fold into one Environment panel in the sidebar. Before
 * initialization the repositories can change; everything else can change
 * at any time (recipes re-run on request, instructions apply to the next
 * setup worker).
 */
const useEnvironment = (session: Session, base: string, active: boolean, onDone: () => Promise<void>) => {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [info, setInfo] = useState<SetupInfo | null>(null);
  const [brief, setBrief] = useState<Brief | null>(null);
  const [sudo, setSudo] = useState<{ count: number; commands: string[] } | null>(null);
  const [library, setLibrary] = useState<SetupScript[]>([]);
  const [choices, setChoices] = useState<RepoChoice[]>([]);
  const initialized = isInitialized(session);
  const now = useNow();
  useEffect(() => {
    api<SetupInfo>("GET", `${base}/setup`).then(setInfo).catch(() => setInfo(null));
    api<Brief>("GET", `${base}/brief`).then(setBrief).catch(() => setBrief(null));
    api<{ count: number; commands: string[] }>("GET", `${base}/sudo-log`).then(setSudo).catch(() => setSudo(null));
  }, [base, session.readiness?.at, session.readiness?.confirmedAt, session.requirements, session.initializedAt, active]);
  useEffect(() => {
    api<SetupScript[]>("GET", "/scripts").then(setLibrary).catch(() => setLibrary([]));
  }, []);
  useEffect(() => {
    if (initialized) return;
    api<Config>("GET", "/config")
      .then(async (c) => {
        const out: RepoChoice[] = [];
        for (const w of c.workTargets) {
          const b = await api<{ current: string; branches: string[] }>("GET", `/work-targets/${encodeURIComponent(w.name)}/branches`).catch(() => ({ current: "", branches: [] }));
          out.push({ target: w.name, path: w.path, branches: b.branches, current: b.current });
        }
        setChoices(out);
      })
      .catch(() => setChoices([]));
  }, [initialized]);
  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setMsg("");
    try {
      await fn();
      if (done) setMsg(done);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
      await onDone();
    }
  };
  const copyContext = async () => {
    const md = await fetch(`/api/context?tail=free&session=${encodeURIComponent(session.id)}`).then((r) => r.text());
    await copyText(md);
    setMsg("Session context copied for an assistant.");
  };
  return { session, base, active, busy, msg, info, brief, sudo, library, choices, initialized, now, act, copyContext };
};
type Env = ReturnType<typeof useEnvironment>;

/** The repositories: added and removed while the session is a plan, fresh clones once it is a box. */
const RepoSection = ({ env, bare }: { env: Env; bare?: boolean }) => {
  const { session, base, active, busy, choices, initialized, act } = env;
  const [adding, setAdding] = useState<{ target: string; branch: string; as: string } | null>(null);
  const free = choices.filter((c) => !session.repos.some((x) => x.name === c.target && x.sourcePath === c.path));
  const startAdd = () => {
    const c = free[0];
    if (c) setAdding({ target: c.target, branch: c.current, as: "" });
  };
  const chosen = adding ? choices.find((c) => c.target === adding.target) : undefined;
  const addRepo = () =>
    adding &&
    act(async () => {
      await api("POST", `${base}/repos`, { target: adding.target, branch: adding.branch || undefined, name: adding.as.trim() || undefined });
      setAdding(null);
    }, "Repository added; it is cloned when you initialize.");
  const removeRepo = (name: string) => act(() => api("DELETE", `${base}/repos/${encodeURIComponent(name)}`));
  return (
    <div className="small">
      {!bare && <><strong>Repositories</strong> <span className="muted">{initialized ? "fresh clones under /workspace" : "cloned fresh at initialization, at the branch chosen here"}</span></>}
      {session.repos.length === 0 && <div className="muted" style={{ marginTop: 4 }}>None yet{initialized ? "" : ": add the ones the tickets touch. Without one the workers have nothing to change"}.</div>}
      {session.repos.map((x) => (
        <div className="row" key={x.name} style={{ justifyContent: "space-between", marginTop: 4 }}>
          <span><strong>{x.name}</strong> <span className="muted mono">{x.branch}</span> <span className="muted mono" title={x.sourcePath}>{x.sourcePath.replace(/^\/Users\/[^/]+/, "~")}</span>{x.baseCommit ? <span className="muted mono"> · {x.baseCommit.slice(0, 7)}</span> : null}</span>
          {!initialized && <button className="quiet sm" onClick={() => removeRepo(x.name)} disabled={busy || active}>remove</button>}
        </div>
      ))}
      {session.repos.map((x) => (
        <label key={`check-${x.name}`} style={{ marginTop: 6 }}>
          Check for {x.name} <span className="help">The repository's full check, run by Verstas once per submitted ticket and chore sweep (a failure goes back without a reviewer; the reviewer does not repeat a pass). Empty: Verstas guesses npm scripts.</span>
          <CheckCommand value={x.check ?? ""} disabled={busy} onSave={(v) => act(() => api("PUT", `${base}/repos/${encodeURIComponent(x.name)}/check`, { check: v || null }), v ? `Check for ${x.name} saved.` : `Check for ${x.name} cleared.`)} />
        </label>
      ))}
      {!initialized && adding === null && free.length > 0 && <button className="sm" style={{ marginTop: 6 }} onClick={startAdd} disabled={busy || active}>Add repository</button>}
      {!initialized && adding === null && free.length === 0 && choices.length === 0 && <div className="muted" style={{ marginTop: 4 }}>No work targets: add repositories in <a href="#/settings">Settings</a>.</div>}
      {adding && (
        <div className="stack" style={{ gap: 6, marginTop: 6 }}>
          <div className="row">
            <select value={adding.target} onChange={(e) => { const c = choices.find((x) => x.target === e.target.value); setAdding({ target: e.target.value, branch: c?.current ?? "", as: "" }); }}>
              {free.concat(chosen && !free.includes(chosen) ? [chosen] : []).map((c) => <option key={c.target} value={c.target}>{c.target}</option>)}
            </select>
            <select value={adding.branch} onChange={(e) => setAdding({ ...adding, branch: e.target.value })}>
              {(chosen?.branches ?? []).map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
            <input value={adding.as} onChange={(e) => setAdding({ ...adding, as: e.target.value })} placeholder={`as ${adding.target}`} title="Directory name under /workspace, when it should differ from the target name" style={{ maxWidth: 160 }} />
          </div>
          <div className="row">
            <button className="pri sm" onClick={addRepo} disabled={busy || !adding.branch}>Add</button>
            <button className="sm" onClick={() => setAdding(null)}>Cancel</button>
            <span className="muted">{chosen?.path.replace(/^\/Users\/[^/]+/, "~")}</span>
          </div>
        </div>
      )}
    </div>
  );
};

/** A repository's check command; saved when the field loses focus or on Enter. */
const CheckCommand = ({ value, disabled, onSave }: { value: string; disabled: boolean; onSave: (v: string) => Promise<unknown> }) => {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const save = () => {
    if (text.trim() !== value.trim()) void onSave(text.trim()).catch(() => setText(value));
  };
  return (
    <input
      className="mono"
      value={text}
      maxLength={2000}
      disabled={disabled}
      placeholder="bash scripts/check.sh"
      onChange={(e) => setText(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setText(value);
      }}
    />
  );
};

/** What an attachment is for, in your words; saved when the field loses focus or on Enter. */
const AttachmentDescription = ({ value, disabled, onSave }: { value: string; disabled: boolean; onSave: (v: string) => Promise<unknown> }) => {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const save = () => {
    if (text.trim() !== value.trim()) void onSave(text).catch(() => setText(value));
  };
  return (
    <input
      value={text}
      maxLength={1000}
      disabled={disabled}
      placeholder="What it is and what it is for, e.g. the spec; tickets cite its sections"
      title="Every worker sees this next to the attachment's path, from the next run on."
      onChange={(e) => setText(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setText(value);
      }}
      style={{ marginTop: 4, width: "100%" }}
    />
  );
};

/** Zips extracted into the workspace for the workers to read. */
const AttachmentSection = ({ env }: { env: Env }) => {
  const { session, base, active, busy, act } = env;
  const addZips = async (files: FileList | null) => {
    if (!files?.length) return;
    await act(async () => {
      const done: { id: string; name: string }[] = [];
      for (const f of Array.from(files)) done.push(await upload(f));
      await api("POST", `${base}/attachments`, { uploads: done });
    }, "Attachments extracted into workspace/attachments.");
  };
  const removeAttachment = (dir: string) => act(() => api("DELETE", `${base}/attachments/${encodeURIComponent(dir)}`));
  return (
    <div className="small">
      <strong>Attachments</strong> <span className="muted">zips extracted into workspace/attachments: specs, designs, sample data</span>
      {session.attachments.map((a) => (
        <div key={a.dir} style={{ marginTop: 6 }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span><strong>{a.dir}</strong> <span className="muted mono">{fmtBytes(a.bytes)}</span>{a.skipped.length ? <span className="muted"> · {a.skipped.length} skipped</span> : null}</span>
            <button className="quiet sm" onClick={() => removeAttachment(a.dir)} disabled={busy || active}>remove</button>
          </div>
          <AttachmentDescription value={a.description ?? ""} disabled={busy} onSave={(description) => act(() => api("PUT", `${base}/attachments/${encodeURIComponent(a.dir)}`, { description }))} />
        </div>
      ))}
      <input type="file" accept=".zip,application/zip" multiple onChange={(e) => { void addZips(e.target.files); e.target.value = ""; }} disabled={busy || active} style={{ marginTop: 6 }} />
    </div>
  );
};

/** The setup worker's verdict: its checks, its summary, and when it was. */
const ReadinessView = ({ r, now, open = false }: { r: Readiness; now: number; open?: boolean }) => {
  const [show, setShow] = useState(open);
  return (
    <div className="small">
      <span className={`dot ${r.verdict === "ready" ? "good" : "bad"}`} /> <strong>{r.verdict === "ready" ? "Ready" : "Needs attention"}</strong> <span className="muted">{fmtAgo(r.at, now)}{r.confirmedAt ? " · accepted" : ""}</span>{" "}
      {r.checks.length > 0 && <button className="quiet sm" onClick={() => setShow(!show)}>{show ? "hide checks" : `${r.checks.filter((c) => c.ok).length}/${r.checks.length} checks`}</button>}
      {show && <ul className="checks">{r.checks.map((c, i) => <li key={i} className={c.ok ? "ok" : "err"}>{c.ok ? "✓" : "✗"} {c.text}</li>)}</ul>}
      {r.summary && <div className="muted" style={{ marginTop: 4, whiteSpace: "pre-wrap" }}>{r.summary}</div>}
    </div>
  );
};

/** What happens at initialization after the container and the recipes: a setup worker with your instructions, or nothing. */
const SetupSection = ({ env }: { env: Env }) => {
  const { session, base, active, busy, initialized, now, act } = env;
  const [draft, setDraft] = useState(session.requirements);
  useEffect(() => setDraft(session.requirements), [session.requirements]);
  const dirty = draft !== session.requirements;
  const saveInstructions = () => act(() => api("PUT", `${base}/requirements`, { requirements: draft }), initialized ? "Saved. They apply to the next environment check." : "Saved. They apply when you initialize.");
  const setMode = (setupMode: "agentic" | "skip") => act(() => api("PUT", `${base}/requirements`, { setupMode }));
  const r = session.readiness;
  return (
    <div className="small">
      <strong>Setup</strong> <span className="muted">what happens at initialization, after the container and the recipes</span>
      <div className="stack" style={{ gap: 4, marginTop: 6 }}>
        <label className="chk"><input type="radio" name="setupMode" checked={session.setupMode !== "skip"} onChange={() => void setMode("agentic")} disabled={busy || active} /> <strong>Setup worker</strong> <span className="muted">reads the repositories and the board, installs toolchains and dependencies, starts the services the tests need, verifies the build and test commands, writes env.md and the recipe. Implements nothing.</span></label>
        <label className="chk"><input type="radio" name="setupMode" checked={session.setupMode === "skip"} onChange={() => void setMode("skip")} disabled={busy || active} /> <strong>Skip</strong> <span className="muted">the container and the recipes only; the workers find out what is missing.</span></label>
      </div>
      {session.setupMode !== "skip" && (
        <label style={{ marginTop: 8 }}>
          Instructions for the setup worker <span className="help">optional, on top of what it works out itself</span>
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} disabled={active} placeholder={"Run the app but do not run the tests\nSet up the env and check that you can POST to /api/somepath\nPostgres 17 reachable, migrations applied"} style={{ minHeight: 72 }} />
        </label>
      )}
      {session.setupMode !== "skip" && dirty && (
        <div className="row" style={{ marginTop: 6 }}>
          <button className="pri sm" onClick={saveInstructions} disabled={busy}>Save instructions</button>
          <button className="sm" onClick={() => setDraft(session.requirements)}>Discard</button>
        </div>
      )}
      {/* Before initialization a "needs" verdict is the attention card at the top of the page. */}
      {r && initialized && <div style={{ marginTop: 8 }}><ReadinessView r={r} now={now} /></div>}
      {initialized && <button className="quiet sm" style={{ marginTop: 6 }} onClick={() => act(() => api("POST", `${base}/run`, { action: "setup" }), "Setup worker started.")} disabled={busy || active} title="Run the setup worker again against this box">Check the environment again</button>}
    </div>
  );
};

/** Recipes from the library, ticked for this session; their results once the container ran them. */
const RecipeSection = ({ env }: { env: Env }) => {
  const { session, base, active, busy, info, library, initialized, now, act } = env;
  const [openLog, setOpenLog] = useState<string | null>(null);
  const picked = new Set(session.setupScripts.map((sc) => sc.name));
  const setRecipes = (names: string[]) => act(() => api("PUT", `${base}/recipes`, { names }), initialized ? "Recipes saved; press Re-run recipes to apply them to this box." : "Recipes saved; they run when the container is created.");
  return (
    <div className="small">
      <strong>Recipes</strong> <span className="muted">from the library, run as root when the container is created, in this order</span>
      {library.length === 0 && session.setupScripts.length === 0 && <div className="muted" style={{ marginTop: 4 }}>The library is empty; write one under <a href="#/scripts">Recipes</a>.</div>}
      {library.map((sc) => {
        const res = session.setup.find((x) => x.name === sc.name);
        const on = picked.has(sc.name);
        return (
          <div key={sc.name} style={{ marginTop: 4 }}>
            <label className="chk">
              <input type="checkbox" checked={on} disabled={busy || active} onChange={(e) => void setRecipes(e.target.checked ? [...session.setupScripts.map((x) => x.name), sc.name] : session.setupScripts.map((x) => x.name).filter((n) => n !== sc.name))} />
              <strong>{sc.name}</strong> <span className="muted">{sc.description}</span>
            </label>
            {on && res && (
              <div style={{ marginLeft: 22 }}>
                <span className={`dot ${res.ok ? "good" : "bad"}`} /> <span className="muted">{res.ok ? `ok · ${fmtAgo(res.at, now)}` : `failed, exit ${res.code} · ${fmtAgo(res.at, now)}`}</span>{" "}
                <button className="quiet sm" onClick={() => setOpenLog(openLog === sc.name ? null : sc.name)}>{openLog === sc.name ? "hide log" : "log"}</button>
                {openLog === sc.name && <pre className="mono" style={{ whiteSpace: "pre-wrap", maxHeight: 240, overflow: "auto", marginTop: 6 }}>{info?.logs[sc.name] || res.tail || "(empty)"}</pre>}
              </div>
            )}
          </div>
        );
      })}
      {session.setupScripts.filter((sc) => !library.some((l) => l.name === sc.name)).map((sc) => <div key={sc.name} style={{ marginTop: 4 }}><span className="dot" /> {sc.name} <span className="muted">no longer in the library; still runs here</span></div>)}
      {initialized && session.setupScripts.length > 0 && <button className="sm" style={{ marginTop: 6 }} onClick={() => act(() => api("POST", `${base}/setup/rerun`), "Recipes ran again.")} disabled={busy || active} title={active ? "Pause or stop the run first" : "Run every recipe again in this box"}>Re-run recipes</button>}
    </div>
  );
};

/** What the setup worker wrote (env.md, setup.sh, the brief) and what ran as root. Nothing to show while the session is a plan. */
const NotesSection = ({ env }: { env: Env }) => {
  const { session, base, active, busy, info, brief, sudo, initialized, now, act } = env;
  const [show, setShow] = useState<"" | "brief" | "env" | "recipe" | "sudo">("");
  const [recipeName, setRecipeName] = useState<string | null>(null);
  const toggle = (k: typeof show) => setShow(show === k ? "" : k);
  return (
    <div className="stack tight">
      <div className="small">
        <span className={`dot ${info?.env ? "good" : ""}`} /> <strong>env.md</strong> <span className="muted">{info?.env ? "what is installed and how to run it; every worker reads it" : "written by the setup worker"}</span>{" "}
        {info?.env && <button className="quiet sm" onClick={() => toggle("env")}>{show === "env" ? "hide" : "view"}</button>}
        {show === "env" && <pre className="mono" style={{ whiteSpace: "pre-wrap", maxHeight: 360, overflow: "auto", marginTop: 6 }}>{info?.env}</pre>}
      </div>
      <div className="small">
        <span className={`dot ${info?.recipe ? "good" : ""}`} /> <strong>setup.sh</strong> <span className="muted">{info?.recipe ? "the recipe that rebuilds the box after a recreate" : "written by the setup worker"}</span>{" "}
        {info?.recipe && <button className="quiet sm" onClick={() => toggle("recipe")}>{show === "recipe" ? "hide" : "view"}</button>}{" "}
        {info?.recipe && recipeName === null && <button className="quiet sm" onClick={() => setRecipeName(session.repos.map((x) => x.name).join("-") || "recipe")} title="Save setup.sh and env.md to the recipe library, to tick on the next session">Save as recipe</button>}
        {recipeName !== null && (
          <div className="row" style={{ marginTop: 6 }}>
            <input value={recipeName} onChange={(e) => setRecipeName(e.target.value)} placeholder="recipe name" style={{ maxWidth: 240 }} />
            <button className="pri sm" disabled={busy || !recipeName.trim()} onClick={() => act(async () => { await api("POST", `${base}/recipe/promote`, { name: recipeName.trim() }); setRecipeName(null); }, "Saved to Recipes. Tick it on the next session for these repositories.")}>Save</button>
            <button className="sm" onClick={() => setRecipeName(null)}>Cancel</button>
          </div>
        )}
        {show === "recipe" && <pre className="mono" style={{ whiteSpace: "pre-wrap", maxHeight: 360, overflow: "auto", marginTop: 6 }}>{info?.recipe}{info?.recipeLog ? `\n\n--- last replay ---\n${info.recipeLog.slice(-3000)}` : ""}</pre>}
      </div>
      <div className="small">
        <span className={`dot ${brief?.text ? "good" : ""}`} /> <strong>Project brief</strong>{" "}
        <span className="muted">{brief?.text ? `${brief.words} words · ${brief.updatedAt ? fmtAgo(brief.updatedAt, now) : ""} · every worker reads it first` : "none yet; the setup worker writes notes/brief.md"}</span>{" "}
        {brief?.text && <button className="quiet sm" onClick={() => toggle("brief")}>{show === "brief" ? "hide" : "view"}</button>}{" "}
        {initialized && <button className="quiet sm" onClick={() => act(() => api("POST", `${base}/run`, { action: "brief" }), "Setup worker started; the brief appears when it finishes.")} disabled={busy || active} title={active ? "Pause or stop the run first" : "Run a setup worker that writes or refreshes the brief"}>{brief?.text ? "Refresh brief" : "Write brief"}</button>}
        {show === "brief" && brief?.text && <pre className="mono" style={{ whiteSpace: "pre-wrap", maxHeight: 360, overflow: "auto", marginTop: 6 }}>{brief.text}</pre>}
      </div>
      <div className="small">
        <span className="dot" /> <strong>Run as root</strong>{" "}
        <span className="muted">{sudo?.count ? `${sudo.count} sudo command${sudo.count === 1 ? "" : "s"} by the agent` : "nothing yet"}</span>{" "}
        {Boolean(sudo?.count) && <button className="quiet sm" onClick={() => toggle("sudo")}>{show === "sudo" ? "hide" : "view"}</button>}
        {show === "sudo" && sudo && <pre className="mono" style={{ whiteSpace: "pre-wrap", maxHeight: 240, overflow: "auto", marginTop: 6 }}>{sudo.commands.join("\n")}</pre>}
      </div>
    </div>
  );
};

/** Has the setup worker left anything to read? After a reset the notes stay, so a plan can have them too. */
const hasNotes = (env: Env): boolean => Boolean(env.info?.env || env.info?.recipe || env.brief?.text || env.sudo?.count);

const Divider = () => <div style={{ borderTop: "1px solid var(--line)" }} />;

/**
 * The run view's Environment panel: the box as it is, folded, with the
 * sections that still matter once it exists. Reset makes the session a
 * plan again.
 */
const EnvironmentPanel = ({ env }: { env: Env }) => {
  const { session, base, active, busy, msg, now, act, copyContext } = env;
  return (
    <details className="card">
      <summary><strong>Environment</strong><span className="muted small">initialized {fmtAgo(session.initializedAt!, now)} · {session.repos.length} repositor{session.repos.length === 1 ? "y" : "ies"} · {session.setupScripts.length} recipe{session.setupScripts.length === 1 ? "" : "s"}</span></summary>
      <div className="stack tight" style={{ marginTop: 12 }}>
        <div className="row small" style={{ justifyContent: "space-between" }}>
          <span><span className="dot good" /> <strong>Initialized</strong> <span className="muted" title={fmtDateTime(session.initializedAt!)}>{fmtAgo(session.initializedAt!, now)}</span></span>
          <button className="quiet sm" onClick={copyContext} title="Markdown describing this box and session, to paste into any assistant">Copy context for an LLM</button>
        </div>
        <Divider />
        <RepoSection env={env} />
        <Divider />
        <AttachmentSection env={env} />
        <Divider />
        <SetupSection env={env} />
        <Divider />
        <RecipeSection env={env} />
        <Divider />
        <NotesSection env={env} />
        <Divider />
        <div className="row small">
          <a className="btn quiet sm" href={`#/new?from=${encodeURIComponent(env.session.id)}`} title="A fresh board on a copy of this box: settings, home volume, snapshot and notes; this session is not changed">New session from this environment</a>
          <ResetEnvironment env={env} />
        </div>
        {msg && <div className="muted small">{msg}</div>}
      </div>
    </details>
  );
};

/**
 * Reset environment: what goes, said plainly, with each repository's
 * commits since the session started. The clones are deleted, so work on a
 * run branch that was not applied or exported is lost; when there is any,
 * the dialog offers Apply and Export before the reset.
 */
const ResetEnvironment = ({ env }: { env: Env }) => {
  const { session, base, active, busy, act } = env;
  const [open, setOpen] = useState(false);
  const [repos, setRepos] = useState<{ name: string; runBranch: string; commits: number | null }[] | null>(null);
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [working, setWorking] = useState("");
  const [err, setErr] = useState("");
  useEffect(() => {
    if (!open) return;
    setRepos(null);
    setErr("");
    api<{ repos: { name: string; runBranch: string; commits: number | null }[] }>("GET", `${base}/commits`)
      .then((r) => setRepos(r.repos))
      .catch((e: Error) => {
        setErr(e.message);
        setRepos(session.repos.map((r) => ({ name: r.name, runBranch: r.runBranch, commits: null })));
      });
  }, [open, base, session.repos]);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => e.key === "Escape" && !working && setOpen(false);
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [open, working]);
  const step = async (label: string, fn: () => Promise<string>) => {
    setWorking(label);
    setErr("");
    try {
      const done = await fn();
      setSaved((x) => ({ ...x, [label]: done }));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setWorking("");
    }
  };
  const apply = (repo: string) => step(repo, async () => {
    const r = await api<ApplyResult>("POST", `${base}/apply`, { repo });
    return `applied to ${r.branch} in ${r.targetPath}`;
  });
  const exportAll = () => step("export", async () => {
    const r = await api<{ howTo: string[] }>("POST", `${base}/export`);
    return r.howTo.join(" ");
  });
  const atRisk = (repos ?? []).filter((r) => r.commits !== 0 && !saved[r.name] && !saved.export);
  const reset = () => {
    setOpen(false);
    void act(() => api("POST", `${base}/reset`), "Environment reset. The session is a plan again; initialize it to get a box.");
  };
  if (!open) return <button className="quiet sm" onClick={() => setOpen(true)} disabled={busy || active} title={active ? "Pause or stop the run first" : undefined}>Reset environment</button>;
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !working && setOpen(false)} role="dialog" aria-modal="true" aria-labelledby="reset-title">
      <div className="dialog">
        <h3 id="reset-title">Reset environment</h3>
        <p className="small" style={{ margin: 0 }}>
          This deletes the container, the proxy and network, the home volume (installed toolchains and caches), the snapshot, and <strong>the clones of your repositories</strong>. Commits on a run branch that you have not applied or exported are lost with them. The board, notes, settings and run history stay; the session becomes a plan again and needs Initialize.
        </p>
        <div className="stack tight">
          {repos === null && <div className="muted small">Counting commits since the session started…</div>}
          {repos?.map((r) => (
            <div className="row small" key={r.name} style={{ justifyContent: "space-between" }}>
              <span>
                <strong>{r.name}</strong> <span className="mono muted">{r.runBranch}</span>:{" "}
                {r.commits === null ? <span className="warn">could not count the commits</span> : r.commits === 0 ? <span className="muted">no commits since the session started</span> : <b>{r.commits} commit{r.commits === 1 ? "" : "s"} since the session started</b>}
                {saved[r.name] && <span className="ok"> · {saved[r.name]}</span>}
              </span>
              {r.commits !== 0 && <button className="sm" onClick={() => void apply(r.name)} disabled={Boolean(working)}>{working === r.name ? "Applying…" : "Apply to repo"}</button>}
            </div>
          ))}
          {repos && repos.some((r) => r.commits !== 0) && (
            <div className="row small">
              <button className="quiet sm" onClick={() => void exportAll()} disabled={Boolean(working)}>{working === "export" ? "Exporting…" : "Export bundles"}</button>
              {saved.export && <span className="ok">{saved.export}</span>}
            </div>
          )}
          {err && <div className="banner warn"><span>{err}</span></div>}
        </div>
        <div className="row">
          <button className="warn solid" onClick={reset} disabled={repos === null || Boolean(working)}>{atRisk.length ? `Reset and lose ${atRisk.map((r) => r.name).join(", ")}'s unsaved work` : "Reset environment"}</button>
          <button className="quiet" onClick={() => setOpen(false)} disabled={Boolean(working)}>Cancel</button>
        </div>
      </div>
    </div>
  );
};

// --- the plan: the setup sheet and the launch panel -----------------------------

/** A sheet section's head: the title and a mark saying how far along it is. */
const SheetHead = ({ title, mark, tone, children }: { title: string; mark: string; tone: Tone; children?: ReactNode }) => (
  <div className="row" style={{ justifyContent: "space-between" }}>
    <h3>{title}</h3>
    <span className="row" style={{ gap: 8 }}>{children}<span className={`pill ${tone}`}>{mark}</span></span>
  </div>
);

/**
 * The sidebar of a plan: what Initialize will do with this setup, and the
 * buttons that do it. Every line mirrors a section of the sheet.
 */
const LaunchPanel = ({ env, counts, total, busy, onInit }: { env: Env; counts: Record<string, number>; total: number; busy: boolean; onInit: (start: boolean) => void }) => {
  const { session, active, msg, copyContext } = env;
  const ready = counts.ready ?? 0;
  const worker = session.setupMode !== "skip";
  return (
    <section className="card stack launch" style={{ gap: 10 }}>
      <h3>{active ? "Initializing…" : "Ready to initialize?"}</h3>
      <p className="lead" style={{ margin: 0 }}>Initialize clones the repositories, creates the container and runs the recipes{worker ? ", then a setup worker makes the box ready" : ""}. Nothing runs before that; come back to this plan over hours if you like.</p>
      <ul className="launch-list">
        <li><span className={`dot ${session.repos.length ? "good" : "bad"}`} />{session.repos.length ? <span><b>{session.repos.length}</b> repositor{session.repos.length === 1 ? "y" : "ies"}: <span className="mono">{session.repos.map((r) => r.name).join(", ")}</span></span> : <span>No repositories: the workers would have nothing to change.</span>}</li>
        <li><span className={`dot ${ready ? "good" : total ? "info" : ""}`} />{total ? <span><b>{total}</b> ticket{total === 1 ? "" : "s"}, <b>{ready}</b> ready{counts.backlog ? `, ${counts.backlog} in the backlog` : ""}</span> : <span>No tickets yet. Fine: the planner drafts them once the box exists.</span>}</li>
        <li><span className={`dot ${session.setupScripts.length ? "good" : ""}`} />{session.setupScripts.length ? <span>Recipes: {session.setupScripts.map((s) => s.name).join(", ")}</span> : <span>No recipes; the box starts from the plain image.</span>}</li>
        <li><span className={`dot ${worker ? "good" : ""}`} />{worker ? <span>Setup worker{session.requirements.trim() ? ", with your instructions" : ""}</span> : <span>Setup skipped: the workers find out what is missing.</span>}</li>
        <li><span className={`dot ${session.packs.length || session.allowlist.length ? "good" : ""}`} />{session.packs.length ? <span>Packs: {session.packs.join(", ")}</span> : <span>No packs: only the agents' backends{session.allowlist.length ? " and the allowlist" : ""}.</span>}</li>
        {session.attachments.length > 0 && <li><span className="dot good" /><span>{session.attachments.length} attachment{session.attachments.length === 1 ? "" : "s"}</span></li>}
      </ul>
      {active ? (
        <div className="small"><span className="dot run" /> The box is being made. The log on the left shows each step.</div>
      ) : (
        <div className="stack tight">
          <button className="pri" onClick={() => onInit(false)} disabled={busy} title="Clone the repositories, create the container, run the recipes and the setup worker">{session.readiness ? "Initialize again" : "Initialize"}</button>
          <button onClick={() => onInit(true)} disabled={busy || !ready} title={ready ? "Initialize, and work through the ready tickets when it succeeds" : "No ready tickets to start on"}>Initialize and start</button>
        </div>
      )}
      <button className="quiet sm" onClick={copyContext} title="Markdown describing this session, to paste into any assistant that helps you plan it">Copy context for an LLM</button>
      {msg && <div className="muted small">{msg}</div>}
    </section>
  );
};

/** While the box is being made: the steps, with the log under it telling the whole story. */
const InitProgress = ({ session }: { session: Session }) => {
  const cloned = session.repos.filter((r) => r.baseCommit);
  return (
    <section className="card stack tight">
      <h3><span className="dot run" /> Initializing the environment</h3>
      <ul className="checks small">
        <li className={cloned.length === session.repos.length ? "ok" : ""}>{session.repos.length ? `Repositories cloned: ${session.repos.map((r) => r.name).join(", ")}` : "No repositories to clone"}</li>
        <li>Container created from <span className="mono">{session.image}</span></li>
        {session.setupScripts.map((sc) => {
          const res = session.setup.find((x) => x.name === sc.name);
          return <li key={sc.name} className={res ? (res.ok ? "ok" : "err") : ""}>Recipe {sc.name}{res ? (res.ok ? ": ok" : `: failed, exit ${res.code}`) : ""}</li>;
        })}
        <li>{session.setupMode === "skip" ? "Setup worker skipped" : "Setup worker: reads the repositories and the board, installs what is missing, verifies the build and test commands, then reports"}</li>
      </ul>
    </section>
  );
};

/** The setup worker said the box needs you: the report, and the two ways on. */
const InitNeedsCard = ({ session, now, busy, onInit, onAccept }: { session: Session; now: number; busy: boolean; onInit: () => void; onAccept: () => void }) => (
  <section className="card attention stack tight">
    <h3>Initialization needs you</h3>
    <p className="lead" style={{ margin: 0 }}>The setup worker could not make the box ready on its own. Fix what it names (instructions, recipes, repositories) and initialize again, or accept the box as it is and start anyway.</p>
    <ReadinessView r={session.readiness!} now={now} open />
    <div className="row">
      <button className="pri" onClick={onInit} disabled={busy}>Initialize again</button>
      <button onClick={onAccept} disabled={busy} title="Count the environment as good enough: you dealt with the rest by hand, or it does not matter">Accept as is</button>
    </div>
  </section>
);

// --- plan tickets ---------------------------------------------------------

/** Your request for the planner: what to build. It becomes backlog tickets you approve. */
const PlanDialog = ({ session, busy, onCancel, onPlan }: { session: Session; busy: boolean; onCancel: () => void; onPlan: (text: string) => void }) => {
  const plans = session.prompts.filter((p) => p.kind === "plan");
  const [text, setText] = useState(plans.length ? "" : session.goal);
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [onCancel]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onCancel()} role="dialog" aria-modal="true" aria-labelledby="plan-title">
      <div className="dialog">
        <h3 id="plan-title">Plan tickets</h3>
        <p className="muted small" style={{ margin: 0 }}>Say what to build and what done looks like. A planner worker reads the repositories and the board, then adds tickets to the backlog for you to approve. It adds only what is missing when the board already has tickets.</p>
        <textarea id="plan" value={text} onChange={(e) => setText(e.target.value)} placeholder="Build the mapping engine: a layout editor, the mapping rules, and a mock MIDI output. Done means the editor round-trips a layout through the engine and the e2e suite covers it." style={{ minHeight: 140 }} autoFocus />
        {plans.length > 0 && (
          <details>
            <summary className="muted small">Earlier planning requests ({plans.length})</summary>
            {[...plans].reverse().map((p) => (
              <div key={p.at} className="small" style={{ borderTop: "1px solid var(--line)", paddingTop: 6, marginTop: 6 }}>
                <div className="muted">{fmtAgo(p.at)} · run {p.runId}</div>
                <div style={{ whiteSpace: "pre-wrap" }}>{p.text.slice(0, 600)}</div>
                {p.reply && <div className="muted" style={{ whiteSpace: "pre-wrap", marginTop: 4 }}>{p.reply.slice(0, 400)}</div>}
                <button className="quiet sm" onClick={() => setText(p.text)}>Use this again</button>
              </div>
            ))}
          </details>
        )}
        <div className="actions">
          <button onClick={onCancel}>Cancel</button>
          <button className="pri" onClick={() => onPlan(text)} disabled={busy || !text.trim()}>Plan</button>
        </div>
      </div>
    </div>
  );
};

// --- prompt box -------------------------------------------------------------

/** One worker, your text, the notes in front, no ticket: "make sure the e2e suite runs", "why is the dev server slow?". */
const PromptBox = ({ session, base, active, onDone }: { session: Session; base: string; active: boolean; onDone: () => Promise<void> }) => {
  const [text, setText] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [all, setAll] = useState(false);
  const send = async () => {
    setBusy(true);
    setMsg("");
    try {
      await api("POST", `${base}/run`, { action: "prompt", prompt: text });
      setText("");
      setMsg("Running; the reply appears here when the worker finishes.");
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
      await onDone();
    }
  };
  const shown = all ? [...session.prompts].reverse() : session.prompts.slice(-1);
  return (
    <section className="card stack" style={{ gap: 8 }}>
      <h3>Ask the box</h3>
      <p className="lead">One worker with your text, the brief and env.md, outside any ticket. It can install, configure and investigate; a repository change becomes one commit.</p>
      <textarea id="prompt" value={text} onChange={(e) => setText(e.target.value)} placeholder="Make sure you can run the e2e suite and the dev server, and update env.md." style={{ minHeight: 70 }} />
      <div className="row">
        <button className="pri sm" onClick={send} disabled={busy || active || !text.trim() || !isInitialized(session)} title={!isInitialized(session) ? "Initialize the session first" : active ? "Wait for the run to finish, or pause it" : "Run one worker with this prompt"}>Run prompt</button>
        <span className="muted small">{msg}</span>
      </div>
      {shown.map((p) => (
        <div key={p.at} className="small" style={{ borderTop: "1px solid var(--line)", paddingTop: 6 }}>
          <div className="muted">{fmtAgo(p.at)} · run {p.runId}{p.stopReason && p.stopReason !== "success" ? ` · ${p.stopReason}` : ""}</div>
          <div style={{ whiteSpace: "pre-wrap" }}><strong>{p.kind === "plan" ? "Plan:" : "You:"}</strong> {p.text.slice(0, 600)}</div>
          <div style={{ whiteSpace: "pre-wrap", marginTop: 4 }}><strong>Reply:</strong> {p.reply || "(no reply)"}</div>
        </div>
      ))}
      {session.prompts.length > 1 && <button className="quiet sm" onClick={() => setAll(!all)}>{all ? "Show the latest only" : `Show all ${session.prompts.length}`}</button>}
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

/** The session directory, with a button that copies `cd <dir>` for a terminal. */
const SessionDir = ({ dir }: { dir: string }) => {
  const [copied, setCopied] = useState(false);
  const cd = `cd ${/^[\w@%+=:,./-]+$/.test(dir) ? dir : `'${dir.replace(/'/g, `'\\''`)}'`}`;
  const copy = async () => {
    await copyText(cd);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button className="chip" onClick={() => void copy()} title={`Copy "${cd}"`}>
      <span className="mono">{dir.replace(/^\/Users\/[^/]+/, "~")}</span> {copied ? "· copied" : "· copy cd"}
    </button>
  );
};

/**
 * Off by default: nothing about a session leaves this machine until you tick
 * it. Turning it on says where the data goes.
 */
const RemoteToggle = ({ session, onSet }: { session: Session; onSet: (remote: boolean) => Promise<void> }) => {
  const [remote, setRemote] = useState<RemoteSettings | null>(null);
  useEffect(() => {
    api<RemoteSettings>("GET", "/remote").then(setRemote).catch(() => setRemote(null));
  }, []);
  const on = session.remote;
  if (!on && !remote?.enabled) return null;
  const where = remote?.baseUrl || "the remote dashboard";
  const toggle = () => {
    if (on) return void onSet(false);
    if (confirm(`Show "${session.name}" on ${where}?\n\nIts tickets (titles, specs, reports, notes), requests, your prompts to the box and a short activity log are sent there while Verstas runs, from initialization on. Tool output, file contents and diffs are not.`)) void onSet(true);
  };
  const plan = !session.initializedAt;
  return (
    <button className={`chip ${on ? "on" : ""}`} onClick={toggle} aria-pressed={on} title={on ? (plan ? `Shown on ${where} once initialized. Click to stop.` : `Shown on ${where}. Click to stop sending it.`) : `Not shared. Click to show this session on ${where}.`}>
      {on ? (plan ? "On remote dashboard once initialized" : "On remote dashboard") : "Remote dashboard: off"}
    </button>
  );
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

const ORDER = ["done", "review", "in_progress", "waiting", "blocked", "ready", "backlog"];
const ProgressStrip = ({ counts, total }: { counts: Record<string, number>; total: number }) => (
  <div className="stack" style={{ gap: 5 }}>
    <div className="progress" role="img" aria-label={ORDER.filter((k) => counts[k]).map((k) => `${counts[k]} ${STATE_LABEL[k]}`).join(", ")}>
      {ORDER.filter((k) => counts[k]).map((k) => <span key={k} className={k} style={{ width: `${((counts[k] ?? 0) / total) * 100}%` }} title={`${counts[k]} ${STATE_LABEL[k]}`} />)}
    </div>
    <div className="legend">{ORDER.filter((k) => counts[k]).map((k) => <span key={k} className={k}>{counts[k]} {STATE_LABEL[k]?.toLowerCase()}</span>)}</div>
  </div>
);

const MoreMenu = ({ items, label = "More ▾" }: { items: { label: string; onClick?: () => void; href?: string; disabled?: boolean }[]; label?: string }) => {
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
      <button onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open}>{label}</button>
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

const RequestItem = ({ r, onDecide, onOpenTicket }: { r: AgentRequest; onDecide: (rid: string, body: { answer?: string; actions?: { id: string; decision: "approve" | "decline"; note?: string }[]; declineAll?: boolean }) => void; onOpenTicket: (tid: string) => void }) => {
  const [answer, setAnswer] = useState("");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const open = r.actions.filter((a) => a.state === "open");
  const kinds = [...new Set(r.actions.map((a) => a.detail.kind))];
  const one = (a: RequestAction, decision: "approve" | "decline") => onDecide(r.id, { answer: answer || undefined, actions: [{ id: a.id, decision, note: notes[a.id] || undefined }] });
  return (
    <div className="req">
      <div className="head">
        <span className={`pill ${r.halt ? "warn" : "sig"}`}>{r.halt ? "halt" : kinds.length ? kinds.map((k) => k.replace("_", " ")).join(" · ") : "question"}</span>
        <strong style={{ color: "var(--text)" }}>{r.halt ? "The agent stopped the run" : `${r.actions.length} action${r.actions.length === 1 ? "" : "s"}, ${open.length} open`}</strong>
        {r.ticketId && <a href="#" onClick={(e) => { e.preventDefault(); onOpenTicket(r.ticketId!); }} className="mono">{r.ticketId}</a>}
        <span title={fmtDateTime(r.createdAt)}>{fmtTime(r.createdAt)}</span>
      </div>
      <div className="why" style={{ whiteSpace: "pre-wrap" }}>{r.summary}</div>
      {r.halt && <div className="err">{r.halt.severity}: {r.halt.reason}</div>}
      {r.actions.map((a) => {
        const d = a.detail;
        const l = ACTION_LABELS[d.kind] ?? { title: d.kind, yes: "Approve", no: "Decline", tone: "sig" };
        const decided = a.state !== "open";
        return (
          <div key={a.id} className={`action ${decided ? "decided" : ""}`}>
            <div className="row" style={{ gap: 8 }}>
              <span className={`pill ${l.tone}`}>{a.id} · {d.kind.replace("_", " ")}</span>
              <span className="muted small">{l.title}</span>
              {decided && <span className={`pill ${a.state === "approved" ? "good" : "quiet"} end`}>{a.state}</span>}
            </div>
            {d.kind === "network" && <div className="mono">allow {d.host}{d.port ? `:${d.port}` : ""} (HTTPS)</div>}
            {d.kind === "pack" && <div className="mono">allow the {d.pack} pack (HTTPS; the hosts are listed under Network on the New session form)</div>}
            {d.kind === "resources" && <div className="mono small">{(["workerMinutes", "workerTurns", "memoryMb"] as const).filter((k) => d[k] !== undefined).map((k) => `${k}: ${String(d[k])}`).join(" · ")}</div>}
            {(d.kind === "instruction" || d.kind === "question") && <div style={{ whiteSpace: "pre-wrap" }}>{d.text}</div>}
            {d.kind === "question" && d.options && !decided && (
              <div className="row" style={{ gap: 6 }}>
                {d.options.map((o) => <button key={o} className="sm" onClick={() => onDecide(r.id, { answer: answer || undefined, actions: [{ id: a.id, decision: "approve", note: o }] })}>{o}</button>)}
              </div>
            )}
            {decided && a.outcome && <pre className="mono small" style={{ whiteSpace: "pre-wrap", maxHeight: 160, overflow: "auto" }}>{a.outcome}</pre>}
            {!decided && (
              <div className="row">
                <input placeholder={d.kind === "question" ? "your answer (or pick an option above)" : d.kind === "instruction" ? "what you did (optional)" : "note (optional)"} value={notes[a.id] ?? ""} onChange={(e) => setNotes({ ...notes, [a.id]: e.target.value })} />
                <button className={l.tone === "warn" ? "warn sm" : "pri sm"} onClick={() => one(a, "approve")} disabled={d.kind === "question" && !(notes[a.id] ?? "").trim()}>{l.yes}</button>
                <button className="sm" onClick={() => one(a, "decline")}>{l.no}</button>
              </div>
            )}
          </div>
        );
      })}
      <textarea placeholder="Answer for the whole request (optional): context, decisions, anything the worker should know" value={answer} onChange={(e) => setAnswer(e.target.value)} style={{ minHeight: 48 }} />
      <div className="row">
        {r.actions.length === 0 && <button className="pri" onClick={() => onDecide(r.id, { answer: answer || undefined, actions: [] })} disabled={!r.halt && !answer.trim()}>{r.halt ? "Acknowledge" : "Answer"}</button>}
        {r.actions.length > 0 && answer.trim() && open.length > 0 && <button onClick={() => onDecide(r.id, { answer })}>Save answer</button>}
        {open.length > 0 && <button className="quiet sm end" onClick={() => onDecide(r.id, { answer: answer || undefined, declineAll: true })}>Decline all</button>}
      </div>
    </div>
  );
};

// --- board ------------------------------------------------------------------

/** "12m / 25m" against the worker cap, or the elapsed time alone in lead mode. Counted from the last state change, in the browser. */
const inProgressClock = (t: Ticket, clock: TicketView, now: number): string => {
  const secs = t.stateSince ? Math.max(0, (now - new Date(t.stateSince).getTime()) / 1000) : 0;
  return clock.capMinutes ? `${fmtSpan(secs)} / ${clock.capMinutes}m` : fmtSpan(secs);
};

/** "Took 42m · agent 31m · judging 3m · waiting on you 6m · requeued 2m"; the parts that are zero are left out. */
const timingLine = (x: { total: number; agent: number; judging: number; waitingOnYou: number; requeued: number }): string =>
  [`Took ${fmtSpan(x.total)}`, `agent ${fmtSpan(x.agent)}`, x.judging >= 1 ? `judging ${fmtSpan(x.judging)}` : "", x.waitingOnYou >= 1 ? `waiting on you ${fmtSpan(x.waitingOnYou)}` : "", x.requeued >= 1 ? `requeued ${fmtSpan(x.requeued)}` : ""].filter(Boolean).join(" · ");

/** What a ticket's timer is measured against: in loop mode the worker cap applies to one ticket; a lead's cap spans tickets, so there is none. */
type TicketView = { mode: "loop" | "lead"; capMinutes?: number; /** The session's review mode, for tickets that set none. */ review: ReviewMode };
const ticketClock = (session: Session): TicketView => ({ ...(session.mode === "lead" ? { mode: "lead" as const } : { mode: "loop" as const, capMinutes: session.caps.workerMinutes }), review: session.caps.reviewer ? "full" : "checks" });

const BoardView = ({ board, inbox, run, active, clock, openId, onOpen, onRetry, onApprove, onShowLog }: { board: Board; inbox: Inbox; run?: Run; active: boolean; clock: TicketView; openId: string | null; onOpen: (tid: string) => void; onRetry: (tid: string) => void; onApprove: (tid: string) => void; onShowLog: (tid: string) => void }) => {
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
                  <TicketCard key={t.id} t={t} clock={clock} doneIds={doneIds} request={t.state === "waiting" ? inbox.requests.find((r) => r.ticketId === t.id && r.state === "open") : undefined} active={Boolean(active && run?.currentTicket === t.id)} open={openId === t.id} onOpen={() => onOpen(t.id)} onRetry={() => onRetry(t.id)} onApprove={() => onApprove(t.id)} onShowLog={() => onShowLog(t.id)} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

const TicketCard = ({ t, clock, doneIds, request, active, open, onOpen, onRetry, onApprove, onShowLog }: { t: Ticket; clock: TicketView; doneIds: Set<string>; request?: AgentRequest; active: boolean; open: boolean; onOpen: () => void; onRetry: () => void; onApprove: () => void; onShowLog: () => void }) => {
  const depsDone = t.deps.filter((d) => doneIds.has(d)).length;
  const depsOk = depsDone === t.deps.length;
  const lastNote = t.notes[t.notes.length - 1];
  const now = useNow();
  const timing = t.state === "done" || t.state === "in_progress" ? ticketTiming(t, clock.mode, now) : null;
  return (
    <button className={`tk ${t.state} ${active ? "active" : ""} ${open ? "open" : ""}`} onClick={onOpen} aria-label={`${t.id} ${t.title}`}>
      <div className="id">
        <span>{t.id}</span>
        <span className="k">{t.kind}</span>
        <span className="k">{t.size}</span>
        {t.priority <= 2 && <span className="k" title={`priority ${t.priority}`}>p{t.priority}</span>}
        {t.pinned && <span className="pin" title="Pinned: the agent may not reprioritise it">⚲</span>}
        {t.review && t.review !== clock.review && <span className="k" title={`${REVIEW_LABEL[t.review]} (the session's is ${REVIEW_LABEL[clock.review].toLowerCase()})`}>{t.review === "none" ? "no review" : t.review === "checks" ? "checks" : "review"}</span>}
        {t.agent && <span className="k" title={`Runs on its own agent: ${t.agent.driver}${t.agent.model ? ` (${t.agent.model})` : ""}`}>{t.agent.driver}</span>}
      </div>
      <div className="title">{t.title}</div>
      {(t.deps.length > 0 || t.attempts > 0 || t.diff || active || timing) && (
        <div className="meta">
          {active && <span className="pill sig">working</span>}
          {timing && t.state === "in_progress" && <span className="pill quiet mono" title="Time on this ticket since it was claimed">{inProgressClock(t, clock, now)}</span>}
          {timing && t.state === "done" && <span className="pill quiet mono" title={timingLine(timing)}>{fmtSpan(timing.total)}</span>}
          {t.deps.length > 0 && <span className={`pill ${depsOk ? "quiet" : t.state === "ready" ? "sig" : "quiet"}`} title={`Depends on ${t.deps.join(", ")}`}>deps {depsDone}/{t.deps.length}</span>}
          {t.attempts > 1 && <span className="pill quiet">attempt {t.attempts}</span>}
          {t.diff && <span className="pill quiet mono">+{t.diff.added} −{t.diff.removed}</span>}
        </div>
      )}
      {t.state === "waiting" && <div className="why">Waiting for you: {request ? `${request.actions.filter((a) => a.state === "open").length || "an"} open ${request.actions.length ? "action" : "question"}${request.actions.filter((a) => a.state === "open").length === 1 ? "" : "s"}` : "an answer"}</div>}
      {t.state === "blocked" && lastNote && <div className="why warn">{lastNote.text.slice(0, 160)}{lastNote.text.length > 160 ? "…" : ""}</div>}
      {t.state === "blocked" && (
        <div className="act" onClick={(e) => e.stopPropagation()}>
          <button className="sm" onClick={onRetry}>Retry</button>
          <button className="quiet sm" onClick={onShowLog}>Log</button>
        </div>
      )}
      {t.state === "backlog" && (
        <div className="act" onClick={(e) => e.stopPropagation()}>
          <button className="sm" onClick={onApprove} title="Move to ready so the run can take it">Approve</button>
        </div>
      )}
    </button>
  );
};

// --- long actions ---------------------------------------------------------------

/** The busy labels that block the page with a modal while they run: exports take a while and must not be clicked twice. */
const EXPORT_MODAL: Record<string, { title: string; detail: string }> = {
  "exporting the session": { title: "Exporting session…", detail: "Bundling each clone inside the container and packing the settings, board, notes and run history into a .ver archive. Your browser saves it when it is ready." },
  exporting: { title: "Exporting bundles…", detail: "Bundling each repository's clone inside the container." },
};

/** A modal with a spinner and the time elapsed, for an action with no progress to report. */
const WorkingModal = ({ title, detail }: { title: string; detail: string }) => {
  const [start] = useState(Date.now());
  const now = useNow(1000);
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="working-title" aria-busy="true">
      <div className="dialog working">
        <div className="row" style={{ gap: 12 }}>
          <span className="spinner" aria-hidden="true" />
          <h3 id="working-title">{title}</h3>
          <span className="muted small mono end">{fmtSpan((now - start) / 1000)}</span>
        </div>
        <p className="muted small" style={{ margin: 0 }}>{detail}</p>
      </div>
    </div>
  );
};

// --- manual ticket ------------------------------------------------------------

/** The review choices; "" is the session's setting. */
const ReviewOptions = ({ sessionReviewer }: { sessionReviewer: boolean }) => (
  <>
    <option value="">Session default ({sessionReviewer ? "full review" : "checks only"})</option>
    <option value="full">Full review: checks and the reviewer</option>
    <option value="checks">Checks only: no reviewer</option>
    <option value="none">No review: accepted when the implementer finishes</option>
  </>
);

const NewTicketForm = ({ session, board, onCancel, onCreate }: { session: Session; board: Board; onCancel: () => void; onCreate: (body: Record<string, unknown>) => Promise<void> }) => {
  const [f, setF] = useState({ title: "", kind: "feature", repo: session.repos[0]?.name ?? "", size: "S", priority: "100", deps: "", state: "ready", spec: "", acceptance: "", agentDriver: "", agentModel: "", review: "" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const drivers = useDrivers();
  const submit = async () => {
    setErr("");
    setBusy(true);
    try {
      await onCreate({
        title: f.title.trim(),
        kind: f.kind,
        repo: f.repo || undefined,
        size: f.size,
        priority: Number(f.priority) || 100,
        deps: f.deps.split(/[,\s]+/).filter(Boolean),
        state: f.state,
        spec: f.spec,
        acceptance: f.acceptance.split(/\n/).map((x) => x.trim()).filter(Boolean),
        ...(f.agentDriver ? { agent: { driver: f.agentDriver, model: f.agentModel.trim() || undefined } } : {}),
        ...(f.review ? { review: f.review } : {}),
      });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const ids = board.tickets.map((t) => t.id);
  return (
    <section className="card stack" style={{ gap: 10 }}>
      <div className="row" style={{ justifyContent: "space-between" }}><h3>New ticket</h3><button className="quiet sm" onClick={onCancel}>Cancel</button></div>
      {err && <div className="banner warn"><span>{err}</span></div>}
      <div className="three">
        <label>Title<input id="nt-title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} autoFocus placeholder="Mapping engine: 14-bit CC pairs" /></label>
        <label>Kind<select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option>feature</option><option>bug</option><option>followup</option><option>chore</option></select></label>
        <label>Repository<select value={f.repo} onChange={(e) => setF({ ...f, repo: e.target.value })}><option value="">(none)</option>{session.repos.map((r) => <option key={r.name} value={r.name}>{r.name}</option>)}</select></label>
        <label>Size<select value={f.size} onChange={(e) => setF({ ...f, size: e.target.value })}><option>S</option><option>M</option><option>L</option></select></label>
        <label>
          Own agent <span className="help">Optional: a fresh worker on this agent does the ticket instead of the session's worker</span>
          <select value={f.agentDriver} onChange={(e) => setF({ ...f, agentDriver: e.target.value, agentModel: "" })}>
            <option value="">session's worker</option>
            {drivers.map((d) => <option key={d.name} value={d.name}>{d.title}{d.configured ? "" : " (no credential)"}</option>)}
          </select>
        </label>
        {f.agentDriver && (
          <label>
            Model <span className="help">Any id that CLI accepts; empty uses the account's default</span>
            <input className="mono" list="new-ticket-agent-models" value={f.agentModel} onChange={(e) => setF({ ...f, agentModel: e.target.value })} placeholder="account default" />
            <datalist id="new-ticket-agent-models">{(drivers.find((d) => d.name === f.agentDriver)?.models ?? []).map((m) => <option key={m} value={m} />)}</datalist>
          </label>
        )}
        <label>
          Review <span className="help">How the ticket is judged when it is submitted</span>
          <select value={f.review} onChange={(e) => setF({ ...f, review: e.target.value })}>
            <ReviewOptions sessionReviewer={session.caps.reviewer} />
          </select>
        </label>
        <label>Priority <span className="help">lower runs first</span><input type="number" min={0} max={1000} value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })} /></label>
        <label>Depends on <span className="help">ids, e.g. {ids.slice(-2).join(", ") || "T-1"}</span><input className="mono" value={f.deps} onChange={(e) => setF({ ...f, deps: e.target.value })} /></label>
      </div>
      <label>Spec <span className="help">What to do and where; a fresh agent reads only this, the acceptance criteria and the brief</span><textarea value={f.spec} onChange={(e) => setF({ ...f, spec: e.target.value })} style={{ minHeight: 120 }} /></label>
      <label>Acceptance criteria <span className="help">one per line, checkable by a reviewer</span><textarea value={f.acceptance} onChange={(e) => setF({ ...f, acceptance: e.target.value })} style={{ minHeight: 70 }} /></label>
      <div className="row">
        <label className="chk"><input type="radio" name="nt-state" checked={f.state === "ready"} onChange={() => setF({ ...f, state: "ready" })} /> Ready to run</label>
        <label className="chk"><input type="radio" name="nt-state" checked={f.state === "backlog"} onChange={() => setF({ ...f, state: "backlog" })} /> Backlog (approve later)</label>
        <button className="pri end" onClick={submit} disabled={busy || !f.title.trim()}>Create ticket</button>
      </div>
    </section>
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
  chores: "board",
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
    case "chores":
      return <>sweep {String(e.sweep)} {e.accepted ? `committed · ${String(e.done)} done, ${String(e.dropped)} dropped, ${String(e.promoted)} promoted` : "refused"} · {String(e.note)}</>;
    case "cost":
      return null;
    default:
      return <>{String(e.text ?? e.summary ?? JSON.stringify(e))}</>;
  }
};

// --- chores ----------------------------------------------------------------

/**
 * The chore list: small fixes filed by reviewers, workers and you, swept
 * by a lead in batches and committed without a reviewer (docs/BOARD.md).
 */
const ChoresPanel = ({ board, base, tryAct, onOpenTicket }: { board: Board; base: string; tryAct: (label: string, fn: () => Promise<unknown>) => Promise<unknown>; onOpenTicket: (tid: string) => void }) => {
  const [text, setText] = useState("");
  const [where, setWhere] = useState("");
  const chores = board.chores ?? [];
  const proposed = chores.filter((c) => c.state === "proposed");
  const open = chores.filter((c) => c.state === "open");
  const sweeping = chores.filter((c) => c.state === "sweeping");
  const settled = chores.filter((c) => c.state === "done" || c.state === "dropped" || c.state === "promoted").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const live = proposed.length + open.length + sweeping.length;
  const sweep = board.sweep;
  const add = async () => {
    if (!text.trim()) return;
    await tryAct("adding chore", () => api("POST", `${base}/chores`, { text: text.trim(), where: where.trim() || undefined }));
    setText("");
    setWhere("");
  };
  const row = (c: Chore) => (
    <div className="req" key={c.id}>
      <div className="head">
        <span className={`pill ${c.state === "sweeping" ? "sig" : c.state === "proposed" ? "warn" : c.state === "done" ? "good" : "quiet"}`}>{c.state}</span>
        <span className="mono muted">{c.id}</span>
        {c.fromTicket && <span className="small">from <a href="#" className="mono" onClick={(e) => { e.preventDefault(); onOpenTicket(c.fromTicket!); }}>{c.fromTicket}</a></span>}
        {c.promotedTo && <span className="small">→ <a href="#" className="mono" onClick={(e) => { e.preventDefault(); onOpenTicket(c.promotedTo!); }}>{c.promotedTo}</a></span>}
        <span className="faint" title={fmtDateTime(c.createdAt)}>{fmtAgo(c.createdAt)}</span>
      </div>
      <div className="wrap" style={{ fontSize: 13 }}>{c.text}{c.where ? <span className="muted"> · {c.where}</span> : null}</div>
      {c.outcome && <div className="wrap muted" style={{ fontSize: 12.5 }}>{c.outcome}</div>}
      {(c.state === "proposed" || c.state === "open") && (
        <div className="row">
          {c.state === "proposed" && <button className="sm pri" onClick={() => void tryAct("approving chore", () => api("POST", `${base}/chores/${c.id}/state`, { state: "open" }))}>Approve</button>}
          <button className="sm" onClick={() => void tryAct("promoting chore", () => api("POST", `${base}/chores/${c.id}/promote`, {}))}>Make a ticket</button>
          <button className="sm quiet" onClick={() => void tryAct("dropping chore", () => api("POST", `${base}/chores/${c.id}/state`, { state: "dropped", note: "Dropped by the user" }))}>Drop</button>
        </div>
      )}
    </div>
  );
  return (
    <section className="card">
      <h3>Chores{live ? ` · ${live}` : ""}</h3>
      <p className="lead">Small fixes that are not worth a ticket. A lead sweeps them in batches and the batch becomes one commit after the checks, with no reviewer.</p>
      {sweep && (sweep.state === "working" || sweep.state === "judging") && <div className="small"><span className="pill sig">sweep {sweep.n} {sweep.state}</span> {sweep.ids.join(", ")}</div>}
      {sweep && (sweep.state === "accepted" || sweep.state === "refused") && <div className="small muted"><span className={`pill ${sweep.state === "accepted" ? "good" : "warn"}`}>sweep {sweep.n} {sweep.state}</span> {sweep.note}</div>}
      {proposed.length > 0 && (
        <div className="row small" style={{ marginTop: 8 }}>
          <span><b>{proposed.length}</b> proposed by the workers wait for your approval.</span>
          <button className="sm end" onClick={() => void tryAct("approving chores", () => api("POST", `${base}/chores/approve-all`))}>Approve all</button>
        </div>
      )}
      {sweeping.map(row)}
      {proposed.map(row)}
      {open.map(row)}
      <div className="row" style={{ marginTop: 8 }}>
        <input placeholder="A small fix, one line" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void add(); }} style={{ flex: 2 }} />
        <input placeholder="where (optional)" value={where} onChange={(e) => setWhere(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void add(); }} style={{ flex: 1 }} />
        <button className="sm" onClick={() => void add()} disabled={!text.trim()}>Add</button>
      </div>
      {settled.length > 0 && (
        <details style={{ marginTop: 8 }}>
          <summary className="muted small">{settled.length} settled</summary>
          <div className="decided">{settled.slice(0, 50).map(row)}</div>
        </details>
      )}
    </section>
  );
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
                <span className={`pill ${r.actions.some((a) => a.state === "approved") ? "good" : "quiet"}`}>{r.actions.length ? `${r.actions.filter((a) => a.state === "approved").length}/${r.actions.length} approved` : r.halt ? "halt" : "answered"}</span>
                <span>{[...new Set(r.actions.map((a) => a.detail.kind.replace("_", " ")))].join(", ") || (r.halt ? "halt" : "question")}</span>
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

const requestSummary = (r: AgentRequest): string => r.summary.split("\n")[0]!.slice(0, 120);

// --- settings --------------------------------------------------------------

type SettingsPatch = { allowlist?: string[]; packs?: string[]; caps?: Partial<Session["caps"]>; limits?: Partial<Session["limits"]>; mode?: Session["mode"]; planning?: Session["planning"] | null };

/** What each ticket size means; mirrors TICKET_SIZE_GUIDE in src/core/types.ts. */
const TICKET_SIZE_HELP: Record<"S" | "M" | "L", string> = {
  S: "one change in one place; under ~150 lines, under 15 min of agent time",
  M: "one feature slice with its follow-ups folded in; ~150–800 lines, 15–45 min",
  L: "a whole feature one reviewer can still judge in one pass; ~800–2,000 lines, 45–120 min",
};
const CAP_HELP: Record<string, string> = {
  workerMinutes: "Wall-clock cap for one worker",
  workerTurns: "Model turns per worker",
  budgetUsd: "Spend cap per worker",
  runTickets: "Tickets per run before it pauses",
  ticketAttempts: "Tries before a ticket is blocked",
  leadMinutes: "Wall-clock life of one lead; then a fresh one takes over",
  leadTurns: "Model turns per lead; then a fresh one takes over",
  sweepMaxLines: "A chore sweep's commit may change at most this many lines; over it the sweep is refused",
  sweepMaxFiles: "Files a chore sweep's commit may touch",
  choreSweepAt: "Open chores at which the lead must sweep before its next ticket (0: never forced)",
};

/**
 * Network, caps and limits. The run view folds them into one details card;
 * the plan's setup sheet shows the network and the caps as separate cards,
 * each saving its own half.
 */
const SessionSettings = ({ session, onSave, part = "all" }: { session: Session; onSave: (patch: SettingsPatch) => Promise<void>; part?: "all" | "network" | "caps" }) => {
  const fromSession = () => ({
    allow: session.allowlist.join("\n"),
    packs: session.packs,
    workerMinutes: String(session.caps.workerMinutes),
    workerTurns: String(session.caps.workerTurns),
    budgetUsd: String(session.caps.budgetUsd),
    runTickets: String(session.caps.runTickets),
    ticketAttempts: String(session.caps.ticketAttempts),
    reviewer: session.caps.reviewer,
    resumeWorker: session.caps.resumeWorker ?? false,
    mode: session.mode ?? "loop",
    leadMinutes: String(session.caps.leadMinutes ?? 180),
    leadTurns: String(session.caps.leadTurns ?? 600),
    sweepMaxLines: String(session.caps.sweepMaxLines ?? 400),
    sweepMaxFiles: String(session.caps.sweepMaxFiles ?? 15),
    choreSweepAt: String(session.caps.choreSweepAt ?? 10),
    choreApproval: session.caps.choreApproval ?? false,
    memory: session.limits.memory,
    cpus: String(session.limits.cpus),
    ticketSize: (session.planning?.ticketSize ?? "") as "" | "S" | "M" | "L",
    sizeGuidance: session.planning?.guidance ?? "",
  });
  const [f, setF] = useState(fromSession);
  const [state, setState] = useState<"clean" | "dirty" | "saving" | "saved" | "error">("clean");
  const [msg, setMsg] = useState("");
  const [packList, setPackList] = useState<NetworkPack[]>([]);
  useEffect(() => {
    api<NetworkPack[]>("GET", "/network/packs").then(setPackList).catch(() => setPackList([]));
  }, []);
  useEffect(() => {
    setF(fromSession());
    setState("clean");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.allowlist, session.packs, session.caps, session.limits, session.mode, session.planning]);
  const set = <K extends keyof ReturnType<typeof fromSession>>(k: K, v: ReturnType<typeof fromSession>[K]) => {
    setF({ ...f, [k]: v });
    setState("dirty");
  };
  const save = async () => {
    setState("saving");
    try {
      await onSave({
        ...(part !== "caps" ? { allowlist: f.allow.split(/\n/).map((s) => s.trim()).filter(Boolean), packs: f.packs } : {}),
        ...(part !== "network"
          ? {
              caps: { workerMinutes: Number(f.workerMinutes), workerTurns: Number(f.workerTurns), budgetUsd: Number(f.budgetUsd), runTickets: Number(f.runTickets), ticketAttempts: Number(f.ticketAttempts), reviewer: f.reviewer, resumeWorker: f.resumeWorker, leadMinutes: Number(f.leadMinutes), leadTurns: Number(f.leadTurns), sweepMaxLines: Number(f.sweepMaxLines), sweepMaxFiles: Number(f.sweepMaxFiles), choreApproval: f.choreApproval, choreSweepAt: Number(f.choreSweepAt) },
              limits: { memory: f.memory, cpus: Number(f.cpus) },
              mode: f.mode,
              // Nothing chosen clears the block: planning agents then size tickets themselves, as before.
              planning: f.ticketSize || f.sizeGuidance.trim() ? { ticketSize: f.ticketSize || undefined, guidance: f.sizeGuidance.trim() || undefined } : null,
            }
          : {}),
      });
      setState("saved");
      setMsg("");
    } catch (e) {
      setState("error");
      setMsg((e as Error).message);
    }
  };
  const body = (
    <div className="stack" style={{ marginTop: part === "all" ? 12 : 0 }}>
      {part !== "caps" && (
        <div>
          <div className="small"><strong>Network packs</strong> <span className="muted">the toolchains the box may download from; the chosen agents' backends are always on</span></div>
          <div className="packs" style={{ marginTop: 6 }}>
            {packList.filter((p) => !p.agent).map((p) => (
              <label className="chk" key={p.name} title={p.hosts.join("\n")}>
                <input type="checkbox" checked={f.packs.includes(p.name)} onChange={(e) => set("packs", e.target.checked ? [...f.packs, p.name] : f.packs.filter((n) => n !== p.name))} />
                <strong>{p.name}</strong> <span className="muted">{p.title}</span>
              </label>
            ))}
          </div>
        </div>
      )}
      {part !== "caps" && (
        <label>
          Network allowlist <span className="help">Every host the proxy allows, one per line, HTTPS only; *.suffix allowed. Applies live. Packs rebuild their part on save.</span>
          <textarea id="allow" className="mono" value={f.allow} onChange={(e) => set("allow", e.target.value)} />
        </label>
      )}
      {part !== "network" && (
        <label>
          How tickets are worked
          <span className="help">{f.mode === "lead" ? "One lead agent works the board: it picks the order, claims and submits tickets, and hands over to a fresh lead when its context gets noisy. Every ticket is still judged and committed by Verstas." : "Verstas picks each ready ticket and starts a fresh implementer for it."} Applies to the next run.</span>
          <select value={f.mode} onChange={(e) => set("mode", e.target.value as "loop" | "lead")}>
            <option value="loop">One worker per ticket</option>
            <option value="lead">A lead works the board</option>
          </select>
        </label>
      )}
      {part !== "network" && (
        <div className="two">
          <label>
            Ticket size
            <span className="help" title="Every ticket pays a fixed cost (a worker reads in, the check runs, a reviewer reads in, a commit), so fewer, larger tickets run faster.">What the planner and agent terminals aim for. {f.ticketSize ? `${TICKET_SIZE_HELP[f.ticketSize]}.` : "Not set: they choose."}{f.ticketSize === "L" && f.mode !== "lead" && Number(f.workerMinutes) < 60 ? " Raise worker minutes to 60+ for L." : ""}</span>
            <select value={f.ticketSize} onChange={(e) => set("ticketSize", e.target.value as "" | "S" | "M" | "L")}>
              <option value="">Not set</option>
              <option value="S">S · small</option>
              <option value="M">M · medium</option>
              <option value="L">L · large</option>
            </select>
          </label>
          <label>
            How to cut the work <span className="help">Optional, in your words.</span>
            <input value={f.sizeGuidance} placeholder="e.g. one species per ticket" onChange={(e) => set("sizeGuidance", e.target.value)} />
          </label>
          {f.mode === "lead" &&
            (["leadMinutes", "leadTurns", "sweepMaxLines", "sweepMaxFiles", "choreSweepAt"] as const).map((k) => (
              <label key={k}>
                {{ leadMinutes: "Lead minutes", leadTurns: "Lead turns", sweepMaxLines: "Chore sweep: max lines", sweepMaxFiles: "Chore sweep: max files", choreSweepAt: "Chores: sweep at" }[k]}
                <span className="help">{CAP_HELP[k]}</span>
                <input type="number" min={k === "choreSweepAt" ? 0 : 1} value={f[k]} onChange={(e) => set(k, e.target.value)} />
              </label>
            ))}
          {(["workerMinutes", "workerTurns", "budgetUsd", "runTickets", "ticketAttempts"] as const).map((k) => (
            <label key={k}>
              {{ workerMinutes: "Worker minutes", workerTurns: "Worker turns", budgetUsd: "Budget USD per worker", runTickets: "Tickets per run", ticketAttempts: "Attempts per ticket" }[k]}
              <span className="help">{CAP_HELP[k]}</span>
              <input type="number" min={1} value={f[k]} onChange={(e) => set(k, e.target.value)} />
            </label>
          ))}
          <div style={{ alignSelf: "end", display: "grid", gap: 6 }}>
          <label className="chk"><input type="checkbox" checked={f.reviewer} onChange={(e) => set("reviewer", e.target.checked)} /> Reviewer pass after each ticket</label>
          <label className="chk" title="Chores filed by reviewers and workers wait for your approval before a sweep may take them. Off: they are swept as they come."><input type="checkbox" checked={f.choreApproval} onChange={(e) => set("choreApproval", e.target.checked)} /> Approve workers' chores before they are swept</label>
          {f.mode !== "lead" && <label className="chk" title="Claude Code only. The next ticket's implementer continues the previous one's conversation instead of re-reading the repositories. The reviewer always starts fresh."><input type="checkbox" checked={f.resumeWorker} onChange={(e) => set("resumeWorker", e.target.checked)} /> Implementers continue one conversation</label>}
          </div>
          <label>Memory <span className="help">Container limit, e.g. 4g</span><input value={f.memory} onChange={(e) => set("memory", e.target.value)} /></label>
          <label>CPUs<input type="number" step="0.5" min={0.5} value={f.cpus} onChange={(e) => set("cpus", e.target.value)} /></label>
        </div>
      )}
      <div className="save-row">
          <button className="pri" onClick={save} disabled={state !== "dirty" && state !== "error"}>Save</button>
          {state === "dirty" && <button className="quiet" onClick={() => { setF(fromSession()); setState("clean"); }}>Discard</button>}
          <span className={`state ${state === "saved" ? "ok" : state === "error" ? "err" : ""}`}>{state === "saving" ? "Saving…" : state === "saved" ? "Saved" : state === "error" ? msg : state === "dirty" ? "Unsaved changes" : ""}</span>
        </div>
      {part !== "network" && session.rootScripts.length > 0 && (
        <div className="small muted">
          Root scripts approved before the agent had sudo: {session.rootScripts.map((c) => <code key={c.at} style={{ marginRight: 6 }}>{c.script.split("\n")[0]!.slice(0, 60)}</code>)}. Replayed if the container is recreated without a snapshot.
        </div>
      )}
      {part !== "network" && <div className="small faint mono">{session.image} · {session.id}</div>}
    </div>
  );
  if (part !== "all") return body;
  return (
    <details className="card">
      <summary><strong>Session settings</strong><span className="muted small">network, caps, limits</span></summary>
      {body}
    </details>
  );
};

// --- drawer ------------------------------------------------------------------

const TicketDrawer = ({ ticket, board, clock, held, sessionId, onClose, onOpen, onAction, onShowLog }: { ticket: Ticket; board: Board; clock: TicketView; held: boolean; sessionId: string; onClose: () => void; onOpen: (tid: string) => void; onAction: (label: string, fn: () => Promise<unknown>) => Promise<void>; onShowLog: () => void }) => {
  const [note, setNote] = useState("");
  const neededBy = board.tickets.filter((t) => t.deps.includes(ticket.id));
  const now = useNow();
  const timing = ticketTiming(ticket, clock.mode, now);
  const drawerTiming = !timing ? "" : ticket.state === "done" ? timingLine(timing) : ticket.state === "in_progress" ? `Working for ${inProgressClock(ticket, clock, now)} · ${fmtSpan(timing.total)} since the first claim` : "";
  const [edit, setEdit] = useState(false);
  const toDraft = (t: Ticket) => ({ title: t.title, spec: t.spec, acceptance: t.acceptance.join("\n"), priority: t.priority, size: t.size, repo: t.repo ?? "", deps: t.deps.join(", "), agentDriver: t.agent?.driver ?? "", agentModel: t.agent?.model ?? "", review: t.review ?? "" });
  const [draft, setDraft] = useState(toDraft(ticket));
  const drivers = useDrivers();
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
        agent: draft.agentDriver ? { driver: draft.agentDriver, model: draft.agentModel.trim() || undefined } : null,
        review: draft.review || null,
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
        {drawerTiming && <div className="facts mono" title="From the first claim; agent time in lead mode is the lead's time on the ticket plus the reviewer's">{drawerTiming}</div>}
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
          {ticket.review && <span title="Set by you for this ticket">{REVIEW_LABEL[ticket.review].toLowerCase()}</span>}
          {ticket.agent && <span title="This ticket's implementer runs on its own agent; the reviewer stays the session's">agent <b>{ticket.agent.driver}</b>{ticket.agent.model ? <span className="mono"> {ticket.agent.model}</span> : null}</span>}
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
              <label>
                Own agent <span className="help">Optional: this ticket's implementer runs on this agent instead of the session's worker (a fresh worker; the reviewer stays the session's). In lead mode the lead hands it over with board_run.</span>
                <select value={draft.agentDriver} onChange={(e) => setDraft({ ...draft, agentDriver: e.target.value, agentModel: "" })}>
                  <option value="">session's worker</option>
                  {drivers.map((d) => <option key={d.name} value={d.name}>{d.title}{d.configured ? "" : " (no credential)"}</option>)}
                </select>
              </label>
              {draft.agentDriver && (
                <label>
                  Model <span className="help">Any id that CLI accepts; empty uses the account's default</span>
                  <input className="mono" list="ticket-agent-models" value={draft.agentModel} onChange={(e) => setDraft({ ...draft, agentModel: e.target.value })} placeholder="account default" />
                  <datalist id="ticket-agent-models">{(drivers.find((d) => d.name === draft.agentDriver)?.models ?? []).map((m) => <option key={m} value={m} />)}</datalist>
                </label>
              )}
              <label>
                Review <span className="help">How the ticket is judged when it is submitted. Only you set this; agents' tickets take the session's.</span>
                <select value={draft.review} onChange={(e) => setDraft({ ...draft, review: e.target.value })}>
                  <ReviewOptions sessionReviewer={clock.review === "full"} />
                </select>
              </label>
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

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  api,
  inboxCleared,
  repoChange,
  repoOrigin,
  type ReposState,
  type RepoState,
  type PublishPreview,
  type PullRecord,
  type CommitLine,
  type RemoteSettings,
  copyText,
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
  normalizeReviewMode,
  STATE_LABEL,
  ticketTiming,
  upload,
  useLive,
  useNow,
  type AgentRequest,
  type Board,
  type Config,
  type Inbox,
  type NetworkPack,
  type ReviewMode,
  type Run,
  type Sandbox,
  type Session,
  type SessionDetail,
  type SetupScript,
  type Ticket,
  type Totals,
  type VEvent,
  type RepoSpec,
} from "../api";
import { AgentOptionsButton, useDrivers } from "./AgentOptions";
import { AgentTerminal, ArtifactPills } from "./Terminal";
import { ImportCard } from "./session/ImportCard";
import { publishAllSummary, publishRowText, usePublishAll } from "./session/publishAll";

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
    if (!isInitialized(session)) return { label: "initializing the environment", tone: "sig" };
    if (run?.state === "paused") return { label: `pausing · ${PAUSE_REASON[run.pauseReason ?? ""] ?? run.pauseReason ?? ""}`, tone: "sig" };
    return { label: run?.currentTicket ? `working on ${run.currentTicket}` : "running", tone: "sig" };
  }
  if (!isInitialized(session)) {
    return { label: "not initialized", tone: "quiet" };
  }
  switch (session.state) {
    case "created":
    case "setup":
      return { label: "not started", tone: "quiet" };
    case "finished":
      return { label: session.goalMet ? "goal met, says the lead" : "finished", tone: "good" };
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
  const [importOpen, setImportOpen] = useState(false);
  const [exportInfo, setExportInfo] = useState<string[] | null>(null);
  const [newTicket, setNewTicket] = useState(false);
  const [busy, setBusy] = useState("");
  const [logTicket, setLogTicket] = useState("");
  const [lastEventAt, setLastEventAt] = useState<string | null>(null);
  const [dir, setDir] = useState("");
  /** The agent terminal's run while its pane is open; it stays open after the terminal ends until you close it. */
  const [terminalPane, setTerminalPane] = useState<{ run: number; driver: "claude" | "codex" | "cursor" } | null>(null);
  const drivers = useDrivers();
  const now = useNow();

  const base = `/sessions/${encodeURIComponent(id)}`;
  const repoState = useRepoState(base, session, active, board?.tickets.filter((t) => t.state === "done").length ?? 0);
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
  /** Initialize: clone the repositories, create the container, run the recipes; with start, the lead follows. */
  const init = (start: boolean) => tryAct(start ? "initializing and starting" : "initializing", () => api("POST", `${base}/init`, { start }));
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
  const timings = board.tickets.map((t) => ticketTiming(t, now)).filter((x) => x !== null);
  const waitingOnYou = timings.length ? timings.reduce((sum, x) => sum + x.waitingOnYou, 0) : null;
  const status = sessionStatus(session, run, active);
  const sb = sandboxLabel(sandbox);
  const lastActivity = lastEventAt && lastEventAt > (totals?.lastActivityAt ?? "") ? lastEventAt : totals?.lastActivityAt;
  const pausedBanner = !active && run && (run.state === "paused" || run.state === "halted" || run.state === "failed") && session.state !== "finished";
  const initialized = isInitialized(session);
  const terminalActive = Boolean(active && run?.terminal);
  const saveSettings = async (patch: SettingsPatch) => {
    if (patch.allowlist || patch.packs) await api("PUT", `${base}/allowlist`, { allowlist: patch.allowlist, packs: patch.packs });
    if (patch.caps || patch.limits) await api("PUT", `${base}/caps`, { caps: patch.caps, limits: patch.limits });
    await refreshRun();
  };
  /** Every ticket off the board, after a confirm; Export board first keeps a copy. */
  const clearBoard = () => {
    const what = `${board.tickets.length} ticket${board.tickets.length === 1 ? "" : "s"}`;
    if (!confirm(`Delete all ${what} from "${session.name}"?\n\nThe goal and the repositories stay. This cannot be undone; Export board (JSON) keeps a copy.`)) return;
    void tryAct("clearing the board", () => api("POST", `${base}/board/clear`));
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
    onImport: () => setImportOpen(true),
    onNewTicket: () => setNewTicket(true),
    onExport: doExport,
    onInit: init,
    saveSettings,
    repoState,
  };

  return (
    <div className="stack" style={{ gap: 16 }}>
      <header className="sess-head">
        <div className="sess-title">
          <h1>{session.name}</h1>
          <span className={`pill ${status.tone}`}>{active ? <span className="dot run" /> : null}{status.label}</span>
          <div className="actions">
            {initialized && !active && <button className="pri" onClick={() => runAction("start")} disabled={Boolean(busy)} title={session.goalMet ? "Start again with the same goal: the lead takes that as not yet and looks for what falls short" : "One lead works the goal and the board's ready tickets; Verstas judges what it moves to review and commits what it leaves"}>{session.goalMet ? "Start again" : "Start run"}</button>}
            {terminalActive && <ConfirmButton className="pri" label="Start run" confirm="End the terminal and start" onConfirm={() => runAction("start")} disabled={Boolean(busy)} />}
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
            {active && !terminalActive && <button onClick={() => runAction("pause")} disabled={Boolean(busy)} title="The lead is told to reach a sensible point, update its note and stop; what it leaves is committed">Pause</button>}
            {active && !terminalActive && <button className="warn" onClick={() => runAction("stop")} disabled={Boolean(busy)} title="Stop the lead now; its tickets go back to ready with the work kept">Stop now</button>}
            {initialized && <button onClick={() => setNewTicket(true)} disabled={Boolean(busy)} title="Write a ticket by hand">New ticket</button>}
            <MoreMenu
              items={[
                { label: "Import tickets…", onClick: () => setImportOpen(true) },
                { label: "Export board (JSON)", href: `/api${base}/board/export` },
                ...(board.tickets.length > 0 ? [{ label: active ? "Clear board (stop the run first)" : "Clear board…", onClick: clearBoard, disabled: active }] : []),
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
          {initialized && board.tickets.length > 0 && <span><b>{done}/{board.tickets.length}</b> done</span>}
          {initialized && run?.rounds ? <span title="Lead lives: one lead from start to exit, then a commit of what it left"><b>{run.rounds}</b> {run.rounds === 1 ? "life" : "lives"}{active ? " this run" : ` in run ${run.id}`}</span> : null}
          {initialized && waitingOnYou !== null && <span title="Time tickets spent waiting for your answers, summed over the board: how unattended the loop is">waiting on you <b>{fmtSpan(waitingOnYou)}</b></span>}
          {initialized && <span><b>{fmtUsd(totals?.usd ?? 0)}</b> spent{totals && totals.runs > 1 ? ` over ${totals.runs} runs` : ""}{active && run?.cost.usd ? ` · ${fmtUsd(run.cost.usd)} this run` : ""}</span>}
          {run && active && <span>running for <b>{fmtDuration(run.startedAt, undefined, now)}</b></span>}
          {initialized && lastActivity && !active && <span>last activity <b title={fmtDateTime(lastActivity)}>{fmtAgo(lastActivity, now)}</b></span>}
          <span>created <b title={fmtDateTime(session.createdAt)}>{fmtAgo(session.createdAt, now)}</b></span>
          {initialized && <span className={sb.tone === "good" ? "ok" : ""}>{sb.text}</span>}
          {initialized && (session.repos.length ? <RepoChips state={repoState.state} names={session.repos.map((r) => r.name)} /> : <span>no repositories</span>)}
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
          <p className="lead">The lead parked the ticket a request is about and carries on with the rest; a request about the goal pauses the run until you answer.</p>
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

      {importOpen && (
        <ImportCard
          base={base}
          tickets={board.tickets.length}
          currentGoal={session.goal}
          busy={Boolean(busy)}
          onCancel={() => setImportOpen(false)}
          onDone={(text) => {
            setImportOpen(false);
            setNotice(text);
          }}
        />
      )}

      {!active && (counts.backlog ?? 0) > 0 && (
        <div className="banner signal">
          <span><b>{counts.backlog}</b> ticket{counts.backlog === 1 ? "" : "s"} in the backlog wait for your approval. The lead works ready tickets.</span>
          <button className="pri sm end" onClick={() => tryAct("approving", () => api("POST", `${base}/tickets/approve-all`))} disabled={Boolean(busy)}>Approve all</button>
        </div>
      )}

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

      {terminalPane === null && <ArtifactPills base={base} live={active} card />}

      {initialized ? <RunBody {...bodyProps} /> : <PlanBody {...bodyProps} />}

      {ticketId && !ticket && <div className="banner warn"><span>No ticket {ticketId} on this board.</span><button className="quiet sm end" onClick={() => openTicket(null)}>Close</button></div>}
      {ticket && (
        <TicketDrawer
          ticket={ticket}
          board={board}
          repoNames={session.repos.map((r) => r.name)}
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
  onInit: (start: boolean) => void;
  saveSettings: (patch: SettingsPatch) => Promise<void>;
  repoState: RepoStateHandle;
};

const useBoardActions = (p: BodyProps) => ({
  onRetry: (tid: string) => void p.tryAct("retrying", () => api("POST", `${p.base}/tickets/${tid}/state`, { state: "ready" })),
  onApprove: (tid: string) => void p.tryAct("approving", () => api("POST", `${p.base}/tickets/${tid}/state`, { state: "ready", note: "Approved" })),
});

const SessionLog = (p: BodyProps) => (
  <>
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
    {p.active && <WorkerMessageBox base={p.base} />}
  </>
);

/**
 * A line to the worker running now. It lands in the agent's conversation
 * as "Message from the user: …" and the reply shows up in the log as
 * worker text; nothing on the board changes. For "why is this taking so
 * long" and "is the setup wrong", not for new work (that is a ticket).
 */
const WorkerMessageBox = ({ base }: { base: string }) => {
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (!text.trim()) return;
    setBusy(true);
    setNote("");
    try {
      const r = await api<{ to: string }>("POST", `${base}/run/message`, { text });
      setText("");
      setNote(`Sent to the ${r.to}; its reply appears in the log.`);
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="row" style={{ gap: 6, marginTop: 6, alignItems: "flex-start" }}>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send(); }}
        placeholder="Message the running worker: why is this taking so long?"
        title="Reaches the worker running now as a user message in its conversation. Not for new work: that is a ticket."
        style={{ minHeight: 36, flex: 1 }}
        maxLength={10_000}
      />
      <button className="sm" onClick={() => void send()} disabled={busy || !text.trim()} title="Send (⌘↵)">Send</button>
      {note && <span className="muted small">{note}</span>}
    </div>
  );
};

/**
 * The box exists: the repositories and their pull requests on top, then the
 * board and the live log with the inbox beside them. The goal, the
 * environment and the settings fold away; they still apply to the next
 * worker.
 */
const RunBody = (p: BodyProps) => {
  const { session, board, inbox, base, active, run, counts } = p;
  const env = useEnvironment(session, base, active, p.refreshRun);
  const { onRetry, onApprove } = useBoardActions(p);
  return (
    <>
    <RepoStrip session={session} base={base} active={active} done={counts.done ?? 0} repoState={p.repoState} onExport={p.onExport} onDone={async () => { await p.refreshRun(); await p.repoState.refresh(); }} />
    <div className="sess-body">
      <div className="main">
        <GoalPanel session={session} base={base} active={active} run={run} onDone={p.refreshRun} fold />
        {board.tickets.length === 0 ? (
          <div className="card empty-state">
            <h3>No tickets</h3>
            <p>The lead works toward the goal above and may write tickets of its own. Paste a board, write tickets by hand, or plan them with the agent terminal.</p>
            <div className="row">
              <button onClick={p.onImport}>Import tickets…</button>
              <button onClick={p.onNewTicket} disabled={Boolean(p.busy)}>New ticket</button>
            </div>
          </div>
        ) : (
          <BoardView board={board} inbox={inbox} run={run} active={active} clock={ticketClock(session)} openId={p.ticketId} onOpen={p.openTicket} onRetry={onRetry} onApprove={onApprove} onShowLog={p.setLogTicket} />
        )}
        <SessionLog {...p} />
      </div>
      <aside className="side">
        <InboxPanel inbox={inbox} onClear={() => void p.tryAct("clearing the inbox", () => api("POST", `${base}/inbox/clear`))} onRead={(mid) => void p.tryAct("read", () => api("POST", `${base}/messages/${mid}/read`))} onPromote={(iid) => void p.tryAct("promote", () => api("POST", `${base}/ideas/${iid}/promote`))} onOpenTicket={p.openTicket} />
        <PromptBox session={session} base={base} active={active} onDone={p.refreshRun} />
        <EnvironmentPanel env={env} />
        <SessionSettings session={session} onSave={p.saveSettings} />
      </aside>
    </div>
    </>
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
              <p className="lead" style={{ margin: 0 }}>Cloned fresh at initialization, at the branch chosen here. The lead commits on a branch of its own; Publish PR takes it to GitHub.</p>
              <RepoSection env={env} bare />
            </section>

            <GoalPanel session={session} base={base} active={active} run={run} onDone={p.refreshRun} />
            <section className="stack tight">
                <SheetHead title="Board" mark={total ? `${total} ticket${total === 1 ? "" : "s"} · ${ready} ready` : "empty"} tone={ready ? "good" : total ? "info" : "quiet"}>
                  <button className="sm" onClick={p.onImport} disabled={Boolean(p.busy)}>Import board…</button>
                  <button className="sm" onClick={p.onNewTicket} disabled={Boolean(p.busy)}>New ticket</button>
                </SheetHead>
                {total === 0 ? (
                  <div className="card empty-state">
                    <h3>No tickets yet</h3>
                    <p>Paste a board or write tickets by hand, or initialize and plan them with the agent terminal, which reads the repositories. With a goal written above, the lead can start without tickets.</p>
                  </div>
                ) : (
                  <BoardView board={board} inbox={inbox} run={run} active={active} clock={ticketClock(session)} openId={p.ticketId} onOpen={p.openTicket} onRetry={onRetry} onApprove={onApprove} onShowLog={p.setLogTicket} />
                )}
              </section>

            <section className="card stack" style={{ gap: 10 }}>
              <SheetHead title="Environment" mark={`${session.setupScripts.length} recipe${session.setupScripts.length === 1 ? "" : "s"}`} tone="quiet" />
              <p className="lead" style={{ margin: 0 }}>Initialize creates the container and runs the recipes you tick. Everything else the lead installs itself as it goes; the box is committed to an image after every run, so its installs stay.</p>
              <RecipeSection env={env} />
              <Divider />
              <AttachmentSection env={env} />
              {hasNotes(env) && (
                <>
                  <Divider />
                  <div className="muted small">Left from an earlier box; the next lead reads them.</div>
                  <NotesSection env={env} />
                </>
              )}
            </section>

            <section className="card stack" style={{ gap: 10 }}>
              <SheetHead title="Network" mark={session.packs.length ? `${session.packs.length} pack${session.packs.length === 1 ? "" : "s"}` : "agents' backends only"} tone="quiet" />
              <SessionSettings session={session} onSave={p.saveSettings} part="network" />
            </section>

            <section className="card stack" style={{ gap: 10 }}>
              <SheetHead title="Agents, review and limits" mark="the lead and the reviewer" tone="quiet" />
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

type RepoStateHandle = { state: ReposState | null; loading: boolean; error: string; refresh: (start?: boolean) => Promise<void> };

/**
 * Each repository's state (src/sessions/repo-state.ts): read when the page
 * opens, when a ticket is done or the base moves, and every 20 s while a
 * run is active. A stopped container gives the last reading; refreshing
 * with `start` brings the container up to read it now.
 */
const useRepoState = (base: string, session: Session | null, active: boolean, done: number): RepoStateHandle => {
  const [state, setState] = useState<ReposState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const initialized = session ? isInitialized(session) : false;
  const key = session ? session.repos.map((r) => `${r.name}:${r.branch}:${r.baseCommit ?? ""}`).join(",") : "";
  const refresh = async (start = false) => {
    if (!initialized) return;
    setLoading(true);
    try {
      setState(await api<ReposState>("GET", `${base}/repos/state${start ? "?start=1" : ""}`));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void refresh();
    if (!active) return;
    const t = setInterval(() => void refresh(), 20_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, initialized, key, active, done]);
  return { state, loading, error, refresh };
};

/** The header's repositories: which got commits this session, at a glance. */
const RepoChips = ({ state, names }: { state: ReposState | null; names: string[] }) => (
  <span className="row" style={{ gap: 6, display: "inline-flex", flexWrap: "wrap" }}>
    {names.map((n) => {
      const r = state?.repos.find((x) => x.name === n);
      const ch = r ? repoChange(r) : null;
      return (
        <span key={n} className={`chip mono${ch?.changed ? " on" : ""}`} style={ch && !ch.changed ? { opacity: 0.55 } : undefined} title={r?.box ? `as of ${fmtDateTime(r.box.at)}` : undefined}>
          {n}{ch ? ` · ${ch.text}` : ""}
        </span>
      );
    })}
  </span>
);

type Unpublished = "refuse" | "rebase" | "discard";
type SyncAnswer = { name: string; branch: string; tip?: CommitLine; mode?: string; upToDate?: boolean; ok?: boolean; error?: string; reason?: string };

/** What a sync would do to a repository, from its last reading: the words for the dialog and whether a choice is needed. */
const syncNeeds = (st: RepoState | undefined): { text: string; choose: boolean } => {
  const b = st?.box;
  if (!b) return { text: "not read yet", choose: false };
  const last = st.prs.at(-1);
  if (b.dirty > 0) return { text: `${b.dirty} uncommitted file${b.dirty === 1 ? "" : "s"}`, choose: true };
  if (b.ahead === 0) return { text: "no commits of its own", choose: false };
  if (last && last.headSha === b.head && last.state === "merged") return { text: `its commits are in merged #${last.number}`, choose: false };
  if (last && last.headSha === b.head && last.state === "open") return { text: `#${last.number} is still open`, choose: true };
  return { text: `${b.ahead ?? b.commits.length} commit${b.ahead === 1 ? "" : "s"} not in a merged pull request`, choose: true };
};

const UnpublishedChoice = ({ value, onChange, disabled }: { value: Unpublished; onChange: (v: Unpublished) => void; disabled: boolean }) => (
  <div className="stack tight small">
    <label className="chk"><input type="radio" checked={value === "refuse"} onChange={() => onChange("refuse")} disabled={disabled} /> Leave repositories with work of their own as they are</label>
    <label className="chk"><input type="radio" checked={value === "rebase"} onChange={() => onChange("rebase")} disabled={disabled} /> Rebase their commits onto the new base (stops on a conflict)</label>
    <label className="chk"><input type="radio" checked={value === "discard"} onChange={() => onChange("discard")} disabled={disabled} /> Discard their commits and uncommitted files</label>
  </div>
);

/**
 * Sync one repository: its clone moves to the latest branch from GitHub
 * without a new clone. Work of its own is kept unless you choose otherwise.
 */
const SyncDialog = ({ repo, st, base, onClose, onDone }: { repo: RepoSpec; st: RepoState | undefined; base: string; onClose: () => void; onDone: (text: string) => Promise<void> }) => {
  const [branches, setBranches] = useState<string[] | null>(null);
  const [branch, setBranch] = useState(repo.branch);
  const [choice, setChoice] = useState<Unpublished>("refuse");
  const [working, setWorking] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    api<{ branches: string[] }>("GET", `${base}/repos/${encodeURIComponent(repo.name)}/branches`).then((b) => setBranches(b.branches)).catch((e: Error) => setErr(e.message));
  }, [base, repo.name]);
  const needs = syncNeeds(st);
  const go = async () => {
    setWorking(true);
    setErr("");
    try {
      const r = await api<SyncAnswer>("POST", `${base}/repos/${encodeURIComponent(repo.name)}/sync`, { branch, onUnpublished: choice });
      await onDone(r.upToDate ? `${repo.name} is already at ${r.branch} @ ${r.tip?.sha.slice(0, 7)}.` : `${repo.name} synced to ${r.branch} @ ${r.tip?.sha.slice(0, 7)} “${r.tip?.subject}”${r.mode === "rebase" ? "; its commits were rebased onto it" : r.mode === "discard" ? "; its own work was discarded" : ""}.`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setWorking(false);
    }
  };
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !working && onClose()} role="dialog" aria-modal="true" aria-labelledby="sync-title">
      <div className="dialog">
        <h3 id="sync-title">Sync {repo.name}</h3>
        <p className="small" style={{ margin: 0 }}>Brings the latest branch from GitHub into the clone, without a new clone: installed dependencies and build output stay. The container keeps running.</p>
        <div className="stack small" style={{ gap: 8 }}>
          <label className="row" style={{ gap: 8 }}>
            <span>Branch</span>
            <select value={branch} onChange={(e) => setBranch(e.target.value)} disabled={working || !branches}>
              {!(branches ?? []).includes(branch) && <option value={branch}>{branch}</option>}
              {(branches ?? []).map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </label>
          <div>The clone has {needs.text}.</div>
          {needs.choose && <UnpublishedChoice value={choice} onChange={setChoice} disabled={working} />}
          {err && <div className="banner warn"><span>{err}</span></div>}
        </div>
        <div className="row">
          <button className="pri" onClick={() => void go()} disabled={working}>{working ? "Syncing…" : `Sync to ${branch}`}</button>
          <button className="quiet" onClick={onClose} disabled={working}>Cancel</button>
        </div>
      </div>
    </div>
  );
};

/**
 * Next round: after you merged the pull requests on GitHub, every
 * repository moves to the latest branch (the repository's default branch
 * unless you pick another), and you see each new tip before the next run.
 */
const NextRoundDialog = ({ session, state, base, onClose, onDone }: { session: Session; state: ReposState | null; base: string; onClose: () => void; onDone: () => Promise<void> }) => {
  const repos = session.repos.filter((r) => r.github);
  const [defaults, setDefaults] = useState<Record<string, string>>({});
  const [branches, setBranches] = useState<Record<string, string>>({});
  const [choice, setChoice] = useState<Unpublished>("refuse");
  const [working, setWorking] = useState(false);
  const [results, setResults] = useState<SyncAnswer[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    api<Config>("GET", "/config")
      .then((c) => {
        const d: Record<string, string> = {};
        for (const r of repos) d[r.name] = c.workTargets.find((t) => t.github.toLowerCase() === r.github!.toLowerCase())?.defaultBranch ?? r.branch;
        setDefaults(d);
        setBranches(d);
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const needs = repos.map((r) => ({ r, n: syncNeeds(state?.repos.find((x) => x.name === r.name)) }));
  const go = async () => {
    setWorking(true);
    setErr("");
    try {
      const res = await fetch(`/api${base}/next-round`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ branches, onUnpublished: choice }) });
      const j = (await res.json()) as { results?: SyncAnswer[]; error?: string };
      if (!j.results) throw new Error(j.error ?? `HTTP ${res.status}`);
      setResults(j.results);
      await onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setWorking(false);
    }
  };
  const allOk = results?.every((r) => r.ok);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !working && onClose()} role="dialog" aria-modal="true" aria-labelledby="round-title">
      <div className="dialog">
        <h3 id="round-title">Next round</h3>
        {!results ? (
          <>
            <p className="small" style={{ margin: 0 }}>Every repository moves to the latest branch on GitHub, with your merges in. Then plan the next tickets or revise the goal.</p>
            <div className="stack small" style={{ gap: 6 }}>
              {needs.map(({ r, n }) => (
                <div key={r.name} className="row" style={{ gap: 8, justifyContent: "space-between" }}>
                  <span><strong>{r.name}</strong> <span className={n.choose ? "warn" : "muted"}>{n.text}</span></span>
                  <input className="mono" style={{ width: 160 }} value={branches[r.name] ?? ""} placeholder={defaults[r.name] ?? r.branch} onChange={(e) => setBranches({ ...branches, [r.name]: e.target.value })} disabled={working} aria-label={`Branch for ${r.name}`} />
                </div>
              ))}
              {needs.some((x) => x.n.choose) && <UnpublishedChoice value={choice} onChange={setChoice} disabled={working} />}
            </div>
          </>
        ) : (
          <div className="stack small" style={{ gap: 6 }}>
            {results.map((r) => (
              <div key={r.name} className={r.ok ? "" : "err"}>
                <strong>{r.name}</strong>{" "}
                {r.ok ? <span className="ok">{r.upToDate ? "already at" : "now at"} <span className="mono">{r.branch} @ {r.tip?.sha.slice(0, 7)}</span> “{r.tip?.subject}”</span> : r.error}
              </div>
            ))}
            {allOk && <div className="muted">Every repository has your latest changes.</div>}
          </div>
        )}
        {err && <div className="banner warn"><span>{err}</span></div>}
        <div className="row">
          {!results && <button className="pri" onClick={() => void go()} disabled={working || !repos.length}>{working ? "Syncing…" : "Sync every repository"}</button>}
          {results && !allOk && <button onClick={() => setResults(null)}>Back</button>}
          <button className="quiet" onClick={onClose} disabled={working}>{results ? "Close" : "Cancel"}</button>
        </div>
      </div>
    </div>
  );
};

/** The repository's latest pull request: number, state, link. */
const PullLine = ({ pr }: { pr: PullRecord }) => (
  <div>
    <span className="muted">PR</span>{" "}
    <a href={pr.url} target="_blank" rel="noreferrer">#{pr.number}</a>{" "}
    <span className={pr.state === "merged" ? "ok" : pr.state === "closed" ? "muted" : ""}>{pr.state}</span>
    <span className="muted"> · {pr.title}</span>
  </div>
);

/**
 * Publish PR for one repository: what goes (the commits since the base),
 * what does not (uncommitted files), what deserves a look before CI runs it
 * (build and CI files), then a draft pull request or an update of the open one.
 */
const PublishDialog = ({ repo, base, onClose, onDone }: { repo: RepoSpec; base: string; onClose: () => void; onDone: (text: string) => Promise<void> }) => {
  const [p, setP] = useState<PublishPreview | null>(null);
  const [err, setErr] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState(true);
  const [ack, setAck] = useState(false);
  const [working, setWorking] = useState(false);
  const url = `${base}/repos/${encodeURIComponent(repo.name)}/publish`;
  useEffect(() => {
    api<PublishPreview>("GET", url)
      .then((x) => {
        setP(x);
        setTitle(x.title);
        setBody(x.body);
      })
      .catch((e: Error) => setErr(e.message));
  }, [url]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && !working && onClose();
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [working, onClose]);
  const publish = async () => {
    setWorking(true);
    setErr("");
    try {
      const r = await api<{ pr: PullRecord; updated: boolean; commits: number | null }>("POST", url, { title, body, draft });
      await onDone(`${repo.name}: ${r.updated ? "updated" : "opened"} pull request #${r.pr.number} (${r.pr.remoteBranch} into ${r.pr.base}). ${r.pr.url}`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setWorking(false);
    }
  };
  const nothing = p !== null && p.ahead === 0;
  const blocked = !p || nothing || !title.trim() || (p.flagged.length > 0 && !ack);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !working && onClose()} role="dialog" aria-modal="true" aria-labelledby="publish-title">
      <div className="dialog">
        <h3 id="publish-title">{p?.update ? `Update pull request #${p.update.number}` : "Publish pull request"} · {repo.name}</h3>
        {!p && !err && <div className="muted small">Reading the clone…</div>}
        {p && (
          <div className="stack small" style={{ gap: 8 }}>
            <div>
              {nothing ? (
                <span className="muted">No commits since {p.base}: nothing to publish.</span>
              ) : (
                <>
                  <b>{p.ahead ?? p.commits.length} commit{(p.ahead ?? p.commits.length) === 1 ? "" : "s"}</b>, {p.changedFiles} file{p.changedFiles === 1 ? "" : "s"} changed, pushed to <span className="mono">{p.remoteBranch}</span>
                  {p.update ? <> (the branch of <a href={p.update.url} target="_blank" rel="noreferrer">#{p.update.number}</a>)</> : <> as a pull request into <span className="mono">{p.base}</span></>}.
                </>
              )}
            </div>
            {p.commits.length > 0 && (
              <ul className="mono" style={{ margin: 0, paddingLeft: 18, maxHeight: 140, overflow: "auto" }}>
                {p.commits.map((c) => <li key={c.sha}><span className="muted">{c.sha.slice(0, 7)}</span> {c.subject}</li>)}
              </ul>
            )}
            {p.warnings.map((w) => <div key={w} className="banner warn"><span>{w}</span></div>)}
            {p.flagged.length > 0 && (
              <div className="banner warn stack" style={{ gap: 4 }}>
                <span>These files change how the build or CI runs. Once pushed, the repository's CI runs the agents' code with whatever secrets it can read:</span>
                <span className="mono">{p.flagged.slice(0, 12).join(", ")}{p.flagged.length > 12 ? ` and ${p.flagged.length - 12} more` : ""}</span>
                <label className="chk"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I looked at them; publish anyway</label>
              </div>
            )}
            {!nothing && (
              <>
                <label>Title<input value={title} onChange={(e) => setTitle(e.target.value)} disabled={working} maxLength={250} /></label>
                <label>
                  Description {p.update && <span className="help">Left empty, the pull request keeps its description</span>}
                  <textarea value={body} onChange={(e) => setBody(e.target.value)} disabled={working} style={{ minHeight: 120 }} />
                </label>
                {!p.update && <label className="chk"><input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} disabled={working} /> Open as a draft</label>}
              </>
            )}
          </div>
        )}
        {err && <div className="banner warn"><span>{err}</span></div>}
        <div className="row">
          <button className="pri" onClick={() => void publish()} disabled={blocked || working}>{working ? "Publishing…" : p?.update ? `Update #${p.update.number}` : draft ? "Open draft pull request" : "Open pull request"}</button>
          <button className="quiet" onClick={onClose} disabled={working}>Cancel</button>
        </div>
      </div>
    </div>
  );
};

/** One repository's details in the strip: where its base is, what the clone added, whether GitHub moved on. */
const RepoStatus = ({ r, live }: { r: RepoState; live: boolean }) => {
  const [open, setOpen] = useState(false);
  const ch = repoChange(r);
  const now = Date.now();
  const tip = r.remote?.tip;
  const base = r.box?.base ?? (r.baseCommit ? { sha: r.baseCommit, subject: "", date: "" } : null);
  const upToDate = tip && base && tip.sha === base.sha;
  const commits = r.box?.commits ?? [];
  return (
    <div className="small stack" style={{ gap: 2 }}>
      <div>
        <span className="muted">base</span> <span className="mono">{r.branch} @ {base ? base.sha.slice(0, 7) : "?"}</span>
        {base?.subject ? <span className="muted"> “{base.subject}”</span> : null}
      </div>
      {r.github && (
        <div className={r.remoteError ? "err" : upToDate ? "ok" : "warn"}>
          {r.remoteError
            ? r.remoteError
            : !tip
              ? `GitHub has no branch ${r.branch}`
              : upToDate
                ? `Up to date with ${r.branch} on GitHub`
                : `${r.branch} on GitHub moved on${r.remote?.behind ? ` by ${r.remote.behind} commit${r.remote.behind === 1 ? "" : "s"}` : ""}: ${tip.sha.slice(0, 7)} “${tip.subject}”`}
          {r.remote?.fetchedAt && !r.remoteError ? <span className="muted"> · checked {fmtAgo(r.remote.fetchedAt, now)}</span> : null}
        </div>
      )}
      {r.prs.length > 0 && <PullLine pr={r.prs.at(-1)!} />}
      <div>
        <span className={ch.changed ? "" : "muted"}>{ch.changed ? <b>{ch.text}</b> : r.box ? "No changes this session" : "Not read yet"}</span>
        {r.box && !live ? <span className="muted"> · as of {fmtAgo(r.box.at, now)}</span> : null}
        {commits.length > 0 && <button className="quiet sm" style={{ marginLeft: 6 }} onClick={() => setOpen((o) => !o)}>{open ? "hide log" : "show log"}</button>}
      </div>
      {open && commits.length > 0 && (
        <ul className="mono" style={{ margin: "2px 0 0", paddingLeft: 18 }}>
          {commits.map((c) => (
            <li key={c.sha} title={fmtDateTime(c.date)}><span className="muted">{c.sha.slice(0, 7)}</span> {c.subject}</li>
          ))}
          {r.box && r.box.ahead !== null && r.box.ahead > commits.length ? <li className="muted">… {r.box.ahead - commits.length} more</li> : null}
        </ul>
      )}
    </div>
  );
};

/** In a few words: where a repository's base stands against GitHub; undefined when there is nothing to say. */
const remoteNote = (r: RepoState): { text: string; tone: "warn" | "err" } | undefined => {
  if (!r.github) return undefined;
  if (r.remoteError) return { text: r.remoteError, tone: "err" };
  const tip = r.remote?.tip;
  if (!tip) return r.remote ? { text: `GitHub has no branch ${r.branch}`, tone: "warn" } : undefined;
  const base = r.box?.base?.sha ?? r.baseCommit;
  if (!base || tip.sha === base) return undefined;
  return { text: `${r.branch} moved on${r.remote?.behind ? ` by ${r.remote.behind}` : ""}`, tone: "warn" };
};

/**
 * The repositories of a session, one line each, right under the header:
 * what the clone holds, the pull request, and the button that publishes
 * it. Publishing is what you come here for after a run, so it does not sit
 * below the inbox. The rest (sync, reclone, the commit log) is one click
 * away on the line.
 */
const RepoStrip = ({ session, base, active, done, repoState, onExport, onDone }: { session: Session; base: string; active: boolean; done: number; repoState: RepoStateHandle; onExport: () => void; onDone: () => Promise<void> }) => {
  const [restoring, setRestoring] = useState<RepoSpec | null>(null);
  const [publishing, setPublishing] = useState<RepoSpec | null>(null);
  const [syncing, setSyncing] = useState<RepoSpec | null>(null);
  const [nextRound, setNextRound] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const all = usePublishAll(base, onDone);
  if (!session.repos.length || !isInitialized(session)) return null;
  const state = repoState.state;
  const stopFirst = "Pause or stop the run first";
  const onGithub = session.repos.filter((r) => r.github);
  // Known to have nothing to push: every clone was read and none is ahead of its base.
  const nothingToPublish = onGithub.every((r) => state?.repos.find((x) => x.name === r.name)?.box?.ahead === 0);
  const finish = (close: () => void) => async (text: string) => {
    close();
    setNote(text);
    await onDone();
  };
  return (
    <section className="card repo-strip">
      <div className="row">
        <h3>Repositories</h3>
        <span className="muted small">{done} ticket{done === 1 ? "" : "s"} done{state && !state.live ? " · the container is stopped; this is the last reading" : ""}</span>
        {repoState.error && <span className="err small">{repoState.error}</span>}
        <span className="row end" style={{ gap: 6 }}>
          <button className="quiet sm" onClick={() => void repoState.refresh(!state?.live)} disabled={repoState.loading || (active && !state?.live)} title={state?.live ? "Read the clones and GitHub again" : "Start the container and read the clones now"}>{repoState.loading ? "Reading…" : state?.live ? "Refresh" : "Read now"}</button>
          {onGithub.length > 0 && (
            <button className="sm pri" onClick={() => void all.run()} disabled={active || all.working || nothingToPublish} title={active ? stopFirst : nothingToPublish ? "No repository has commits since its base" : "One click: a draft pull request for every repository with commits, and the new commits to every open pull request. Asks only when build or CI files changed."}>
              {all.working ? "Publishing…" : "Publish all as drafts"}
            </button>
          )}
          {onGithub.length > 0 && <button className="sm" onClick={() => setNextRound(true)} disabled={active} title={active ? stopFirst : "After merging on GitHub: sync every repository to its latest branch, then plan"}>Next round…</button>}
          <MoreMenu label="⋯" className="quiet sm" items={[{ label: "Export bundles…", onClick: onExport, disabled: active }]} />
        </span>
      </div>
      <div className="repo-rows">
        {session.repos.map((r) => {
          const st = state?.repos.find((x) => x.name === r.name);
          const ch = st ? repoChange(st) : { text: "not read yet", changed: false };
          const pr = st?.prs.at(-1);
          const openPr = pr?.state === "open" ? pr : undefined;
          const nothing = st?.box?.ahead === 0;
          const remote = st ? remoteNote(st) : undefined;
          const shown = open === r.name;
          const published = all.result?.rows.find((x) => x.repo === r.name);
          const outcome = published ? publishRowText(published) : undefined;
          return (
            <div className="strip-row" key={r.name}>
              <div className="line">
                <button className="quiet sm disclose" aria-expanded={shown} onClick={() => setOpen(shown ? null : r.name)} title={shown ? "Hide the details" : "Base, GitHub and the commits of this session"}>{shown ? "▾" : "▸"}</button>
                <span className="name"><strong>{r.name}</strong> {r.github ? <a className="muted small mono" href={`https://github.com/${r.github}`} target="_blank" rel="noreferrer">{r.github}</a> : <span className="muted small mono" title={r.sourcePath}>{repoOrigin(r)}</span>}</span>
                {outcome ? (
                  <span className={`what small ${outcome.tone}`} title={outcome.text}>{outcome.text}</span>
                ) : (
                  <span className="what small" title={remote?.text}>
                    <span className={ch.changed ? "" : "muted"}>{ch.changed ? <b>{ch.text}</b> : ch.text}</span>
                    {remote && <span className={remote.tone}> · {remote.text}</span>}
                  </span>
                )}
                <span className="pr small">
                  {pr ? (
                    <>
                      <a href={pr.url} target="_blank" rel="noreferrer" title={pr.title}>PR #{pr.number}</a>{" "}
                      <span className={pr.state === "merged" ? "ok" : pr.state === "closed" ? "muted" : ""}>{pr.state}</span>
                    </>
                  ) : r.github ? <span className="muted">no PR</span> : null}
                </span>
                <span className="row acts" style={{ gap: 6 }}>
                  {r.github && (
                    <button className="sm pri" onClick={() => setPublishing(r)} disabled={active || nothing} title={active ? stopFirst : nothing ? "No commits since the base: nothing to publish" : openPr ? `Push the new commits to ${openPr.remoteBranch}` : `Push the commits to a verstas/ branch and open a draft pull request into ${r.branch}`}>
                      {openPr ? `Update PR #${openPr.number}` : "Publish PR"}
                    </button>
                  )}
                  {r.github && (
                    <MoreMenu
                      label="⋯"
                      className="quiet sm"
                      items={[
                        { label: `Sync with ${r.branch}…`, onClick: () => setSyncing(r), disabled: active },
                        { label: "Reclone from GitHub…", onClick: () => setRestoring(r), disabled: active },
                      ]}
                    />
                  )}
                </span>
              </div>
              {shown && st && <div className="detail"><RepoStatus r={st} live={Boolean(state?.live)} /></div>}
            </div>
          );
        })}
      </div>
      {note && <div className="banner ok small"><span>{note}</span><button className="quiet sm end" onClick={() => setNote("")}>Dismiss</button></div>}
      {all.result && <div className={`banner small ${all.result.rows.some((x) => x.outcome === "failed") ? "warn" : "ok"}`}><span>{publishAllSummary(all.result)} Each line says what happened to its repository.</span><button className="quiet sm end" onClick={all.dismiss}>Dismiss</button></div>}
      {all.error && <div className="banner warn small"><span>{all.error}</span><button className="quiet sm end" onClick={all.dismiss}>Dismiss</button></div>}
      {all.dialog}
      {syncing && <SyncDialog repo={syncing} st={state?.repos.find((x) => x.name === syncing.name)} base={base} onClose={() => setSyncing(null)} onDone={finish(() => setSyncing(null))} />}
      {nextRound && <NextRoundDialog session={session} state={state} base={base} onClose={() => setNextRound(false)} onDone={onDone} />}
      {publishing && <PublishDialog repo={publishing} base={base} onClose={() => setPublishing(null)} onDone={finish(() => setPublishing(null))} />}
      {restoring && <RestoreRepo repo={restoring} base={base} onClose={() => setRestoring(null)} onDone={finish(() => setRestoring(null))} />}
    </section>
  );
};

/**
 * Reclone: the clone is replaced by a fresh clone from GitHub, for a broken
 * clone or a guaranteed-fresh tree (Sync is the usual way to catch up).
 * The dialog counts the run branch's commits since the base, since they go
 * with the old clone, and lets you pick the branch.
 */
const RestoreRepo = ({ repo, base, onClose, onDone }: { repo: RepoSpec; base: string; onClose: () => void; onDone: (text: string) => Promise<void> }) => {
  const [commits, setCommits] = useState<number | null | undefined>(undefined);
  const [branches, setBranches] = useState<string[] | null>(null);
  const [branch, setBranch] = useState(repo.branch);
  const [working, setWorking] = useState("");
  const [err, setErr] = useState("");
  useEffect(() => {
    api<{ repos: { name: string; commits: number | null }[] }>("GET", `${base}/commits`)
      .then((r) => setCommits(r.repos.find((x) => x.name === repo.name)?.commits ?? null))
      .catch(() => setCommits(null));
    api<{ current: string; branches: string[] }>("GET", `${base}/repos/${encodeURIComponent(repo.name)}/branches`)
      .then((b) => setBranches(b.branches))
      .catch((e: Error) => {
        setBranches([]);
        setErr(e.message);
      });
  }, [base, repo.name]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && !working && onClose();
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [working, onClose]);
  const step = async (label: string, fn: () => Promise<void>) => {
    setWorking(label);
    setErr("");
    try {
      await fn();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setWorking("");
    }
  };
  const restore = () => step("restore", async () => {
    const r = await api<{ repo: RepoSpec }>("POST", `${base}/repos/${encodeURIComponent(repo.name)}/restore`, { branch });
    await onDone(`${repo.name} recloned from ${repoOrigin(repo)} at ${r.repo.branch} ${r.repo.baseCommit?.slice(0, 10) ?? ""}. The container was stopped; the next run starts it again. Installed dependencies inside the clone are gone; Re-run recipes if setup put them there.`);
  });
  const atRisk = commits !== 0;
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !working && onClose()} role="dialog" aria-modal="true" aria-labelledby="restore-title">
      <div className="dialog">
        <h3 id="restore-title">Reclone {repo.name}</h3>
        <p className="small" style={{ margin: 0 }}>
          This deletes the clone in the box and clones <span className="mono">{repoOrigin(repo)}</span> again as it is on GitHub now. The run branch <span className="mono">{repo.runBranch}</span> starts over from the new base. Commits on it that you have not published or exported are lost, and so are ignored files inside the clone (node_modules, build output). The container is stopped and starts again with the next run.
        </p>
        <div className="stack tight small">
          <div>
            <strong>{repo.name}</strong> <span className="mono muted">{repo.runBranch}</span>:{" "}
            {commits === undefined ? <span className="muted">counting commits since the session started…</span> : commits === null ? <span className="warn">could not count the commits</span> : commits === 0 ? <span className="muted">no commits since the session started</span> : <b>{commits} commit{commits === 1 ? "" : "s"} since the session started</b>}
            {commits !== 0 && commits !== undefined && <span className="muted"> · publish them first (Publish PR) to keep them</span>}
          </div>
          <label className="row" style={{ gap: 8 }}>
            <span>Branch to clone</span>
            {branches && branches.length > 0 ? (
              <select value={branch} onChange={(e) => setBranch(e.target.value)} disabled={Boolean(working)}>
                {!branches.includes(branch) && <option value={branch}>{branch}</option>}
                {branches.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            ) : (
              <input value={branch} onChange={(e) => setBranch(e.target.value)} disabled={Boolean(working)} style={{ width: 220 }} />
            )}
          </label>
          {err && <div className="banner warn"><span>{err}</span></div>}
        </div>
        <div className="row">
          <button className="warn solid" onClick={() => void restore()} disabled={commits === undefined || Boolean(working) || !branch.trim()}>{working === "restore" ? "Recloning…" : atRisk ? `Reclone and lose ${repo.name}'s unsaved work` : `Reclone ${repo.name}`}</button>
          <button className="quiet" onClick={onClose} disabled={Boolean(working)}>Cancel</button>
        </div>
      </div>
    </div>
  );
};

// --- the environment: repositories, attachments, recipes, initialization ------

type SetupInfo = { logs: Record<string, string> };
type RepoChoice = { target: string; github: string; branches: string[]; current: string };

/**
 * Everything the box is made of, shared by the sections below. While the
 * session is a plan the sections are cards of the setup sheet; once the
 * box exists they fold into one Environment panel in the sidebar. Before
 * initialization the repositories can change; everything else can change
 * at any time (recipes re-run on request).
 */
const useEnvironment = (session: Session, base: string, active: boolean, onDone: () => Promise<void>) => {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [info, setInfo] = useState<SetupInfo | null>(null);
  const [sudo, setSudo] = useState<{ count: number; commands: string[] } | null>(null);
  const [library, setLibrary] = useState<SetupScript[]>([]);
  const [choices, setChoices] = useState<RepoChoice[]>([]);
  const initialized = isInitialized(session);
  const now = useNow();
  useEffect(() => {
    api<SetupInfo>("GET", `${base}/setup`).then(setInfo).catch(() => setInfo(null));
    api<{ count: number; commands: string[] }>("GET", `${base}/sudo-log`).then(setSudo).catch(() => setSudo(null));
  }, [base, session.initializedAt, active]);
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
          out.push({ target: w.name, github: w.github, branches: b.branches, current: b.current || w.defaultBranch });
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
  return { session, base, active, busy, msg, info, sudo, library, choices, initialized, now, act, copyContext };
};
type Env = ReturnType<typeof useEnvironment>;

/** The repositories: added and removed while the session is a plan, fresh clones once it is a box. */
const RepoSection = ({ env, bare }: { env: Env; bare?: boolean }) => {
  const { session, base, active, busy, choices, initialized, act } = env;
  const [adding, setAdding] = useState<{ target: string; branch: string; as: string } | null>(null);
  const free = choices.filter((c) => !session.repos.some((x) => x.name === c.target && x.github === c.github));
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
          <span><strong>{x.name}</strong> <span className="muted mono">{x.branch}</span> <span className="muted mono" title={x.github ?? x.sourcePath}>{repoOrigin(x)}</span>{x.baseCommit ? <span className="muted mono"> · {x.baseCommit.slice(0, 7)}</span> : null}</span>
          {!initialized && <button className="quiet sm" onClick={() => removeRepo(x.name)} disabled={busy || active}>remove</button>}
        </div>
      ))}
      {!initialized && adding === null && free.length > 0 && <button className="sm" style={{ marginTop: 6 }} onClick={startAdd} disabled={busy || active}>Add repository</button>}
      {!initialized && adding === null && free.length === 0 && choices.length === 0 && <div className="muted" style={{ marginTop: 4 }}>No repositories: add GitHub repositories in <a href="#/settings">Settings</a>.</div>}
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
            <span className="muted mono">{chosen?.github}</span>
          </div>
        </div>
      )}
    </div>
  );
};

/** Toggle chips for a ticket's expected repositories. */
const RepoPicker = ({ names, value, onChange }: { names: string[]; value: string[]; onChange: (v: string[]) => void }) => (
  <div className="chips" style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 4 }}>
    {names.length === 0 && <span className="muted">none in this session</span>}
    {[...names, ...value.filter((v) => !names.includes(v))].map((n) => (
      <button type="button" key={n} className={`chip mono${value.includes(n) ? " on" : ""}`} aria-pressed={value.includes(n)} title={names.includes(n) ? undefined : "Not a repository of this session"} onClick={() => onChange(value.includes(n) ? value.filter((x) => x !== n) : [...value, n])}>
        {n}
      </button>
    ))}
  </div>
);

/** What the ticket expected to touch and, once judged, what it touched: per repository, its change. */
const TicketRepos = ({ ticket }: { ticket: Ticket }) => {
  const touched = ticket.touched ?? [];
  if (!touched.length) return ticket.repos.length ? <span>expects <span className="mono">{ticket.repos.join(", ")}</span></span> : null;
  const untouched = ticket.repos.filter((r) => !touched.some((t) => t.repo === r));
  return (
    <span>
      {touched.map((t) => (
        <span key={t.repo} style={{ marginRight: 8 }} title={ticket.repos.length && !ticket.repos.includes(t.repo) ? "Not expected; the worker decided it needed a change" : undefined}>
          <span className="mono">{t.repo}</span>
          {ticket.repos.length > 0 && !ticket.repos.includes(t.repo) && <span className="muted"> (added by the worker)</span>} <span className="mono">+{t.added} −{t.removed}</span>
        </span>
      ))}
      {untouched.length > 0 && <span className="muted" title="Expected, but the change did not touch it">untouched: <span className="mono">{untouched.join(", ")}</span></span>}
    </span>
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

/** What ran as root in the box: the sudo log, newest last. The lead's own notes are its business; its plan note is on the goal panel. */
const NotesSection = ({ env }: { env: Env }) => {
  const { sudo } = env;
  const [show, setShow] = useState(false);
  return (
    <div className="small">
      <span className="dot" /> <strong>Run as root</strong>{" "}
      <span className="muted">{sudo?.count ? `${sudo.count} sudo command${sudo.count === 1 ? "" : "s"} by the agent` : "nothing yet"}</span>{" "}
      {Boolean(sudo?.count) && <button className="quiet sm" onClick={() => setShow(!show)}>{show ? "hide" : "view"}</button>}
      {show && sudo && <pre className="mono" style={{ whiteSpace: "pre-wrap", maxHeight: 240, overflow: "auto", marginTop: 6 }}>{sudo.commands.join("\n")}</pre>}
    </div>
  );
};

/** Has an earlier box left anything to read? After a reset the log stays, so a plan can have it too. */
const hasNotes = (env: Env): boolean => Boolean(env.sudo?.count);

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
 * run branch that was not published or exported is lost; when there is any,
 * the dialog says to publish it first and offers Export.
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
          This deletes the container, the proxy and network, the home volume (installed toolchains and caches), the snapshot, and <strong>the clones of your repositories</strong>. Commits on a run branch that you have not published or exported are lost with them. The board, notes, settings and run history stay; the session becomes a plan again and needs Initialize.
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
            </div>
          ))}
          {repos && repos.some((r) => r.commits !== 0) && (
            <div className="row small">
              <span className="muted">Publish them first (Publish PR in the Work panel), or</span>
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
  return (
    <section className="card stack launch" style={{ gap: 10 }}>
      <h3>{active ? "Initializing…" : "Ready to initialize?"}</h3>
      <p className="lead" style={{ margin: 0 }}>Initialize clones the repositories, creates the container and runs the recipes. Nothing runs before that; come back to this plan over hours if you like.</p>
      <ul className="launch-list">
        <li><span className={`dot ${session.repos.length ? "good" : "bad"}`} />{session.repos.length ? <span><b>{session.repos.length}</b> repositor{session.repos.length === 1 ? "y" : "ies"}: <span className="mono">{session.repos.map((r) => r.name).join(", ")}</span></span> : <span>No repositories: the workers would have nothing to change.</span>}</li>
        <li><span className={`dot ${ready ? "good" : total ? "info" : ""}`} />{total ? <span><b>{total}</b> ticket{total === 1 ? "" : "s"}, <b>{ready}</b> ready{counts.backlog ? `, ${counts.backlog} in the backlog` : ""}</span> : <span>No tickets. Fine with a goal: the lead works toward it and may write its own.</span>}</li>
        <li><span className={`dot ${session.setupScripts.length ? "good" : ""}`} />{session.setupScripts.length ? <span>Recipes: {session.setupScripts.map((s) => s.name).join(", ")}</span> : <span>No recipes; the box starts from the plain image.</span>}</li>
        <li><span className={`dot ${session.packs.length || session.allowlist.length ? "good" : ""}`} />{session.packs.length ? <span>Packs: {session.packs.join(", ")}</span> : <span>No packs: only the agents' backends{session.allowlist.length ? " and the allowlist" : ""}.</span>}</li>
        {session.attachments.length > 0 && <li><span className="dot good" /><span>{session.attachments.length} attachment{session.attachments.length === 1 ? "" : "s"}</span></li>}
      </ul>
      {active ? (
        <div className="small"><span className="dot run" /> The box is being made. The log on the left shows each step.</div>
      ) : (
        <div className="stack tight">
          <button className="pri" onClick={() => onInit(false)} disabled={busy} title="Clone the repositories, create the container, run the recipes">Initialize</button>
          <button onClick={() => onInit(true)} disabled={busy || (!ready && !session.goal.trim())} title={ready || session.goal.trim() ? "Initialize, and start the lead when it succeeds" : "Write a goal or make a ticket ready first"}>Initialize and start</button>
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
      </ul>
    </section>
  );
};

// --- the goal ---------------------------------------------------------------

/**
 * The goal above the board: the text the lead works toward beside the
 * tickets (editable at any time; the next life reads it, a running lead is
 * told), the lead's claim that it is met, its plan and progress note, and
 * the earlier goals this session worked.
 */
const GoalPanel = ({ session, base, active, run, onDone, fold = false }: { session: Session; base: string; active: boolean; run?: Run; onDone: () => Promise<void>; /** On the run view a written goal shows as three lines until you open it. */ fold?: boolean }) => {
  const [expanded, setExpanded] = useState(false);
  const [text, setText] = useState(session.goal);
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; updatedAt: string | null } | null>(null);
  const [showNote, setShowNote] = useState(false);
  const now = useNow();
  useEffect(() => {
    if (!dirty) setText(session.goal);
  }, [session.goal, dirty]);
  const rounds = run?.rounds ?? 0;
  useEffect(() => {
    api<{ text: string; updatedAt: string | null }>("GET", `${base}/state-note`).then(setNote).catch(() => setNote(null));
  }, [base, rounds, active]);
  const save = async () => {
    setBusy(true);
    setMsg("");
    try {
      const r = await api<{ changed: boolean; told?: string }>("PUT", `${base}/goal`, { goal: text });
      setDirty(false);
      setExpanded(false);
      setMsg(!r.changed ? "Unchanged." : r.told ? `Saved and sent to the running ${r.told}; the next round reads it too.` : active ? "Saved; the next round reads it (the running worker could not take a message)." : "Saved; the next run reads it.");
      await onDone();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const goals = session.goals ?? [];
  const since = session.goalSince ?? session.createdAt;
  const written = Boolean(session.goal.trim());
  const mark = session.goalMet ? "met, says the lead" : written ? (active ? "working" : "set") : "none";
  const tone: Tone = session.goalMet ? "good" : written ? (active ? "sig" : "info") : "quiet";
  const planNote = (
    <div className="small">
      <span className={`dot ${note?.text ? "good" : ""}`} /> <strong>Plan and progress note</strong>{" "}
      <span className="muted">{note?.text ? `notes/state.md · ${note.updatedAt ? fmtAgo(note.updatedAt, now) : ""}` : "none yet; the lead writes notes/state.md as it works"}</span>{" "}
      {note?.text && <button className="quiet sm" onClick={() => setShowNote(!showNote)}>{showNote ? "hide" : "view"}</button>}
      {showNote && note?.text && <pre className="mono" style={{ whiteSpace: "pre-wrap", maxHeight: 420, overflow: "auto", marginTop: 6 }}>{note.text}</pre>}
    </div>
  );
  if (fold && written && !dirty && !expanded) {
    return (
      <section className="card stack" style={{ gap: 8 }}>
        <SheetHead title="Goal" mark={mark} tone={tone}>
          <span className="muted small">set {fmtAgo(since, now)}{goals.length ? ` · ${goals.length} earlier` : ""}</span>
          <button className="sm" onClick={() => setExpanded(true)}>Edit</button>
        </SheetHead>
        <div className="goal-fold" onClick={() => setExpanded(true)} title="Open the goal">{session.goal.trim()}</div>
        {session.goalMet && <div className="small"><span className="ok">The lead says it is met</span> <span className="muted">{fmtAgo(session.goalMet.at, now)}: {session.goalMet.note.split("\n")[0]!.slice(0, 200)}</span></div>}
        {msg && <div className="muted small">{msg}</div>}
        {planNote}
      </section>
    );
  }
  return (
    <section className="card stack" style={{ gap: 10 }}>
      <SheetHead title="Goal" mark={mark} tone={tone}>
        {fold && written && !dirty && <button className="quiet sm" onClick={() => setExpanded(false)}>Fold</button>}
      </SheetHead>
      <p className="lead" style={{ margin: 0 }}>
        Optional. One lead works toward this text and the board's tickets, keeps its plan in <span className="mono">notes/state.md</span>, and Verstas commits whatever it leaves when a lead life ends. Edit the goal at any time: a running lead is told, and the next life reads the new text. Start again after a met goal to say "not yet". Without a goal, the board is the work.
      </p>
      {session.goalMet && (
        <div className="banner good" style={{ margin: 0 }}>
          <div>
            <strong>The lead says the goal is met</strong> <span className="muted small">{fmtAgo(session.goalMet.at, now)} · run {session.goalMet.runId}</span>
            <div className="small" style={{ whiteSpace: "pre-wrap", marginTop: 4 }}>{session.goalMet.note}</div>
          </div>
        </div>
      )}
      <textarea
        id="goal"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setDirty(true);
        }}
        placeholder="A Mario Party clone running in the browser: four players on a board, dice, a dozen minigames, a results screen. Or paste a specification. Say what done looks like. Leave empty to work the board alone."
        style={{ minHeight: written ? 160 : 72 }}
      />
      <div className="row">
        <button className="pri sm" onClick={() => void save()} disabled={busy || !dirty}>Save goal</button>
        {dirty && (
          <button
            className="quiet sm"
            onClick={() => {
              setText(session.goal);
              setDirty(false);
            }}
          >
            Discard
          </button>
        )}
        <span className="muted small">{msg || (written ? `set ${fmtAgo(since, now)}${goals.length ? ` · ${goals.length} earlier goal${goals.length === 1 ? "" : "s"}` : ""}` : "No goal: the lead works the board's tickets.")}</span>
      </div>
      {planNote}
      {goals.length > 0 && (
        <details>
          <summary className="muted small">Earlier goals ({goals.length})</summary>
          {[...goals].reverse().map((g) => (
            <div key={g.from} className="small" style={{ borderTop: "1px solid var(--line)", paddingTop: 6, marginTop: 6 }}>
              <div className="muted">{g.outcome} · {fmtDateTime(g.from)} to {fmtDateTime(g.until)}</div>
              <div style={{ whiteSpace: "pre-wrap" }}>{g.text.slice(0, 800)}</div>
              {g.note && <div className="muted" style={{ whiteSpace: "pre-wrap", marginTop: 4 }}>{g.note.slice(0, 600)}</div>}
              <button
                className="quiet sm"
                onClick={() => {
                  setText(g.text);
                  setDirty(true);
                }}
              >
                Use this again
              </button>
            </div>
          ))}
        </details>
      )}
    </section>
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
      <p className="lead">One worker with your text, outside any ticket and the run. It can install, configure and investigate; a repository change becomes one commit.</p>
      <textarea id="prompt" value={text} onChange={(e) => setText(e.target.value)} placeholder="Make sure you can run the e2e suite and the dev server." style={{ minHeight: 70 }} />
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

const MoreMenu = ({ items, label = "More ▾", className }: { items: { label: string; onClick?: () => void; href?: string; disabled?: boolean }[]; label?: string; className?: string }) => {
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
      <button className={className} onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open} aria-label={label === "⋯" ? "More actions" : undefined}>{label}</button>
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
            {d.kind === "resources" && <div className="mono small">{d.memoryMb ? `memory: ${d.memoryMb} MB` : "more resources"}</div>}
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

/** The time a ticket has been in progress, counted from the last state change, in the browser. */
const inProgressClock = (t: Ticket, now: number): string => {
  const secs = t.stateSince ? Math.max(0, (now - new Date(t.stateSince).getTime()) / 1000) : 0;
  return fmtSpan(secs);
};

/** "Took 42m · agent 31m · judging 3m · waiting on you 6m · requeued 2m"; the parts that are zero are left out. */
const timingLine = (x: { total: number; agent: number; judging: number; waitingOnYou: number; requeued: number }): string =>
  [`Took ${fmtSpan(x.total)}`, `agent ${fmtSpan(x.agent)}`, x.judging >= 1 ? `judging ${fmtSpan(x.judging)}` : "", x.waitingOnYou >= 1 ? `waiting on you ${fmtSpan(x.waitingOnYou)}` : "", x.requeued >= 1 ? `requeued ${fmtSpan(x.requeued)}` : ""].filter(Boolean).join(" · ");

/** What the board's cards need from the session: the session's review mode, for tickets that set none. */
type TicketView = { review: ReviewMode };
const ticketClock = (session: Session): TicketView => ({ review: session.caps.reviewer ? "full" : "none" });

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
  const timing = t.state === "done" || t.state === "in_progress" ? ticketTiming(t, now) : null;
  return (
    <button className={`tk ${t.state} ${active ? "active" : ""} ${open ? "open" : ""}`} onClick={onOpen} aria-label={`${t.id} ${t.title}`}>
      <div className="id">
        <span>{t.id}</span>
        <span className="k">{t.kind}</span>
        {t.priority <= 2 && <span className="k" title={`priority ${t.priority}`}>p{t.priority}</span>}
        {t.review && normalizeReviewMode(t.review) !== clock.review && <span className="k" title={`${REVIEW_LABEL[t.review]} (the session's is ${REVIEW_LABEL[clock.review].toLowerCase()})`}>{normalizeReviewMode(t.review) === "none" ? "no review" : "review"}</span>}
      </div>
      <div className="title">{t.title}</div>
      {(t.deps.length > 0 || t.diff || active || timing) && (
        <div className="meta">
          {active && <span className="pill sig">working</span>}
          {timing && t.state === "in_progress" && <span className="pill quiet mono" title="Time on this ticket since it went into progress">{inProgressClock(t, now)}</span>}
          {timing && t.state === "done" && <span className="pill quiet mono" title={timingLine(timing)}>{fmtSpan(timing.total)}</span>}
          {t.deps.length > 0 && <span className={`pill ${depsOk ? "quiet" : t.state === "ready" ? "sig" : "quiet"}`} title={`Depends on ${t.deps.join(", ")}`}>deps {depsDone}/{t.deps.length}</span>}
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
    <option value="">Session default ({sessionReviewer ? "full review" : "no review"})</option>
    <option value="full">Full review: the reviewer runs the checks and reads the change</option>
    <option value="none">No review: the lead moves it to done itself</option>
  </>
);

const NewTicketForm = ({ session, board, onCancel, onCreate }: { session: Session; board: Board; onCancel: () => void; onCreate: (body: Record<string, unknown>) => Promise<void> }) => {
  const [f, setF] = useState({ title: "", kind: "feature", repos: session.repos.length === 1 ? [session.repos[0]!.name] : ([] as string[]), priority: "100", deps: "", state: "ready", spec: "", acceptance: "", review: "" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setErr("");
    setBusy(true);
    try {
      await onCreate({
        title: f.title.trim(),
        kind: f.kind,
        repos: f.repos,
        priority: Number(f.priority) || 100,
        deps: f.deps.split(/[,\s]+/).filter(Boolean),
        state: f.state,
        spec: f.spec,
        acceptance: f.acceptance.split(/\n/).map((x) => x.trim()).filter(Boolean),
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
        <label>Expected repositories <span className="help">A hint for you and the lead; it may touch others</span><RepoPicker names={session.repos.map((r) => r.name)} value={f.repos} onChange={(repos) => setF({ ...f, repos })} /></label>
        <label>
          Review <span className="help">How the ticket is judged when the lead moves it to review</span>
          <select value={f.review} onChange={(e) => setF({ ...f, review: e.target.value })}>
            <ReviewOptions sessionReviewer={session.caps.reviewer} />
          </select>
        </label>
        <label>Priority <span className="help">lower first; a hint the lead reads</span><input type="number" min={0} max={1000} value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })} /></label>
        <label>Depends on <span className="help">ids, e.g. {ids.slice(-2).join(", ") || "T-1"}</span><input className="mono" value={f.deps} onChange={(e) => setF({ ...f, deps: e.target.value })} /></label>
      </div>
      <label>Spec <span className="help">What to do and where</span><textarea value={f.spec} onChange={(e) => setF({ ...f, spec: e.target.value })} style={{ minHeight: 120 }} /></label>
      <label>Acceptance criteria <span className="help">one per line, checkable by a reviewer</span><textarea value={f.acceptance} onChange={(e) => setF({ ...f, acceptance: e.target.value })} style={{ minHeight: 70 }} /></label>
      <div className="row">
        <label className="chk"><input type="radio" name="nt-state" checked={f.state === "ready"} onChange={() => setF({ ...f, state: "ready" })} /> Ready for the lead</label>
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

type Row = { e: VEvent; /** A tool call of the live run with no result yet: shown with the time it has been running. */ open?: boolean };

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
    // The last tool call of a live run with nothing after it is still running (a long test, a sleep):
    // say so with the time, so a waiting worker is not mistaken for a stuck one.
    if (liveRun) {
      const last = events[events.length - 1];
      const lastRow = out[out.length - 1];
      if (last && lastRow && last.kind === "tool_use" && lastRow.e === last) lastRow.open = true;
    }
    return out;
  }, [events, ticket, groups, liveRun]);

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
        {rows.map((r, i) => <EventRow key={i} row={r} onTicket={onTicket} now={now} />)}
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

const EventRow = ({ row, onTicket, now }: { row: Row; onTicket: (t: string) => void; now?: number }) => {
  const { e } = row;
  const running = row.open && now ? Math.max(0, Math.round((now - new Date(e.t).getTime()) / 1000)) : undefined;
  return (
    <div className={`ev ${evClass(e)}`}>
      <span className="t" title={fmtDateTime(e.t)}>{fmtTime(e.t)}</span>
      <span className="tid" onClick={() => e.ticket && onTicket(e.ticket)} title={e.ticket ? `Only ${e.ticket}` : ""}>{e.ticket ?? ""}</span>
      <span className="m"><EventText e={e} />{running !== undefined && <span className="muted" title="This command has not returned yet"> · running for {fmtSecs(running)}</span>}</span>
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

// --- inbox -----------------------------------------------------------------

/**
 * Messages and ideas from the agents, and the requests you decided. Clear
 * takes everything settled so far off the page in one step; nothing is
 * deleted, and "Show cleared" brings it back into view. Of the lead's
 * progress updates only the latest shows: each one replaces the one before.
 * The list scrolls inside the card, so the panels below keep their place.
 */
const InboxPanel = ({ inbox, onRead, onPromote, onClear, onOpenTicket }: { inbox: Inbox; onRead: (mid: string) => void; onPromote: (iid: string) => void; onClear: () => void; onOpenTicket: (tid: string) => void }) => {
  const [showCleared, setShowCleared] = useState(false);
  const cleared = inboxCleared(inbox);
  const shown = <T extends { id: string }>(items: T[], gone: Set<string>) => items.filter((x) => showCleared || !gone.has(x.id));
  const open = shown(inbox.messages, cleared.messages).filter((m) => showCleared || !m.read);
  const lastProgress = [...open].reverse().find((m) => m.progress && !cleared.messages.has(m.id))?.id;
  const earlier = open.filter((m) => m.progress && !cleared.messages.has(m.id) && m.id !== lastProgress);
  const messages = showCleared ? open : open.filter((m) => !earlier.includes(m));
  const ideas = shown(inbox.ideas, cleared.ideas).filter((i) => showCleared || !i.promotedTo);
  const decided = shown(inbox.requests.filter((r) => r.state !== "open"), cleared.requests).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  // The count is what waits for you: unread and uncleared, a run of progress updates counted once.
  const total = inbox.messages.filter((m) => !m.read && !cleared.messages.has(m.id) && !earlier.includes(m)).length + inbox.ideas.filter((i) => !i.promotedTo && !cleared.ideas.has(i.id)).length;
  const clearable = total + earlier.length + inbox.requests.filter((r) => r.state !== "open" && !cleared.requests.has(r.id)).length;
  const link = (tid: string) => <a href="#" className="mono" onClick={(e) => { e.preventDefault(); onOpenTicket(tid); }}>{tid}</a>;
  return (
    <section className="card">
      <div className="row">
        <h3>Inbox{total ? ` · ${total}` : ""}</h3>
        {clearable > 0 && <button className="quiet sm end" title="Take every message, idea and decided request off this page. Nothing is deleted; open requests stay." onClick={onClear}>Clear</button>}
      </div>
      {messages.length + ideas.length === 0 && <p className="lead" style={{ marginBottom: 0 }}>No messages or ideas from the agents.</p>}
      <div className="inbox-list">
        {messages.map((m) => {
          const gone = cleared.messages.has(m.id) || m.read;
          return (
            <div className={`req ${gone ? "cleared" : ""}`} key={m.id}>
              <div className="head"><span className="pill info">{m.progress ? "progress" : "message"}</span>{m.ticketId && link(m.ticketId)}<span title={fmtDateTime(m.createdAt)}>{fmtAgo(m.createdAt)}</span>{m.id === lastProgress && earlier.length > 0 && <span className="faint">replaces {earlier.length} earlier</span>}</div>
              <div className="wrap" style={{ fontSize: 13 }}>{m.text}</div>
              {!gone && <div><button className="sm" onClick={() => onRead(m.id)}>Mark read</button></div>}
            </div>
          );
        })}
        {ideas.map((i) => {
          const gone = cleared.ideas.has(i.id) || Boolean(i.promotedTo);
          return (
            <div className={`req ${gone ? "cleared" : ""}`} key={i.id}>
              <div className="head"><span className="pill acc">idea</span>{i.ticketId && <span>from {link(i.ticketId)}</span>}{i.promotedTo && <span>now {link(i.promotedTo)}</span>}</div>
              <strong className="wrap" style={{ fontSize: 13 }}>{i.title}</strong>
              <div className="wrap muted" style={{ fontSize: 12.5 }}>{i.pitch}</div>
              {!i.promotedTo && <div><button className="sm" onClick={() => onPromote(i.id)}>Turn into a ticket</button></div>}
            </div>
          );
        })}
      </div>
      {decided.length > 0 && (
        <details style={{ marginTop: 8 }}>
          <summary className="muted small">{decided.length} decided request{decided.length === 1 ? "" : "s"}</summary>
          <div className="decided">
            {decided.map((r) => (
              <div key={r.id}>
                <span className={`pill ${r.actions.some((a) => a.state === "approved") ? "good" : "quiet"}`}>{r.actions.length ? `${r.actions.filter((a) => a.state === "approved").length}/${r.actions.length} approved` : r.halt ? "halt" : "answered"}</span>
                <span>{[...new Set(r.actions.map((a) => a.detail.kind.replace("_", " ")))].join(", ") || (r.halt ? "halt" : "question")}</span>
                {r.ticketId && link(r.ticketId)}
                <span className="faint" title={fmtDateTime(r.createdAt)}>{fmtAgo(r.createdAt)}</span>
                <span className="wrap" style={{ flexBasis: "100%", color: "var(--text-2)" }}>{requestSummary(r)}{r.answer ? <span className="faint"> · {r.answer.split("\n")[0]}</span> : null}</span>
              </div>
            ))}
          </div>
        </details>
      )}
      {(cleared.count > 0 || showCleared) && (
        <div style={{ marginTop: 8 }}>
          <button className="linkish small" onClick={() => setShowCleared(!showCleared)}>{showCleared ? "Hide cleared and read" : `Show cleared (${cleared.count})`}</button>
        </div>
      )}
    </section>
  );
};

const requestSummary = (r: AgentRequest): string => r.summary.split("\n")[0]!.slice(0, 120);

// --- settings --------------------------------------------------------------

type SettingsPatch = { allowlist?: string[]; packs?: string[]; caps?: Partial<Omit<Session["caps"], "leadMinutes" | "leadTurns">> & { /** null clears the cap. */ leadMinutes?: number | null; leadTurns?: number | null }; limits?: Partial<Session["limits"]> };

const CAP_HELP: Record<string, string> = {
  leadMinutes: "Optional: wall-clock life of one lead; then a fresh one takes over from notes/state.md. Empty: no cap",
  leadTurns: "Optional: model turns per lead life; then a fresh one takes over. Empty: no cap",
  progressMinutes: "Every this many minutes the lead posts a short progress update to the inbox; only the latest shows (Claude Code only). 0, the default: never, the board is the progress report",
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
    reviewer: session.caps.reviewer,
    leadMinutes: session.caps.leadMinutes ? String(session.caps.leadMinutes) : "",
    leadTurns: session.caps.leadTurns ? String(session.caps.leadTurns) : "",
    progressMinutes: String(session.caps.progressMinutes ?? 0),
    memory: session.limits.memory,
    cpus: String(session.limits.cpus),
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
  }, [session.allowlist, session.packs, session.caps, session.limits]);
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
              caps: { reviewer: f.reviewer, leadMinutes: f.leadMinutes.trim() ? Number(f.leadMinutes) : null, leadTurns: f.leadTurns.trim() ? Number(f.leadTurns) : null, progressMinutes: Number(f.progressMinutes) },
              limits: { memory: f.memory, cpus: Number(f.cpus) },
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
        <div className="two">
          <div style={{ alignSelf: "end", display: "grid", gap: 6 }}>
            <label className="chk" title="An independent reviewer judges every ticket the lead moves to review; off, the lead moves tickets to done itself. A ticket's own review setting wins."><input type="checkbox" checked={f.reviewer} onChange={(e) => set("reviewer", e.target.checked)} /> Independent review of each ticket</label>
          </div>
          {(["leadMinutes", "leadTurns"] as const).map((k) => (
            <label key={k}>
              {{ leadMinutes: "Lead minutes (optional)", leadTurns: "Lead turns (optional)" }[k]}
              <span className="help">{CAP_HELP[k]}</span>
              <input type="number" min={k === "leadMinutes" ? 10 : 20} placeholder="no cap" value={f[k]} onChange={(e) => set(k, e.target.value)} />
            </label>
          ))}
          <label>
            Progress update every (min)
            <span className="help">{CAP_HELP.progressMinutes}</span>
            <input type="number" min={0} value={f.progressMinutes} onChange={(e) => set("progressMinutes", e.target.value)} />
          </label>
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
      <summary><strong>Session settings</strong><span className="muted small">network, review, limits</span></summary>
      {body}
    </details>
  );
};

// --- drawer ------------------------------------------------------------------

const TicketDrawer = ({ ticket, board, repoNames, clock, held, sessionId, onClose, onOpen, onAction, onShowLog }: { ticket: Ticket; board: Board; repoNames: string[]; clock: TicketView; held: boolean; sessionId: string; onClose: () => void; onOpen: (tid: string) => void; onAction: (label: string, fn: () => Promise<unknown>) => Promise<void>; onShowLog: () => void }) => {
  const [note, setNote] = useState("");
  const neededBy = board.tickets.filter((t) => t.deps.includes(ticket.id));
  const now = useNow();
  const timing = ticketTiming(ticket, now);
  const drawerTiming = !timing ? "" : ticket.state === "done" ? timingLine(timing) : ticket.state === "in_progress" ? `In progress for ${inProgressClock(ticket, now)} · ${fmtSpan(timing.total)} since it first went into progress` : "";
  const [edit, setEdit] = useState(false);
  const toDraft = (t: Ticket) => ({ title: t.title, spec: t.spec, acceptance: t.acceptance.join("\n"), priority: t.priority, repos: t.repos, deps: t.deps.join(", "), review: t.review ?? "" });
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
        repos: draft.repos,
        deps: draft.deps.split(/[,\s]+/).filter(Boolean),
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
        {drawerTiming && <div className="facts mono" title="From the first move into progress; agent time is the lead's time on the ticket plus the reviewer's">{drawerTiming}</div>}
        <div className="facts">
          <span>{ticket.kind}</span>
          <span>priority <b>{ticket.priority}</b></span>
          <TicketRepos ticket={ticket} />
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
          {ticket.diff && !ticket.touched?.length && <span className="mono">+{ticket.diff.added} −{ticket.diff.removed} in {ticket.diff.files} file{ticket.diff.files === 1 ? "" : "s"}</span>}
          {ticket.cost?.usd ? <span>cost <b>{fmtUsd(ticket.cost.usd)}</b></span> : null}
          {ticket.review && <span title="Set by you for this ticket">{REVIEW_LABEL[ticket.review].toLowerCase()}</span>}
        </div>
        {held && <div className="banner signal">The lead is on this ticket. Stop the run to edit or move it.</div>}
        <div className="row">
          {USER_MOVES[ticket.state]?.map((s) => <button key={s} onClick={() => move(s)} disabled={held}>Move to {STATE_LABEL[s]?.toLowerCase()}</button>)}
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
              <label>Priority <span className="help">lower first; a hint the lead reads</span><input type="number" min={1} value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: Number(e.target.value) })} /></label>
              <label>Expected repositories <span className="help">A hint; the lead may touch others</span><RepoPicker names={repoNames} value={draft.repos} onChange={(repos) => setDraft({ ...draft, repos })} /></label>
              <label>Deps <span className="help">ticket ids, comma separated</span><input value={draft.deps} onChange={(e) => setDraft({ ...draft, deps: e.target.value })} /></label>
              <label>
                Review <span className="help">How the ticket is judged when the lead moves it to review. Only you set this; agents' tickets take the session's.</span>
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
            <h4>The lead's report</h4>
            <pre>{ticket.report}</pre>
          </section>
        )}
        {reports.length > 0 && (
          <details>
            <summary className="muted small">Reviews from {reports.length} run{reports.length === 1 ? "" : "s"}</summary>
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
            <input placeholder="Add a note for the lead" value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.key === "Enter" && note.trim() && onAction("note", () => api("POST", `${base}/notes`, { text: note })).then(() => setNote("")).catch(() => undefined)} />
            <button onClick={() => onAction("note", () => api("POST", `${base}/notes`, { text: note })).then(() => setNote("")).catch(() => undefined)} disabled={!note.trim()}>Add</button>
          </div>
        </section>
      </aside>
    </>
  );
};

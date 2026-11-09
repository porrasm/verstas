import { useEffect, useState } from "react";
import { api, type Board, type Inbox, type RepoState, type ReposState, type Session } from "../../api";
import { publishAllSummary, usePublishAll } from "./publishAll";

type RepoHandle = { state: ReposState | null; loading: boolean; error: string; refresh: (start?: boolean) => Promise<void> };
type Preview = { ok: boolean; error?: string; goal?: string; tickets?: { id: string; title: string }[] };
type Answer = {
  ok: true;
  created: string[];
  goal: boolean;
  history: string;
  summary: { tickets: number; detached: { repo: string; number: number }[] };
  run?: { id: number };
  startError?: string;
};

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What a repository's clone holds that the clear would discard, and whether it exists anywhere else. */
const repoLoss = (r: RepoState | undefined): { text: string; lost: boolean; unread: boolean } => {
  const b = r?.box;
  if (!r || !b) return { text: "not read yet", lost: false, unread: true };
  const pr = r.prs.at(-1);
  const commits = b.ahead ?? b.commits.length;
  const published = Boolean(pr && pr.headSha === b.head);
  const parts = [
    commits > 0 ? `${count(commits, "commit")}${published ? ` (in pull request #${pr!.number})` : ", not published"}` : "",
    b.dirty > 0 ? count(b.dirty, "uncommitted file") : "",
  ].filter(Boolean);
  if (!parts.length) return { text: "nothing of its own", lost: false, unread: false };
  return { text: `${parts.join(" and ")} discarded`, lost: (commits > 0 && !published) || b.dirty > 0, unread: false };
};

/**
 * New work in the same box: one dialog for what used to be four steps
 * (clear the inbox, sync every repository, clear the goal and the board,
 * import the next ones). It says what goes, with this session's numbers,
 * and what stays; takes the next goal and board, both optional; and can
 * start the run. With nothing typed it is a clear of the session.
 */
export function NewWorkDialog({ session, board, inbox, base, active, repoState, onClose, onDone }: { session: Session; board: Board; inbox: Inbox; base: string; active: boolean; repoState: RepoHandle; onClose: () => void; onDone: (notice: string) => Promise<void> }) {
  const [goal, setGoal] = useState("");
  const [goalTyped, setGoalTyped] = useState(false);
  const [paste, setPaste] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [working, setWorking] = useState<"" | "start" | "clear">("");
  const [err, setErr] = useState("");
  const all = usePublishAll(base, () => repoState.refresh());

  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && !working && onClose();
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [working, onClose]);

  // The clones as they are now, read once when the dialog opens: the numbers below are what would be lost.
  useEffect(() => {
    if (!active) void repoState.refresh(!repoState.state?.live);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!paste.trim()) {
      setPreview(null);
      return;
    }
    let stale = false;
    const t = setTimeout(() => {
      api<Preview>("POST", "/board/preview", { text: paste, repos: session.repos.map((r) => r.name) })
        .then((r) => !stale && setPreview(r))
        .catch((e: Error) => !stale && setPreview({ ok: false, error: e.message }));
    }, 300);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [paste, session.repos]);
  // A goal inside the paste fills the goal field until you type one yourself.
  useEffect(() => {
    if (!goalTyped && preview?.ok && preview.goal?.trim()) setGoal(preview.goal.trim());
  }, [preview, goalTyped]);

  const onGithub = session.repos.filter((r) => r.github);
  const local = session.repos.filter((r) => !r.github);
  const rows = onGithub.map((r) => ({ repo: r, st: repoState.state?.repos.find((x) => x.name === r.name) })).map((x) => ({ ...x, loss: repoLoss(x.st) }));
  const losing = rows.filter((x) => x.loss.lost);
  const unpublished = rows.some((x) => (x.st?.box?.ahead ?? 0) > 0 && x.st?.prs.at(-1)?.headSha !== x.st?.box?.head);
  const openPrs = rows.filter((x) => x.st?.prs.at(-1)?.state === "open");
  const doneTickets = board.tickets.filter((t) => t.state === "done").length;
  const goals = session.goals?.length ?? 0;
  const openRequests = inbox.requests.filter((r) => r.state === "open").length;
  const inboxItems = inbox.messages.length + inbox.ideas.length + inbox.requests.length;
  const hasWork = Boolean(goal.trim()) || Boolean(paste.trim());
  const pasteBad = Boolean(paste.trim()) && preview !== null && !preview.ok;
  const pasteChecking = Boolean(paste.trim()) && preview === null;

  const run = async (start: boolean) => {
    setWorking(start ? "start" : "clear");
    setErr("");
    try {
      const r = await api<Answer>("POST", `${base}/new-work`, { goal, board: paste, stopRun: active, start });
      const what = [r.goal ? "the goal is set" : "", r.created.length ? `${count(r.created.length, "ticket")} on the board` : ""].filter(Boolean).join(" and ");
      const started = r.run ? " The run started." : r.startError ? ` The run did not start: ${r.startError}` : "";
      const prs = r.summary.detached.length ? ` ${r.summary.detached.map((d) => `#${d.number}`).join(", ")} stay${r.summary.detached.length === 1 ? "s" : ""} open on GitHub; the next publish opens new pull requests.` : "";
      await onDone(`${what ? `New work: ${what}.` : "The session is cleared."}${started} What was cleared is kept in ${r.history}/ in the session folder.${prs}`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setWorking("");
    }
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !working && onClose()} role="dialog" aria-modal="true" aria-labelledby="new-work-title">
      <div className="dialog new-work">
        <h3 id="new-work-title">New work in this box</h3>
        <p className="lead" style={{ margin: 0 }}>The session keeps its container and settings and starts over with a new goal and board. Nothing of the earlier work stays in front of the next lead.</p>

        {active && <div className="banner warn small"><span>A run is active. It is stopped first; what the lead left is committed, then discarded with the rest.</span></div>}

        <div className="stack small" style={{ gap: 6 }}>
          <strong>What is cleared</strong>
          <ul className="plain">
            {rows.map(({ repo, st, loss }) => (
              <li key={repo.name}>
                <b>{repo.name}</b> goes to the latest <span className="mono">{repo.branch}</span>: <span className={loss.lost ? "err" : loss.unread ? "muted" : ""}>{loss.text}</span>
                {st?.prs.at(-1)?.state === "open" ? <span className="muted"> · pull request #{st.prs.at(-1)!.number} stays open</span> : null}
              </li>
            ))}
            {local.map((r) => <li key={r.name}><b>{r.name}</b> <span className="muted">is a local checkout and is left as it is</span></li>)}
            <li>{board.tickets.length ? <>The board: <b>{count(board.tickets.length, "ticket")}</b> removed ({doneTickets} done, {board.tickets.length - doneTickets} not)</> : <span className="muted">The board is empty</span>}</li>
            <li>{session.goal.trim() || goals ? <>The goal{goals ? <> and <b>{count(goals, "earlier goal")}</b></> : null}{session.goalMet ? ", with the lead's claim that it is met" : ""}</> : <span className="muted">No goal is set</span>}</li>
            <li>The lead's plan note, <span className="mono">notes/state.md</span></li>
            <li>{inboxItems ? <>The inbox: <b>{count(inboxItems, "item")}</b>{openRequests ? <span className="err"> · {count(openRequests, "request")} still open, closed unanswered</span> : null}</> : <span className="muted">The inbox is empty</span>}</li>
            <li>The Ask the box history{session.prompts?.length ? ` (${session.prompts.length})` : ""} and the published artifacts</li>
          </ul>
          {repoState.loading && <span className="muted">Reading the clones…</span>}
          {repoState.error && <span className="err">{repoState.error}</span>}
          {losing.length > 0 && (
            <div className="banner warn">
              <span>{losing.map((x) => x.repo.name).join(", ")} {losing.length === 1 ? "holds" : "hold"} work that exists nowhere else. It is deleted.</span>
              {unpublished && !active && <button className="sm end" onClick={() => void all.run()} disabled={all.working || Boolean(working)}>{all.working ? "Publishing…" : "Publish all as drafts first"}</button>}
            </div>
          )}
          {all.result && <div className="banner ok"><span>{publishAllSummary(all.result)}</span></div>}
          {all.error && <div className="banner warn"><span>{all.error}</span></div>}
          {openPrs.length > 0 && <div className="muted">Open pull requests stay on GitHub. The next publish opens new ones, so they do not receive the new work's commits.</div>}
          <div className="muted">
            <strong style={{ color: "var(--text)" }}>Kept:</strong> the container and everything installed in it, the environment notes, the repositories, recipes, network, agent and review settings, the run logs and cost. A copy of what is cleared goes to <span className="mono">history/</span> in the session folder, where no agent reads it.
          </div>
        </div>

        <label>
          Goal <span className="help">Optional. What the lead works toward, and what done looks like</span>
          <textarea
            value={goal}
            onChange={(e) => {
              setGoal(e.target.value);
              setGoalTyped(Boolean(e.target.value.trim()));
            }}
            disabled={Boolean(working)}
            style={{ minHeight: 90 }}
            placeholder="Leave empty to work the board alone"
            autoFocus
          />
        </label>
        <label>
          Board <span className="help">Optional. JSON or markdown, as for Import tickets; a goal in it fills the field above</span>
          <textarea className={`mono ${pasteBad ? "invalid" : ""}`} value={paste} onChange={(e) => setPaste(e.target.value)} disabled={Boolean(working)} style={{ minHeight: 110 }} placeholder={'{ "goal": "…", "tickets": [ { "title": "…", "spec": "…", "acceptance": ["…"] } ] }'} />
        </label>
        {pasteBad && <div className="banner warn small"><span>{preview?.error}</span></div>}
        {preview?.ok && preview.tickets && <div className="muted small">{count(preview.tickets.length, "ticket")} start as ready: {preview.tickets.map((t) => `${t.id} ${t.title}`).join(" · ").slice(0, 300)}</div>}
        {err && <div className="banner warn small"><span>{err}</span></div>}

        <div className="row">
          {hasWork && <button className="pri" onClick={() => void run(true)} disabled={Boolean(working) || pasteBad || pasteChecking || all.working}>{working === "start" ? "Syncing and clearing…" : "Clear and start the run"}</button>}
          <button className={hasWork ? "" : "warn"} onClick={() => void run(false)} disabled={Boolean(working) || pasteBad || pasteChecking || all.working}>{working === "clear" ? "Syncing and clearing…" : hasWork ? "Clear, do not start" : "Clear session"}</button>
          <button className="quiet" onClick={onClose} disabled={Boolean(working)}>Cancel</button>
        </div>
        {all.dialog}
      </div>
    </div>
  );
}

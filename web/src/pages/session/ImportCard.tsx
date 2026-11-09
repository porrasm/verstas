import { useEffect, useState } from "react";
import { api } from "../../api";

type Brief = { id: string; title: string; state: string; deps: string[] };
/** What `POST /sessions/:id/board/import` answers, for a dry run and for the import itself. */
export type ImportAnswer =
  | { ok: false; error: string }
  | {
      ok: true;
      mode: "add" | "merge";
      created: string[];
      updated: string[];
      skipped: { title: string; reason: string }[];
      renumbered: { from: string; to: string }[];
      matching: string[];
      goal?: string;
      goalChanged: boolean;
      tickets: { created: Brief[]; updated: Brief[] };
    };

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** One sentence on what an import did or would do. */
export const importSummary = (r: Extract<ImportAnswer, { ok: true }>, done: boolean): string => {
  const parts = [
    r.created.length ? `${done ? "Added" : "Adds"} ${plural(r.created.length, "ticket")}${r.created.length ? ` (${r.created[0]}${r.created.length > 1 ? `–${r.created.at(-1)}` : ""})` : ""}` : "",
    r.updated.length ? `${done ? "updated" : "updates"} ${plural(r.updated.length, "ticket")} (${r.updated.join(", ")})` : "",
  ].filter(Boolean);
  const first = parts.join(", ") || (done ? "Nothing imported" : "Nothing to import");
  return `${first.charAt(0).toUpperCase()}${first.slice(1)}.`;
};

/**
 * Paste a board onto this session's board. The page asks the server what the
 * paste would do while you type (a dry run), so the button never surprises:
 * new tickets and their ids, tickets that would be rewritten, and a goal the
 * paste carries.
 */
export function ImportCard({ base, tickets, currentGoal, busy, onDone, onCancel }: { base: string; tickets: number; currentGoal: string; busy: boolean; onDone: (notice: string) => void; onCancel: () => void }) {
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"add" | "merge">("add");
  const [setGoal, setSetGoal] = useState(false);
  const [preview, setPreview] = useState<ImportAnswer | null>(null);
  const [working, setWorking] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!text.trim()) {
      setPreview(null);
      return;
    }
    let stale = false;
    const t = setTimeout(() => {
      api<ImportAnswer>("POST", `${base}/board/import`, { text, state: "ready", mode, setGoal, dryRun: true })
        .then((r) => !stale && setPreview(r))
        .catch((e: Error) => !stale && setPreview({ ok: false, error: e.message }));
    }, 300);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [base, text, mode, setGoal]);

  const ok = preview?.ok ? preview : null;
  // Updating by id is only a choice when the paste names tickets this board has.
  const canMerge = Boolean(ok && ok.matching.length);
  useEffect(() => {
    if (ok && !ok.matching.length && mode === "merge") setMode("add");
  }, [ok, mode]);

  const run = async () => {
    setWorking(true);
    setErr(null);
    try {
      const r = await api<Extract<ImportAnswer, { ok: true }>>("POST", `${base}/board/import`, { text, state: "ready", mode, setGoal });
      const skipped = r.skipped.length ? ` Skipped: ${r.skipped.map((s) => `${s.title} (${s.reason})`).join("; ")}.` : "";
      onDone(`${importSummary(r, true)}${r.goalChanged ? " The goal is now the one from the paste." : ""}${skipped}`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setWorking(false);
    }
  };

  const goalDiffers = Boolean(ok?.goal && ok.goal.trim() !== currentGoal.trim());
  return (
    <section className="card stack tight">
      <div className="row">
        <h3>Import tickets</h3>
        <span className="muted small">JSON or markdown, see docs/BOARD.md. New tickets start as ready.</span>
        <button className="quiet sm end" onClick={onCancel}>Cancel</button>
      </div>
      <textarea id="import" className={`mono ${preview && !preview.ok ? "invalid" : ""}`} value={text} onChange={(e) => setText(e.target.value)} style={{ minHeight: 200 }} placeholder={'{ "tickets": [ { "title": "…", "spec": "…", "acceptance": ["…"] } ] }'} autoFocus />
      {preview && !preview.ok && <div className="banner warn"><span>{preview.error}</span></div>}
      {err && <div className="banner warn"><span>{err}</span></div>}
      {canMerge && ok && (
        <div className="stack tight">
          <label className="row small">
            <input type="radio" name="import-mode" checked={mode === "add"} onChange={() => setMode("add")} />
            <span>Add as new tickets <span className="muted">the board's own {ok.matching.join(", ")} stay as they are</span></span>
          </label>
          <label className="row small">
            <input type="radio" name="import-mode" checked={mode === "merge"} onChange={() => setMode("merge")} />
            <span>Update the {plural(ok.matching.length, "ticket")} with the same id <span className="muted">for a board you exported from this session and revised</span></span>
          </label>
        </div>
      )}
      {ok && (
        <div className="stack tight small">
          <div><b>{importSummary(ok, false)}</b>{tickets > 0 && ok.created.length > 0 ? <span className="muted"> The {plural(tickets, "ticket")} on the board stay.</span> : null}</div>
          {ok.renumbered.length > 0 && (
            <div className="muted">
              The paste's ids are taken on this board, so its tickets are renumbered: {ok.renumbered.slice(0, 6).map((r) => `${r.from} → ${r.to}`).join(", ")}{ok.renumbered.length > 6 ? `, and ${ok.renumbered.length - 6} more` : ""}. Dependencies inside the paste follow.
            </div>
          )}
          <div className="muted">
            {[...ok.tickets.created.map((t) => `${t.id} ${t.title}${t.deps.length ? ` (after ${t.deps.join(", ")})` : ""}`), ...ok.tickets.updated.map((t) => `${t.id} ${t.title} (updated)`)].join(" · ").slice(0, 600)}
          </div>
          {ok.goal && goalDiffers && (
            <label className="row small">
              <input type="checkbox" checked={setGoal} onChange={(e) => setSetGoal(e.target.checked)} />
              <span>Also replace the goal with the one in the paste: <span className="muted">“{ok.goal.length > 140 ? `${ok.goal.slice(0, 140)}…` : ok.goal}”</span></span>
            </label>
          )}
        </div>
      )}
      <div className="row">
        <button className="pri end" onClick={() => void run()} disabled={!ok || working || busy || (!ok.created.length && !ok.updated.length)}>
          {mode === "merge" && ok?.updated.length ? "Import and update" : "Import"}
        </button>
      </div>
    </section>
  );
}

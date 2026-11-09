import { useEffect, useState, type ReactNode } from "react";
import { api, type PullRecord } from "../../api";

export type PublishAllRow = { repo: string; outcome: "opened" | "updated" | "skipped" | "failed" | "ready"; reason?: string; pr?: PullRecord; commits?: number | null; dirty?: number };
export type PublishAllResult = { published: boolean; flagged: { repo: string; paths: string[] }[]; rows: PublishAllRow[] };

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One sentence on what Publish all did. */
export const publishAllSummary = (r: PublishAllResult): string => {
  const n = (o: PublishAllRow["outcome"]) => r.rows.filter((x) => x.outcome === o).length;
  const parts = [
    n("opened") ? `opened ${count(n("opened"), "draft pull request")}` : "",
    n("updated") ? `updated ${count(n("updated"), "pull request")}` : "",
    n("failed") ? `${n("failed")} failed` : "",
    n("skipped") ? `${n("skipped")} left out` : "",
  ].filter(Boolean);
  const text = parts.join(", ") || "nothing to publish";
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
};

/** What a row says about its repository after Publish all. */
export const publishRowText = (row: PublishAllRow): { text: string; tone: "ok" | "muted" | "err" } =>
  row.outcome === "opened" || row.outcome === "updated"
    ? { text: `${row.outcome} #${row.pr?.number ?? "?"}${row.dirty ? ` · ${count(row.dirty, "uncommitted file")} not published` : ""}`, tone: "ok" }
    : row.outcome === "failed"
      ? { text: `failed: ${row.reason ?? "unknown error"}`, tone: "err" }
      : { text: `left out: ${row.reason ?? "nothing to publish"}`, tone: "muted" };

/**
 * Publish all in one click: a draft pull request for every repository with
 * commits, an update for every open one. It asks once, and only when the
 * changes touch build or CI files; `dialog` is that question, to render
 * anywhere. `result` holds what happened per repository until dismissed.
 */
export const usePublishAll = (base: string, onDone: () => Promise<void>) => {
  const [working, setWorking] = useState(false);
  const [result, setResult] = useState<PublishAllResult | null>(null);
  const [asking, setAsking] = useState<PublishAllResult | null>(null);
  const [error, setError] = useState("");
  const run = async (acknowledgeFlagged = false) => {
    setWorking(true);
    setError("");
    try {
      const r = await api<PublishAllResult>("POST", `${base}/publish-all`, { acknowledgeFlagged });
      if (!r.published) {
        setAsking(r);
        return;
      }
      setAsking(null);
      setResult(r);
      await onDone();
    } catch (e) {
      setAsking(null);
      setError((e as Error).message);
    } finally {
      setWorking(false);
    }
  };
  useEffect(() => {
    if (!asking) return;
    const key = (e: KeyboardEvent) => e.key === "Escape" && !working && setAsking(null);
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [asking, working]);
  const going = asking?.rows.filter((r) => r.outcome === "ready") ?? [];
  const dialog: ReactNode = asking ? (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !working && setAsking(null)} role="dialog" aria-modal="true" aria-labelledby="publish-all-title">
      <div className="dialog">
        <h3 id="publish-all-title">Publish {count(going.length, "repository", "repositories")}: build or CI files changed</h3>
        <div className="stack small" style={{ gap: 8 }}>
          <div>These files change how the build or CI runs. Once pushed, each repository's CI runs the agents' code with whatever secrets it can read. Nothing is pushed yet.</div>
          {asking.flagged.map((f) => (
            <div key={f.repo}>
              <b>{f.repo}</b> <span className="mono">{f.paths.slice(0, 12).join(", ")}{f.paths.length > 12 ? ` and ${f.paths.length - 12} more` : ""}</span>
            </div>
          ))}
        </div>
        <div className="row">
          <button className="pri" onClick={() => void run(true)} disabled={working}>{working ? "Publishing…" : "I looked at them; publish all"}</button>
          <button className="quiet" onClick={() => setAsking(null)} disabled={working}>Cancel</button>
        </div>
      </div>
    </div>
  ) : null;
  return { run: () => run(false), working, result, error, dialog, dismiss: () => { setResult(null); setError(""); } };
};

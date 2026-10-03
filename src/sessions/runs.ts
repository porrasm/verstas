import { promises as fs } from "node:fs";
import path from "node:path";
import type { Run } from "../core/types.js";

/** Reading a session's runs/ directory: the UI API and the remote dashboard both need it. */

/** Every run.json under runs/, oldest first; unreadable ones are skipped. */
export const allRuns = async (runsDir: string): Promise<Run[]> => {
  const out: Run[] = [];
  try {
    const ids = (await fs.readdir(runsDir)).map(Number).filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => a - b);
    for (const id of ids) {
      try {
        out.push(JSON.parse(await fs.readFile(path.join(runsDir, String(id), "run.json"), "utf8")) as Run);
      } catch {
        continue;
      }
    }
  } catch {
    return out;
  }
  return out;
};

/** What the UI shows in a header: money spent over every run, how many runs, when something last happened. */
export const runTotals = (runs: Run[], createdAt: string): { usd: number; runs: number; lastActivityAt: string } => {
  let last = createdAt;
  let usd = 0;
  for (const r of runs) {
    usd += r.cost.usd ?? 0;
    for (const t of [r.startedAt, r.endedAt]) if (t && t > last) last = t;
  }
  return { usd, runs: runs.length, lastActivityAt: last };
};

export const lastRun = async (runsDir: string): Promise<Run | undefined> => {
  try {
    const ids = (await fs.readdir(runsDir)).map(Number).filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => b - a);
    for (const id of ids) {
      try {
        return JSON.parse(await fs.readFile(path.join(runsDir, String(id), "run.json"), "utf8")) as Run;
      } catch {
        continue;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
};

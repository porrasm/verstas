import { test, expect } from "@playwright/test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { emptyBoard, importBoard, transition } from "../../src/board/board.js";
import { inboxSchema, sessionSchema, type PullRecord } from "../../src/core/types.js";
import { clearSession } from "../../src/sessions/new-work.js";
import { publishTarget } from "../../src/sessions/publish.js";
import { sessionApi } from "./helpers/session-api.js";

/** New work: the session keeps its box and settings and loses everything that described the earlier work. */

const pr = (number: number, state: PullRecord["state"]): PullRecord => ({ round: 1, number, url: `https://github.com/acme/x/pull/${number}`, remoteBranch: "verstas/s-1", headSha: "a".repeat(40), base: "main", title: "Earlier", state, publishedAt: "2026-11-09T08:00:00.000Z" });
const usedSession = {
  initializedAt: "2026-11-08T00:00:00.000Z",
  goal: "old goal",
  goalSince: "2026-11-08T10:00:00.000Z",
  goalMet: { at: "2026-11-09T07:00:00.000Z", runId: 3, note: "all done" },
  goals: [{ text: "older goal", from: "2026-11-08T00:00:00.000Z", until: "2026-11-08T10:00:00.000Z", outcome: "revised" }],
  prompts: [{ at: "2026-11-09T06:00:00.000Z", runId: 2, text: "why slow?", reply: "disk" }],
  allowlist: ["registry.npmjs.org"],
  caps: { reviewer: false },
  state: "finished",
};
const usedBoard = () => {
  const b = importBoard(emptyBoard("old goal"), { tickets: [{ id: "T-1", title: "Schema", state: "ready" }, { id: "T-2", title: "Engine", deps: ["T-1"] }] }).board;
  return transition(transition(b, "T-1", "in_progress"), "T-1", "done");
};
const usedInbox = {
  messages: [{ id: "M-1", text: "an update", createdAt: "2026-11-09T08:00:00.000Z" }],
  ideas: [{ id: "I-1", title: "An idea", pitch: "Why", createdAt: "2026-11-09T08:10:00.000Z" }],
  requests: [{ id: "R-1", summary: "a question", actions: [], state: "open", createdAt: "2026-11-09T08:00:00.000Z" }],
};

test("a cleared session keeps its repositories and settings, and an open pull request is detached so the next publish opens a new one", () => {
  const session = sessionSchema.parse({
    id: "2026-11-09-s",
    name: "s",
    createdAt: "2026-11-08T00:00:00.000Z",
    ...usedSession,
    repos: [
      { name: "api", github: "acme/api", branch: "main", runBranch: "verstas/run", prs: [pr(4, "open")] },
      { name: "docs", github: "acme/docs", branch: "main", runBranch: "verstas/run", prs: [pr(7, "merged")] },
    ],
  });
  const { next, summary } = clearSession({ session, board: usedBoard(), inbox: inboxSchema.parse(usedInbox) }, "2026-11-09T10:00:00.000Z");
  expect(summary).toMatchObject({ tickets: 2, goals: 2, messages: 1, ideas: 1, requests: 1, openRequests: 1, prompts: 1, detached: [{ repo: "api", number: 4 }] });
  expect(next.board.tickets).toEqual([]);
  expect(next.inbox).toEqual({ requests: [], messages: [], ideas: [] });
  expect(next.session).toMatchObject({ goal: "", goals: [], prompts: [], state: "created", allowlist: ["registry.npmjs.org"], caps: { reviewer: false } });
  expect("goalMet" in next.session).toBe(false);
  expect("goalSince" in next.session).toBe(false);
  // The open pull request is still on record, but the next publish is round 2, a new pull request.
  expect(publishTarget(session.repos[0]!.prs)).toMatchObject({ round: 1, update: { number: 4 } });
  expect(next.session.repos[0]!.prs!.at(-1)).toMatchObject({ number: 4, state: "open", detached: true });
  expect(publishTarget(next.session.repos[0]!.prs)).toEqual({ round: 2, update: null });
  expect(next.session.repos[1]!.prs).toEqual(session.repos[1]!.prs);
});

test("the new-work route clears in one step, keeps a copy, sets the new goal and board, and can start the run", async () => {
  const s = await sessionApi({ session: usedSession, board: usedBoard(), inbox: usedInbox });
  await fs.mkdir(s.paths.notes, { recursive: true });
  await fs.writeFile(path.join(s.paths.notes, "state.md"), "# Plan\n- old plan\n");
  await fs.writeFile(path.join(s.paths.notes, "environment.md"), "postgres runs on 5432\n");
  await fs.mkdir(s.paths.artifacts, { recursive: true });
  await fs.writeFile(path.join(s.paths.artifacts, "report.txt"), "old report");
  const board = JSON.stringify({ goal: "the paste's goal", tickets: [{ id: "T-1", title: "Parser" }, { id: "T-2", title: "Printer", deps: ["T-1"] }] });
  try {
    // A paste that cannot be read stops everything before anything is cleared.
    const bad = await s.call("POST", "/new-work", { board: "{ nope" });
    expect(bad.status).toBe(400);
    expect((await s.docs()).board.tickets).toHaveLength(2);

    // An active run refuses unless the call says to stop it.
    s.state.running = true;
    expect((await s.call("POST", "/new-work", { goal: "x" })).status).toBe(409);
    expect((await s.docs()).session.goal).toBe("old goal");

    const r = await s.call("POST", "/new-work", { goal: "new goal", board, stopRun: true, start: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, created: ["T-1", "T-2"], goal: true, planNote: true, summary: { tickets: 2, goals: 2, openRequests: 1 }, run: { id: 7 } });
    expect(s.state.started).toBe(1);

    const docs = await s.docs();
    // The typed goal wins over the paste's; the board's own goal field follows.
    expect(docs.session).toMatchObject({ goal: "new goal", goals: [], prompts: [] });
    expect(docs.session.goalMet).toBeUndefined();
    expect(docs.board.goal).toBe("new goal");
    expect(docs.board.tickets.map((t) => [t.id, t.title, t.state, t.deps])).toEqual([["T-1", "Parser", "ready", []], ["T-2", "Printer", "ready", ["T-1"]]]);
    expect(docs.inbox).toEqual({ requests: [], messages: [], ideas: [] });
    // The plan note is gone, the environment note stays.
    expect(await fs.readFile(path.join(s.paths.notes, "state.md"), "utf8").catch(() => null)).toBeNull();
    expect(await fs.readFile(path.join(s.paths.notes, "environment.md"), "utf8")).toContain("postgres");
    // The copy: board, inbox, goals, prompts, the plan note and the artifacts, outside the workspace.
    const dir = path.join(s.paths.dir, r.body.history);
    expect(path.relative(s.paths.workspace, dir).startsWith("..")).toBe(true);
    expect(JSON.parse(await fs.readFile(path.join(dir, "board.json"), "utf8")).tickets).toHaveLength(2);
    expect(JSON.parse(await fs.readFile(path.join(dir, "goals.json"), "utf8"))).toMatchObject({ goal: "old goal", goals: [{ text: "older goal" }] });
    expect(JSON.parse(await fs.readFile(path.join(dir, "inbox.json"), "utf8")).requests).toHaveLength(1);
    expect(await fs.readFile(path.join(dir, "state.md"), "utf8")).toContain("old plan");
    expect(await fs.readFile(path.join(dir, "artifacts", "report.txt"), "utf8")).toBe("old report");
    expect(await fs.stat(s.paths.artifacts).catch(() => null)).toBeNull();
  } finally {
    await s.close();
  }
});

test("with nothing given it is a clear: no goal, an empty board, and no run starts; the paste's goal is used when none is typed", async () => {
  const s = await sessionApi({ session: usedSession, board: usedBoard(), inbox: usedInbox });
  try {
    const r = await s.call("POST", "/new-work", { start: true });
    expect(r.body).toMatchObject({ ok: true, created: [], goal: false, planNote: false });
    expect(r.body.run).toBeUndefined();
    expect(s.state.started).toBe(0);
    const docs = await s.docs();
    expect(docs.session.goal).toBe("");
    expect(docs.board).toMatchObject({ goal: "", tickets: [] });

    await s.call("POST", "/new-work", { board: JSON.stringify({ goal: "from the paste", tickets: [{ title: "One" }] }) });
    expect((await s.docs()).session.goal).toBe("from the paste");
  } finally {
    await s.close();
  }
});

test("a session that is still a plan has no box to keep", async () => {
  const s = await sessionApi({ session: { initializedAt: null, goal: "g" } });
  try {
    expect((await s.call("POST", "/new-work", {})).status).toBe(409);
    expect((await s.docs()).session.goal).toBe("g");
  } finally {
    await s.close();
  }
});

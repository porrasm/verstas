import { test, expect } from "@playwright/test";
import { emptyBoard, getTicket, importBoard, transition } from "../../src/board/board.js";
import { ticketSchema, ticketTiming, type Board } from "../../src/core/types.js";

/** Ticket timing: what transition() records and how ticketTiming splits it. */

/** Runs `fn` with the clock at `iso`: now() reads `new Date()`. */
const RealDate = Date;
const at = <T>(iso: string, fn: () => T): T => {
  const fixed = new RealDate(iso).getTime();
  globalThis.Date = class extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length) super(...(args as [string]));
      else super(fixed);
    }
    static override now() {
      return fixed;
    }
  } as DateConstructor;
  try {
    return fn();
  } finally {
    globalThis.Date = RealDate;
  }
};

const t0 = "2026-10-07T10:00:00.000Z";
const plus = (min: number) => new RealDate(new RealDate(t0).getTime() + min * 60_000).toISOString();

test("transition adds up the time of every visit to a state and remembers the first claim", () => {
  let b: Board = at(t0, () => importBoard(emptyBoard(), { tickets: [{ id: "T-1", title: "Engine", state: "ready" }] }).board);
  expect(getTicket(b, "T-1").stateSince).toBe(t0);
  // Queued 5 min, worked 10, requeued 3, worked 7, judged 2, done.
  b = at(plus(5), () => transition(b, "T-1", "in_progress"));
  b = at(plus(15), () => transition(b, "T-1", "ready"));
  b = at(plus(18), () => transition(b, "T-1", "in_progress"));
  b = at(plus(25), () => transition(b, "T-1", "review"));
  b = at(plus(27), () => transition(b, "T-1", "done"));
  const t = getTicket(b, "T-1");
  expect(t.firstClaimAt).toBe(plus(5));
  expect(t.stateSince).toBe(plus(27));
  expect(t.timeIn).toEqual({ ready: 8 * 60, in_progress: 17 * 60, review: 2 * 60 });
  expect(t.readyBeforeClaim).toBe(5 * 60);
  // A loop run: the workers reported 15 min between them.
  const loop = ticketTiming({ ...t, agentSeconds: 15 * 60 }, "loop", plus(90))!;
  expect(loop).toEqual({ working: 17 * 60, judging: 2 * 60, waitingOnYou: 0, requeued: 3 * 60, agent: 15 * 60, total: 22 * 60 });
  // A lead: its time in in_progress, plus the reviewer's 2 min.
  const lead = ticketTiming({ ...t, agentSeconds: 2 * 60 }, "lead", plus(90))!;
  expect(lead.agent).toBe(19 * 60);
  expect(lead.total).toBe(22 * 60);
});

test("an open ticket counts its current visit up to now; waiting is time on you", () => {
  let b: Board = at(t0, () => importBoard(emptyBoard(), { tickets: [{ id: "T-1", title: "Engine", state: "ready" }] }).board);
  b = at(t0, () => transition(b, "T-1", "in_progress"));
  b = at(plus(4), () => transition(b, "T-1", "waiting"));
  const x = ticketTiming(getTicket(b, "T-1"), "loop", plus(64))!;
  expect(x.waitingOnYou).toBe(60 * 60);
  expect(x.working).toBe(4 * 60);
  expect(x.total).toBe(64 * 60);
  // Never claimed: no timing yet.
  const fresh = at(t0, () => importBoard(emptyBoard(), { tickets: [{ id: "T-2", title: "x" }] }).board);
  expect(ticketTiming(getTicket(fresh, "T-2"), "loop")).toBeNull();
});

test("a ticket from before timing parses, shows nothing, and starts its clock at its next move", () => {
  const old = ticketSchema.parse({ id: "T-1", title: "Old", state: "ready", createdAt: t0, updatedAt: t0 });
  expect(old.stateSince).toBeUndefined();
  expect(ticketTiming(old, "lead")).toBeNull();
  const b: Board = { ...emptyBoard(), tickets: [old] };
  const moved = getTicket(at(plus(3), () => transition(b, "T-1", "in_progress")), "T-1");
  expect(moved.stateSince).toBe(plus(3));
  expect(moved.timeIn).toBeUndefined();
  expect(moved.firstClaimAt).toBe(plus(3));
});

test("a user import that moves a known ticket between backlog and ready keeps the clock", () => {
  let b: Board = at(t0, () => importBoard(emptyBoard(), { tickets: [{ id: "T-1", title: "Engine" }] }).board);
  b = at(plus(10), () => importBoard(b, { tickets: [{ id: "T-1", title: "Engine", state: "ready" }] }).board);
  const t = getTicket(b, "T-1");
  expect(t.state).toBe("ready");
  expect(t.timeIn).toEqual({ backlog: 600 });
  expect(t.stateSince).toBe(plus(10));
});

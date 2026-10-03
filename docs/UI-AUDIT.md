# Verstas web UI audit (2026-10-03)

Scope: the four pages of the React UI under `web/src` as served by the host
app on 127.0.0.1:4700, viewed at 1440, 1100, 768 and 375 px wide, with the
finished session `2026-10-03-capability-test-v5` (11 done tickets, 6 runs) and
a throwaway session `2026-10-03-ui-audit-scratch` (21 tickets in backlog and
ready, long titles, many deps; never run). No agents were started.

The use case: a person leaves agents working for hours or days and comes back
to check progress, answer requests, and take the work out. The page they live
on is the session page. Everything below is ordered by how much it matters
for that.

## 1. Confirmed UI bugs

| # | Where | What happens | Cause |
|---|-------|--------------|-------|
| B1 | Board card | A long unbroken title (path, identifier, URL) runs out of its card and across the neighbouring columns. Seen with T-5 on the scratch board. | `.tk` has no `overflow-wrap`/`min-width: 0`; grid columns are `minmax(150px, 1fr)` and the card text is not allowed to break. |
| B2 | Board card | The `deps T-1 T-2 T-3 …` pill is clipped at the card edge when a ticket has many deps (T-6 scratch, T-11 capability). | `.pill` is `white-space: nowrap`; the meta row wraps pills but not the text inside one. |
| B3 | Session page layout | All six columns stretch to the height of the tallest column. With 11 done tickets the five empty columns are ~1700 px of empty panel and the live log sits far below the fold. With 17 backlog tickets the same. The log is the main monitoring view and is effectively hidden. | `.board` is a grid with stretch alignment and no max height; the log is placed after the board in the same vertical `.grid`. |
| B4 | Session header | The action buttons (Start run, Plan, Import, Export…) wrap onto a second line at every width tested, including 1440 px, because the first row also holds the title, status pill, stats line and model select. | One `.row` flex container with `flex-wrap`, `margin-left: auto` on the button group. |
| B5 | Live log | Timestamps wrap to two lines ("05:10:45" / "PM") in 12-hour locales, so every event row is two lines tall and the time column is misaligned. | `.ev` grid first column is 58 px; `fmtTime` uses the locale's 12/24-hour setting with seconds. |
| B6 | Live log | Tool results with an empty summary render as a bare `T-12 →` line. Two such rows in the capability log. | `evText` prints `→ ${summary}` without checking for an empty summary. |
| B7 | Settings page, Session settings panel | "Image and ports" and the caps grid render as a single column of full-width inputs instead of two columns. | `className="form two"` is on one element, but the CSS rule is the descendant selector `.form .two`. Only New session (where `.two` sits inside `.form`) gets two columns. |
| B8 | Settings page | The "name + path + Add" row and the "paste token + Save" row break into three and two lines: each input takes the full width and pushes the button down. | Global `input { width: 100% }` inside a flex `.row` without `flex: 1`/`min-width: 0`. |
| B9 | Ticket drawer | Same as B8 for "add a note for the next worker" + Add: the button lands under the input. | Same cause. |
| B10 | Ticket drawer | Opening a ticket on a session whose latest run did not touch it fires a request for that run's report and logs a 404 in the console on every open. | Report fetch always targets `run?.id`; only the capability T-1 open produced `runs/6/tickets/T-1 → 404`. |
| B11 | Session header | Raw internal strings leak into the status line: `sandbox stopped/stopped`, `sandbox absent/absent`, and a doubled separator `0/21 done · · sandbox` when there is no cost. | Status line is a hand-built string with `·` separators that do not skip empty parts. |
| B12 | Sessions list | The goal is cut at 120 characters mid-word with no ellipsis ("…This goal is i"). | `goal.slice(0, 120)`. |
| B13 | Top bar | Below ~900 px the nav and status chips overlap and wrap into the brand ("New / session", "docker / 29.8.1" on two lines). Mobile is not the target, but the same squeeze starts when the drawer (640 px) is open on a laptop. | `.top` has fixed height 46 px and no wrap/collapse rule. |
| B14 | Board at narrow widths | Below ~1000 px the board scrolls horizontally with no visual hint; "Waiting · blocked" and "Done" are simply cut off at the right edge, and the overflowing T-5 title (B1) bleeds into the cut area. | `overflow-x: auto` with no scroll shadow or column snapping. |

## 2. Information that is missing or misleading

| # | Where | Issue |
|---|-------|-------|
| I1 | Session header, sessions list | Cost shown is the **latest run's** cost (run 6: $0.09). The session has spent $0.89 across six runs (sum of ticket costs). A person checking the bill sees a tenth of it. Show session total, with the current run in parentheses while it runs. |
| I2 | Live log | Only the latest run's events are shown; earlier runs (1–5 here) cannot be reached from the UI at all, although the files exist under `runs/<n>/`. There is no run selector and no indication that there were earlier runs. |
| I3 | Session header | No start time, no duration, no "last event at". For a thing meant to run for days, "last activity 3 min ago" is the first question. The sessions list has no created/last-activity column either, so rows cannot be ordered by recency. |
| I4 | Sessions list | No per-session progress at a glance: the Board column is a text string like `4 ready · 17 backlog`. A tiny stacked bar (done / in progress / waiting / rest) would answer "how far along" without reading. |
| I5 | Board card | Priority is not visible on the card (it only orders the column). Pinned is a word in the id line. Cost per ticket exists in the data but is shown only in the drawer. |
| I6 | Board, waiting column | Waiting tickets show the request kind as a pill, but the inbox is on the right and there is no link between the card and the request it is waiting on. |
| I7 | Inbox | "Decided requests" is a one-line-per-item list with id, kind, state and raw answer. There is no time, no ticket link, no way to see the original request text after deciding. |
| I8 | Session settings | Every field is `defaultValue` + `onBlur` save. There is no saved/unsaved indication, no validation message, and a failed save surfaces only as the generic error line at the top of the page, far from the field. |
| I9 | Session header | The status pill mixes session state, run state and current ticket into one string (`running · T-7`, `finished`, `paused · budget`). The run's `pauseReason` and `resumeAt` (rate-limit back-off) deserve their own line with a countdown. |
| I10 | Export bundles | The result is shown as a card that appears *above* the board and pushes everything down; it is easy to miss that it appeared, and the commands have no copy button. |
| I11 | Import board | Same pattern; the result of an import (created / updated / skipped) is written into the red error line even when nothing went wrong. |
| I12 | Live log | A `text` event from the worker can be a multi-paragraph block (the system prompt echo in run 6 is ~1500 characters). It is rendered as one flat line of mono text, indistinguishable from a tool call. |

## 3. Interaction and navigation

- **Drawer**: no backdrop, no Escape to close, no focus trap; the board stays clickable underneath, and clicking another card swaps the drawer content without any transition. The open ticket is not in the URL, so refresh or a shared link loses it.
- **Autoscroll in the log** always jumps to the bottom on every new event, so reading an earlier line during an active run is impossible. Needs "stick to bottom only if already at bottom" plus a "jump to latest" button.
- **Native dialogs**: `prompt()` for a custom model id, `confirm()` for delete ticket and delete session. They look foreign in a dark app and cannot be styled or explained.
- **Delete session** is a red button on every row of the list, beside Open. One mis-click away from removing containers and a directory, and the confirm text is the only guard.
- **Model is set in two places** (header select, Session settings input) with slightly different wording. Keep one.
- **Goal line** repeats the model, repos and allowlist, which are also in the header and in settings. The goal itself, the single most important sentence, is a muted 12 px line.
- **New session form**: the "Image" field is read-only with an empty cell beside it; the allowlist textarea stretches to the height of the caps grid (~250 px) because of grid stretch; the sticky footer hides the "Start the planner" checkbox when the window is short. Nothing explains what a cap does or what happens when it is hit.
- **No empty states with a next step** on the session page: a session with no tickets just shows six empty columns and "No events yet."; it should say "Paste a board or run the planner" with the two buttons.
- **No keyboard path**: cards are `div onClick` with no `role`, `tabIndex` or focus ring; column headers are not headings; the status dots in the top bar have no text alternative beyond "token".

## 4. Visual design

The palette (near-black green-grey, mint accent, amber signal, red warn) is appropriate for a tool you glance at for hours; it is calm and the state colours are distinct. The problems are hierarchy and finish, not colour choice.

- **Fonts are not loaded.** `app.css` asks for IBM Plex Sans and JetBrains Mono but nothing links or bundles them, so every machine renders system-ui and Menlo. Either ship the fonts or design for system fonts.
- **Everything is 12–14 px and the same weight.** Title 18 px, then a flat field of 12 px muted text. There is no second level: section titles (`h3` 14 px) are the same size as body. Column headers are 10 px uppercase mono, which is hard to read on a dim panel.
- **Cards and panels have one border colour and one radius** and no elevation or spacing rhythm; the board, the log, the inbox and the settings panel all look like the same box. The log in particular needs a distinct treatment (true mono, slightly larger line height, zebra or hairlines, coloured left rail per ticket).
- **Pills** are 10.5 px mono inside 12 px cards; at 1440 px they are the smallest text on screen and carry important facts (deps, attempts, diff).
- **State is encoded only in a 1 px border** on the card (`active`, `blocked`, `waiting`). A 3 px left rail or a tinted header strip would read from across the room.
- **Buttons** are all the same size, and the primary "Start run" sits in a row with six secondaries. Group them: run controls (Start / Pause / Stop) left, board tools (Import / Export) in an overflow or a quieter row.
- **Top bar** status chips are 12 px muted text with 8 px dots; they are the health indicators for Docker, image and token and deserve a clearer treatment (and a tooltip saying what "image missing" means).
- **Session settings** is a `<details>` with a bold summary; it opens into a 400 px tall form inside the 380 px right column. It would be better as a tab or a separate panel.
- **Loading** is the word "Loading…"; no skeletons, so the page jumps when the session arrives (seen in the mid-load screenshot).

## 5. Feature suggestions that would add real value

Ordered by value for the stated use case. The first three are information the backend already has.

1. **Run history**: a run selector above the log (run 1…6 with state, duration, cost, tickets done). Lets the person read what happened in run 3 after they come back. The data is in `runs/<n>/events.jsonl`.
2. **Session cost and time summary**: total cost across runs, per-run cost, started / last activity / total wall time, tickets done per hour. In the header and on the sessions list.
3. **Log filters**: by ticket (click a card → filter log), by kind (tool calls / text / gates / tickets / network), and a "follow" toggle. Collapse tool call + result into one row with an expander.
4. **Board overview strip** under the title: a horizontal stacked bar (done / review / in progress / waiting / ready / backlog) with counts, plus "next up: T-4" computed the same way the loop picks it. Doubles as the progress bar for the sessions list.
5. **Attention panel first**: when there are open requests, show them at the very top of the page (full width, above the board), not in the right column. A session that is paused waiting for a human answer is the one case where the person must act.
6. **Blocked / waiting cards show the reason inline** with a link to the request or the last note, and a "Retry" (move to ready) button directly on the card.
7. **Ticket drawer as a route** (`#/s/<id>/t/T-4`), with prev/next ticket keys, and a diff summary section (files, +/-) once the bundle export can produce it.
8. **Dependency view**: on hover or in the drawer, highlight the tickets this one depends on and the ones that depend on it; mark deps that are not done.
9. **Notifications**: a browser notification (opt-in) when a request opens, a run pauses or finishes. The person is away by design.
10. **Light theme** via `prefers-color-scheme`, since the CSS already uses tokens. Low cost once the tokens are cleaned up.

## 6. Suggested order of work

1. Fix the layout bugs that hide information: B3 (column height / log placement), B1, B2, B4, B5, B6, B11.
2. Fix the CSS bugs: B7, B8, B9, B13, B14, plus the missing fonts.
3. Restructure the session page: header with run controls and summary strip, attention panel, board with fixed-height scrolling columns, log with run selector and filters, inbox and settings as side panels.
4. Then the sessions list (progress bar, timestamps, safer delete), the drawer (route, backdrop, keyboard), and the forms.
5. Features 1–5 from section 5, in that order.

## 7. Status after the first UI pass (2026-10-03)

Everything in sections 1 to 4 was addressed in one pass over `web/src` plus two
small additions to `src/web/api.ts` (`runs` and `totals` on the session
detail and summary, and `GET /sessions/:id/tickets/:tid/reports`).

- Bugs B1–B14: fixed. Titles wrap, pills never clip, columns scroll inside a
  capped height so the log is one scroll away, the header no longer wraps its
  buttons (board tools moved under "More"), timestamps are 24-hour, empty
  results are dropped, the two-column grids render, input-plus-button rows
  stay on one line, the drawer reads reports through the new endpoint (no
  404s), status strings are human, goals get an ellipsis, the top bar wraps
  cleanly, and the board scrolls horizontally only below ~1000 px.
- Information I1–I12: session cost is the sum over every run (with the current
  run shown separately while it runs); the log has a run selector with state,
  duration and cost per run; created / last activity / running-for are in the
  header and the sessions list is sorted by last activity; a progress strip and
  per-column counts show how far along a board is; priority 1–2 and pinned
  show on cards; deps show as done/total on cards and as linked pills in the
  drawer, with a "needed by" list; decided requests show what was asked and
  what was answered; session settings have an explicit Save with a state line;
  paused and halted runs get a banner with the reason and the resume time;
  export shows copyable commands in a panel; import reports as a notice, not
  an error; long worker text and tool output fold behind "more".
- Interaction: the drawer is a route (`#/s/<id>/t/<ticket>`) with a backdrop,
  Escape, and no click-through; the log follows only while scrolled to the
  bottom and offers "Latest"; `prompt()` and `confirm()` are gone (inline
  custom-model input, inline two-step delete); the model is set in one place;
  the goal is readable and foldable; forms have help text per cap; empty boards
  and empty logs say what to do next; cards are real buttons with focus rings.
- Visual: system font stack (nothing to load), a type scale, tonal pills,
  state as a coloured left rail, grouped buttons, health chips with tooltips
  in the top bar, and a light theme via `prefers-color-scheme`.
- Features delivered from section 5: run history (1), cost and time summary
  (2), log filters by ticket and kind with follow (3), progress strip (4),
  requests at the top of the page (5), reasons and Retry on blocked and
  waiting cards (6), drawer as a route (7), dependency links (8), opt-in
  desktop notifications (9), light theme (10).

Not done: per-ticket diff browsing (needs backend support), keyboard
prev/next in the drawer, and a mobile layout below 700 px.

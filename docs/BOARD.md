# Board format

A session's board is one JSON file, `board.json`, and the same shape is what
you paste into the Import box and what Export gives back. Paste this section
into any assistant with "produce a Verstas board for this feature" and the
result imports as is. Markdown is accepted too (below).

The board is optional. One lead works the session: the goal when one is
written, the board's tickets when it has any, or both. The board is the
lead's to move, extend and reorder; you approve what sits in the backlog.

## JSON

```jsonc
{
  "verstas": 1,                 // optional on import
  "goal": "Mapping engine for Nuppi with mock MIDI",
  "tickets": [
    {
      "id": "T-15",             // optional; assigned if missing or unknown
      "title": "Mapping engine: CC, note, pitch bend",
      "kind": "feature",        // feature | bug | followup | chore, a label (default feature)
      "repos": ["nuppi"],       // the clones under /workspace it is expected to touch (a hint)
      "priority": 20,           // lower first, a hint the lead reads (default 100)
      "deps": ["T-12"],         // ids it builds on, a hint the lead reads
      "state": "ready",         // backlog | ready (default backlog)
      "review": "full",         // optional: full | none (default: the session's)
      "spec": "Pure module in src/engine. Input: control value 0..1 ...",
      "acceptance": [
        "unit tests cover 7-bit and 14-bit CC, note on/off, pitch bend",
        "no MIDI port dependency; emits events to an injected sink"
      ],
      "notes": ["Keep the engine free of Electron imports."]
    }
  ]
}
```

A bare array of tickets is accepted as well. Fields from before one lead
did everything (`size`, `pinned`, `agent`, `attempts`, and a `chores` list)
are accepted and dropped, so an old board pastes clean.

### Import rules

- A ticket whose `id` exists on the board **updates** it: title, kind,
  repos, priority, deps, spec, acceptance, review. Notes are appended. The
  state changes only if the current state is `backlog` or `ready`; a ticket
  in flight keeps its state.
- A ticket without an id, or with an unknown one, is **appended** with the
  next free id.
- `repos` lists the repositories the ticket is expected to touch. It is a
  hint for you and the lead, never a limit: the lead touches what the work
  needs, and the judge acts on what actually changed (Judging, below).
  Every name must be one of the session's, which catches typos on import
  and edit. The older single-repository form `"repo": "nuppi"` is read as
  `"repos": ["nuppi"]`.
- Dependencies are validated against the whole result: an unknown id or a
  cycle rejects the import with the reason. The harness orders nothing by
  them or by priority; the lead reads both.
- Any agent may create any kind of ticket. A worker's tickets land in the
  backlog; the lead may put its own straight into `ready` or
  `in_progress`; the agent in your terminal may put one into `ready` when
  you ask.
- `review` is optional and yours only (Judging, below): `full` runs the
  reviewer, `none` accepts the ticket on the lead's word. Absent, the
  session's Reviewer setting applies: on means `full`, off means `none`.
  `checks` is a value from before the harness stopped running checks
  itself and reads as `none`. Agents cannot set it: the agent API drops
  it. A card whose mode differs from the session's shows a badge.

### Judging

A ticket may change any subset of the session's repositories. When the
lead moves a ticket into `in_progress`, the harness records each
repository's HEAD on the ticket (`baseline`). When the lead moves it to
`review`, the judge reads, per repository, the commits since that
baseline whose subject or `Verstas-Ticket` trailer carries the ticket's id
(the lead commits its own work, "T-12: …"), plus the uncommitted working
tree. Commits in the range that carry another ticket's id are left out;
commits that name no ticket are listed to the reviewer so it can look. A
requeued ticket keeps its baseline, so its earlier commits stay in the
next review; it is cleared when the ticket is done. The ticket's `repos`
play no part in this; when they differ from what changed, the note and the
reviewer say so.

The harness runs no checks of its own. The reviewer runs each changed
repository's own check (its test, typecheck and lint scripts, or the
command its README or notes name) and the commands the acceptance
criteria name, then reads every hunk of the diff. Without a reviewer the
lead's word is the verdict, and the lead may move tickets to `done`
itself.

How a change in review is judged:

1. **Review level.** The ticket's own `review` when you set one, else the
   session's Reviewer setting.
2. **Review.** With `full`, one reviewer reads every changed repository,
   one section each, after running their checks. With `none`, the ticket
   is accepted on the lead's word.
3. **Verdict.** `ok` moves the ticket to `done`; what is still uncommitted
   is committed under the ticket when no other ticket is in flight (the
   life's backup commit takes it otherwise, labelled with every ticket in
   progress). `fixable` moves it back to `ready` with the reviewer's notes,
   every time; the lead decides whether to try again. `blocked` blocks it.
   Every commit is scanned for credentials first and carries the trailers
   `Verstas-Ticket` and, across several repositories, `Verstas-Repos`.

`board_changes` shows the lead what the reviewer would see if it moved a
ticket to review now.

### States

`backlog` → `ready` → `in_progress` → `review` → `done`, with `waiting`
(a request is open), `blocked` (the reviewer said no, or the lead gave up)
and reopen (`done` → `ready`). The lead moves tickets itself through the
agent API (`board_move`): any transition the board allows, several
tickets in progress at once, a new ticket straight into `ready` or
`in_progress`. Three moves are not its: out of `review` (the verdict moves
the ticket to `done`, `ready` or `blocked`), into `waiting` (a request on
the ticket does that), and into `done` while the session has a reviewer
(`in_progress` → `done` is the lead's only when the reviewer is off). You
move between `backlog`, `ready`, `blocked`, and reopen.

### Timing

Every state change records the ticket's clock: `stateSince` (the last
change), `timeIn` (seconds per state, summed over every visit),
`firstClaimAt` (the first move to `in_progress`) and `readyBeforeClaim`
(queueing before that move). The run adds the reviewer's reported seconds
to `agentSeconds` (never the lead's, which spans tickets). The session page
shows a done ticket as "Took 42m · agent 31m · judging 3m · waiting on you
6m · requeued 2m", runs a timer on a ticket in progress, and sums "waiting
on you" over the board in the header: the time the loop stood still for
you. Agent time is the time in `in_progress` plus the reviewer's seconds.
Tickets from before timing have none of these fields and show nothing.

## Markdown

```markdown
# Build the mapping engine

## T-3 · Mapping engine: CC and notes
Repos: nuppi · Deps: T-1, T-2 · Priority: 20
Pure module in src/engine. Input is a 0..1 value.
- [ ] 7-bit and 14-bit CC covered by tests
- [ ] no Electron imports

### Mock MIDI port
Kind: chore | State: ready
Emit events to an injected sink.
```

- A level-1 heading before the first ticket is the goal.
- Level-2 or level-3 headings start tickets. The leading `T-n` is
  optional; a size in parentheses after the title, from before, is
  dropped.
- One line of `Key: value` pairs separated by `·` or `|` sets repos
  (`Repos: api, docs`; `Repo:` works too), deps, priority, kind, state and
  review (`Review: none`).
- Checklist items are acceptance criteria. Everything else is the spec.
- A `## Chores` section, from before, is skipped.

## Export

Export returns the full `board.json`, states, notes, reports, diff stats,
timing and cost included.

## Importing onto a board that has tickets

Import tickets on the session page adds: every pasted ticket becomes a new
one, and the board's own tickets are never rewritten. A paste whose ids are
free keeps them. When one is taken (the usual case: the next piece of work
is numbered `T-1…` again), the whole paste is renumbered after the board's
last ticket, in paste order, and dependencies inside the paste follow; a
dependency on an id the paste does not carry names a ticket already on the
board. The card shows the result before anything is saved.

When the paste names ids the board has, the card also offers "Update the
tickets with the same id": the merge that fits a board exported from this
session and revised outside, so cards are not duplicated. It changes a
ticket's state only while the ticket is in backlog or ready.

A goal in the paste is left alone unless you tick "Also replace the goal".


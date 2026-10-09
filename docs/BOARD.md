# Board format

A session's board is one JSON file, `board.json`, and the same shape is what
you paste into the Import box and what Export gives back. Paste this section
into any assistant with "produce a Verstas board for this feature" and the
result imports as is. Markdown is accepted too (below).

## JSON

```jsonc
{
  "verstas": 1,                 // optional on import
  "goal": "Mapping engine for Nuppi with mock MIDI",
  "tickets": [
    {
      "id": "T-15",             // optional; assigned if missing or unknown
      "title": "Mapping engine: CC, note, pitch bend",
      "kind": "feature",        // feature | bug | followup | chore (default feature)
      "repos": ["nuppi"],       // the clones under /workspace it is expected to touch (a hint)
      "size": "M",              // S | M | L (default M)
      "priority": 20,           // lower runs first (default 100)
      "deps": ["T-12"],         // ids that must be done first
      "state": "ready",         // backlog | ready (default backlog)
      "pinned": false,          // true: the agent may not reprioritize it
      "agent": { "driver": "codex", "model": "gpt-5.1" }, // optional: this ticket's own agent
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

A bare array of tickets is accepted as well.

### Import rules

- A ticket whose `id` exists on the board **updates** it: title, kind, repos,
  size, priority, deps, spec, acceptance, pinned, agent, review. Notes are appended. The
  state changes only if the current state is `backlog` or `ready`; a ticket
  in flight keeps its state.
- A ticket without an id, or with an unknown one, is **appended** with the
  next free id.
- `repos` lists the repositories the ticket is expected to touch. It is a
  hint for you and the worker, never a limit: the worker touches what the
  work needs, and the judge acts on what actually changed (Judging, below).
  Every name must be one of the session's, which catches typos on import
  and edit; a run only notes an unknown name. The older single-repository
  form `"repo": "nuppi"` is read as `"repos": ["nuppi"]`.
- Dependencies are validated against the whole result: an unknown id or a
  cycle rejects the import with the reason.
- Agents importing through the API may create `bug`, `followup` and `chore`
  tickets only. Features from an agent are skipped and reported; the agent
  files them as ideas instead.
- `agent` is optional. When set, the ticket's implementer is a fresh worker
  on that driver and model instead of the session's worker (Agent options);
  the reviewer stays the session's, so the review is independent of what
  wrote the code. The driver needs a credential in Settings: a run refuses
  to start while a live ticket names one without it, and the driver's
  network pack joins the allowlist when the run starts. In lead mode the
  lead may not claim such a ticket; it hands it over with `board_run`,
  which runs the worker and the judge while the lead waits. Use it for
  tickets that need a particular strength, such as judging rendered images.
- `review` is optional and yours only (Judging, below): `full` runs the
  reviewer, `none` accepts the ticket when the implementer finished
  ("Accepted without review"). Absent, the session's Reviewer setting
  applies: on means `full`, off means `none`. Use `none` for a doc update
  or a trivial change. `checks` is a value from before the harness
  stopped running checks itself and reads as `none`. Agents cannot set it:
  the agent API drops it, and an agent's tickets always take the session's
  setting. A card whose mode differs from the session's shows a badge.

### Judging

A ticket may change any subset of the session's repositories. When it is
submitted, the judge stages every repository and finds the ones that
changed since the ticket started (its earlier attempts, committed as wip,
count). The ticket's `repos` play no part in this; when they differ from
what changed, the note and the reviewer say so.

The harness runs no checks of its own. Each repository's check is the
command the project brief names under Build / test / run (`bash
scripts/check.sh`, `npm test`, or "nothing to run"): setup writes that
line after it has made the build and tests work and has run the command
once, and the reviewer of every ticket runs it. An implementer runs the
tests of the code it changed and submits; the reviewer runs the whole
check of every changed repository (and of the repositories the brief says
build on a changed one), the commands the acceptance criteria name, and
then reads the diff. Without a reviewer, the implementer's word is the
verdict, and it is told to run the check itself before submitting.

How a submitted change is judged:

1. **Review level.** The ticket's own `review` when you set one, else the
   session's Reviewer setting.
2. **Review.** With `full`, one reviewer reads every changed repository,
   one section each, after running their checks. With `none`, the ticket
   is accepted when the implementer finished, or requeued when it stopped
   at a cap.
3. **Commit.** All or nothing: every changed repository is scanned for
   credentials first, then each is committed with the same message and the
   trailers `Verstas-Ticket` and, across several repositories,
   `Verstas-Repos`.

`board_changes` shows a worker what the judge would see if it submitted
now. Chore sweeps go through a size check and, when the session has a
reviewer, the same reviewer (Chores, below).

A proper harness-run check (one command per repository, run once per
submission out of band, as evidence for the reviewer first) is on the
backlog; the first version cost more than it saved and was removed.

### Ticket size

Every ticket pays a fixed cost however small it is: a worker reads its way
in, the check runs, a reviewer reads the change, the harness commits. A
session may set the size its planning agents (the planner and agent
terminals) aim for, under Session settings (`planning.ticketSize`, `S`, `M`
or `L`, with optional guidance in your words). Unset, they choose as
before; nothing else reads it.

| Size | What it is | Changed lines | Agent time |
| --- | --- | --- | --- |
| S | one change in one place: a fix, a guard, one test, a doc section | under ~150 | under 15 min |
| M | one feature slice through the layers it needs, follow-ups folded in | ~150–800 | 15–45 min |
| L | a whole feature one reviewer can still judge in one pass | ~800–2,000 | 45–120 min |

In the default (loop) mode one worker must finish one ticket, so raise the
worker minutes to match L. A draft carries the same setting
(`draft_update` with `planning`).

### States

`backlog` → `ready` → `in_progress` → `review` → `done`, with `waiting`
(a request is open), `blocked` (gave up) and reopen (`done` → `ready`).
Only the harness moves tickets to `done`. In the default mode it also
moves them through `in_progress` and `review`. In lead mode the lead does
those two moves itself through the agent API: `board_claim` (`ready` to
`in_progress`, dependencies done, one ticket at a time) and `board_submit`
(`in_progress` to `review`, report filed), after which the harness judges
the ticket and moves it to `done`, back to `ready` or to `blocked`. You move
between `backlog`, `ready`, `blocked`, and reopen.

### Timing

Every state change records the ticket's clock: `stateSince` (the last
change), `timeIn` (seconds per state, summed over every visit),
`firstClaimAt` (the first move to `in_progress`) and `readyBeforeClaim`
(queueing before that claim). The run adds each worker's reported seconds to
`agentSeconds` (implementer and reviewer; never the lead, which spans
tickets). The session page shows a done ticket as "Took 42m · agent 31m ·
judging 3m · waiting on you 6m · requeued 2m", runs a timer on the ticket in
progress (against the worker cap in the default mode, elapsed only in lead
mode, where the cap belongs to the whole lead), and sums "waiting on you"
over the board in the header: the time the loop stood still for you. Agent
time in lead mode is the time in `in_progress` plus the reviewer's seconds.
Tickets from before timing have none of these fields and show nothing.

## Chores

Beside the tickets the board keeps **chores**: small, self-contained fixes
that are not worth a ticket (a nit, a rename, a missing guard, a doc line).
Reviewers and workers file them with the `chore` tool, you add them on the
session page or in an import, and a lead sweeps them in batches: it takes
some open chores (`chores_sweep`), does them, runs the repository's own
checks, and submits one line per chore (`chores_submit`: done, dropped
with the reason, or promoted to a backlog ticket when it turned out
bigger). Verstas then runs a size check, has the session's reviewer read
the batch when the session has one (the chores stand in for the ticket,
the lead's lines for the report), and commits the whole batch as **one
commit**. Over the size caps (`sweepMaxLines`, `sweepMaxFiles` in the
session's caps), when the sweep touched a protected path (contract
documents such as `DESIGN.md`, anything under `fixtures/`, snapshots), or
when the reviewer's verdict is not ok, the sweep is refused with the
reason, the chores go back to open, and the changes stay in the working
tree for the lead to turn into a ticket or revert.

The list has a sweep line, the `choreSweepAt` cap (default 10): with that
many chores open, the lead sweeps before it starts another ticket, and
`board_claim` and `board_run` are refused until the list is below the
line again. Set it to 0 to leave the timing to the lead. Any worker,
reviewer or lead may drop an open chore that turned out moot or not worth
its change (`chore_drop`, with the reason); you drop and promote them on
the session page.

```jsonc
{
  "chores": [
    { "id": "C-4", "text": "Rename `tmp` to `pending` in the loop", "where": "src/loop.ts", "repo": "nuppi" }
  ]
}
```

- `id` is optional and assigned when missing. A known id updates the text
  while the chore is still proposed or open.
- States: `proposed` (filed by an agent while the session's
  `choreApproval` cap is on; you approve it), `open`, `sweeping` (held by
  the lead's current sweep), `done`, `dropped`, `promoted` (the ticket is in
  `promotedTo`).
- `board.sweep` is the sweep in flight or the last one: its number, the
  chore ids, `working` / `judging` / `accepted` / `refused`, the note and
  the diff size.
- Sweeps are a lead's job (lead mode). In the one-worker-per-ticket mode
  chores wait on the list until you promote them or switch the mode.

## Markdown

```markdown
# Build the mapping engine

## T-3 · Mapping engine: CC and notes (M)
Repos: nuppi · Deps: T-1, T-2 · Priority: 20
Pure module in src/engine. Input is a 0..1 value.
- [ ] 7-bit and 14-bit CC covered by tests
- [ ] no Electron imports

### Mock MIDI port
Kind: chore | State: ready
Emit events to an injected sink.
```

- A level-1 heading before the first ticket is the goal.
- Level-2 or level-3 headings start tickets. The leading `T-n` and the size
  in parentheses are optional.
- One line of `Key: value` pairs separated by `·` or `|` sets repos
  (`Repos: api, docs`; `Repo:` works too), deps,
  priority, size, kind, state, pinned, agent (`Agent: codex/gpt-5.1`, or
  just the driver) and review (`Review: none`).
- Checklist items are acceptance criteria. Everything else is the spec.
- A heading `## Chores` starts the chore list: every `- ` item under it is
  one chore, written `text — where` or `text (where)`.

## Export

Export returns the full `board.json`, states, notes, reports, diff stats,
timing and cost included. Re-importing an export merges by id, so a plan edited outside
and pasted back does not duplicate cards.

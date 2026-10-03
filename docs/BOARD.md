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
      "repo": "nuppi",          // which clone under /workspace
      "size": "M",              // S | M | L (default M)
      "priority": 20,           // lower runs first (default 100)
      "deps": ["T-12"],         // ids that must be done first
      "state": "ready",         // backlog | ready (default backlog)
      "pinned": false,          // true: the agent may not reprioritize it
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

- A ticket whose `id` exists on the board **updates** it: title, kind, repo,
  size, priority, deps, spec, acceptance, pinned. Notes are appended. The
  state changes only if the current state is `backlog` or `ready`; a ticket
  in flight keeps its state.
- A ticket without an id, or with an unknown one, is **appended** with the
  next free id.
- Dependencies are validated against the whole result: an unknown id or a
  cycle rejects the import with the reason.
- Agents importing through the API may create `bug`, `followup` and `chore`
  tickets only. Features from an agent are skipped and reported; the agent
  files them as ideas instead.

### States

`backlog` → `ready` → `in_progress` → `review` → `done`, with `waiting`
(a request is open), `blocked` (gave up) and reopen (`done` → `ready`).
Only the harness moves tickets through `in_progress`, `review` and `done`;
you move between `backlog`, `ready`, `blocked`, and reopen.

## Markdown

```markdown
# Build the mapping engine

## T-3 · Mapping engine: CC and notes (M)
Repo: nuppi · Deps: T-1, T-2 · Priority: 20
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
- One line of `Key: value` pairs separated by `·` or `|` sets repo, deps,
  priority, size, kind, state and pinned.
- Checklist items are acceptance criteria. Everything else is the spec.

## Export

Export returns the full `board.json`, states, notes, reports, diff stats and
cost included. Re-importing an export merges by id, so a plan edited outside
and pasted back does not duplicate cards.

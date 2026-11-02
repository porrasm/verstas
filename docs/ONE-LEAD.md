# One lead: the simplification plan

Decided 2026-11-02. Verstas becomes a wrapper that keeps one Claude alive
and manages it, nothing more. The agent inside decides how it works. This
file is the plan: one section per step, each written so a fresh session
can do it without further context. Steps land in order; the app builds,
typechecks and passes its unit suite after every step. Progress goes in a
`Status:` line under each heading.

## The decision

What Verstas is after this plan:

- **One run loop.** Start means: one lead, kept alive. Its prompt is the
  session's goal text when there is one, the board when it has tickets,
  the notes directory, and the facts of the box. No role rules, no
  definition of done, no verifying rule, no "read this first". If the
  goal is empty and the board has no tickets, Start refuses with "write a
  goal or add tickets".
- **Goal and board together.** The lead works both when both exist. The
  board is a tool the lead may use for its own work (it creates, edits,
  deletes, reorders and moves tickets itself), and the goal is what it
  works toward. Either alone is also fine.
- **The lead owns the board.** It moves tickets between columns itself,
  several may be in progress at once, and it commits its own work with
  its own messages. The one exception is the independent review: with the
  reviewer on, a ticket the lead moves to `review` is judged by a fresh
  reviewer that the harness runs; the harness then moves it to `done` or
  back to `ready` with the reviewer's notes. The lead cannot move a ticket
  to `done` itself while the reviewer is on. With the reviewer off, it can.
- **The harness keeps the agent alive and nothing else.** The sandbox,
  the resume of a conversation between lives, a fresh lead from a handoff
  note, the rate-limit sleep, parking on a request, idle detection,
  messages from the user mid-run, a backup commit of whatever is left
  uncommitted when a lead life ends, the progress nudge for the inbox.
- **Initialize is clone plus container plus recipes.** No setup worker,
  no requirements, no readiness verdict. The lead installs what it needs
  when it needs it; the snapshot image remembers system installs across a
  recreate.
- **Caps are liveness limits, not instructions.** `budgetUsd` per run,
  `leadMinutes` and `leadTurns` optional and unset by default (when set, a
  cap ends the life and a fresh lead continues from the note), the
  reviewer's own time cap.

Removed: loop mode and the implementer role, goal mode as a separate
loop, the planner role and Plan tickets, the setup role and setup mode,
the brief / env.md / setup.sh contract, chores and sweeps with their caps
and protected globs, a ticket's own agent and `board_run`, ticket kind
restrictions, `pinned`, `attempts` and `ticketAttempts`, `size` and the
size guide, planning guidance (`ticketSize`, `guidance`), `resumeWorker`,
`workerMinutes`, `workerTurns`, `runTickets`, `goalRounds`, the per-ticket
`review` override.

Kept: the reviewer with its `VERDICT:` contract, `request`, `message`,
`idea`, `artifact`, `handoff`, `budget`, the agent terminal, Ask the box,
Publish PR, Next round, Sync, Reclone, export and import, drafts, the
recipe library, the remote dashboard, the lead rules override file
`~/.verstas/prompts/lead.md` for people who do want rules.

## The review boundary with several tickets in progress

One working tree, several tickets in flight, and a lead that commits.
What belongs to the ticket under review is decided like this:

1. When a ticket enters `in_progress`, the harness records each
   repository's HEAD on the ticket (`baseline: Record<repo, sha>`).
2. When the lead moves it to `review`, the reviewer gets, per repository:
   the commits since the baseline whose subject or `Verstas-Ticket`
   trailer carries the ticket id (`git log <base>..HEAD`), their combined
   diff, and the working tree diff when it is dirty. The lead is told in
   VERSTAS.md, as a fact: "commits whose subject carries the ticket id are
   the ticket's; the reviewer reads those and the working tree".
3. Commits since the baseline that carry another ticket's id are left
   out; commits that carry no id are listed to the reviewer as "unlabelled
   commits in the range" with their subjects, so it can look. The reviewer
   has the box and git; it may read anything.
4. The backup commit the harness makes at the end of a lead life carries
   `Verstas-Ticket` trailers for every ticket in progress at that moment,
   so it is never unlabelled.

This replaces `earlierAttempts` and the `(wip attempt n)` commit
convention in `src/harness/judging.ts` and `collectChanges`.

## Step 1 · One run loop  (L)

**Status: done 2026-11-02**, together with Step 2.

**What.** Replace the three loops in `src/harness/run.ts` (the implementer
loop in `loop()`, `leadLoop`, `goalLoop`) with one `leadLoop` that works
the goal and the board together. Remove `mode` from the session.

**How.**
- `src/core/types.ts`: delete `sessionModeSchema` and `session.mode`;
  `migrateSession` in `src/sessions/sessions.ts` drops the field from old
  files. Keep `goal`, `goalSince`, `goalMet`, `goals` on the session.
  `ticketTiming` loses its `mode` argument (always the lead computation).
- `run.ts`: `start()` refuses a work run when the goal is empty and the
  board has no tickets. `loop()` keeps init, prompt and terminal; the rest
  is the one `leadLoop`, built from today's `leadLoop` with these parts of
  `goalLoop` merged in: the round counter and `run.rounds`, the goal text
  read fresh every life (a revision lands in the next prompt or, for a
  running Claude lead, as a message), `lastWords` after a cap, the
  progress nudge (`progressChecks`, now for role `lead`), the `goal_done`
  hook renamed `done`, and the backup commit at the end of every life
  (`commitAll` with trailers for the tickets in progress).
- Run end: the lead called `done` and no ticket is startable (the board
  may still hold backlog tickets; those are the user's), or pause, request,
  idle twice, rate limit sleep, budget. Idle means: no commit in any
  repository, no board change (fingerprint over ticket ids and states), no
  change to `notes/state.md`, no new request or message.
- Delete `workTicket`, the implementer path of `judge`, `convo` and
  `resumeWorker`, `delegated`, `board_run`, `tokenRole`'s worker branch.
  `judge` stays for the reviewer only (Step 4 reshapes its input).
- Prompts (`src/harness/prompts.ts`): one `leadPrompt` that carries the
  goal section when the goal is set, the board section when it has
  tickets, the state note, the handoff note or last words, recent commits
  per repository (from `goalPromptOptions`), and request outcomes.
  `leadContinuePrompt` likewise. Delete `goalPrompt`,
  `goalContinuePrompt`, `implementerPrompt`, `readGoalRules`.
- MCP server (`src/worker/mcp-server.ts`): `goal_done` becomes `done`
  ("the goal is met, or the board is finished; the run ends after you
  stop"); its role gate is `lead`. The `goal` role disappears from
  `visibleTools`, `WorkerRole`, `Job["role"]`, the event schema and the
  drivers.
- Agent API (`src/agent-api/agent-api.ts`): `/goal_done` becomes `/done`;
  `/tickets/:id/run` is removed; `AgentRunHooks.goalDone` becomes `done`,
  `delegated` is removed.
- Web API (`src/web/api.ts`): `/sessions/:id/caps` no longer takes `mode`;
  `/sessions/:id/goal` stays. `/sessions/:id/run` action `start` is
  refused with the "write a goal or add tickets" message when both are
  empty.
- UI (`web/src/pages/Session.tsx`): the mode select goes; the goal panel
  and the board both show on every session (the goal panel above the
  board, collapsed to one line when empty). `ticketClock` is always the
  lead view. The finished label reads "goal met, says the lead" when
  `goalMet` is set.
- Drafts (`src/drafts/*`): a draft already has a goal and tickets; nothing
  to change but the context text in `verstas_context`.

**Tests.** `tests/unit/run.spec.ts`: delete the loop-mode and goal-mode
cases; keep the lead cases; add: a lead works a goal with no tickets and
every life is committed; a lead works tickets with no goal; a lead with
both; `done` with startable tickets left does not end the run; Start
refuses with nothing to work; the backup commit carries trailers for the
tickets in progress. `tests/unit/goal.spec.ts` keeps `reviseGoal` and the
history. `ticket-timing.spec.ts` drops the mode argument.

**Docs.** README "How tickets are worked" becomes one paragraph; `docs/DRIVERS.md`
roles list; `docs/BOARD.md` Timing.

## Step 2 · The lead owns the board  (M)

**Status: done 2026-11-02.** `board_claim`/`board_submit` became
`board_move`; `goal_done` became `done`; the baseline is recorded on the
move into in_progress and kept on a requeue. Chores, `size`, `pinned`,
`attempts`, the per-ticket `review` and the planner stay until Steps 5
and 6; the pin no longer stops the lead, and a fixable verdict no longer
counts toward a cap.

**What.** The lead moves tickets itself; the harness only acts on
`review`. Several tickets may be in progress at once.

**How.**
- Agent API: replace `/tickets/:id/claim` and `/tickets/:id/submit` with
  `POST /tickets/:id/move { to, note }` for a lead, allowed for every
  transition in `TRANSITIONS` except `review → done` while the reviewer is
  on (403 with the reason). A move into `in_progress` records the
  baseline (Section "The review boundary"). A move into `review` calls
  `hooks.submitted`. `claimRefusal` becomes `moveRefusal`, kept for the
  pause, handoff and halt cases; the `runTickets` reason goes.
- Remove the one-ticket-at-a-time rule everywhere (`holds` becomes the
  list of tickets in progress; the prompt shows them all).
- `board.ts`: `TRANSITIONS` gains `backlog → ready` for the lead (already
  there), and the lead may also move `ready → backlog`, `blocked → ready`,
  `done → ready`. `assertAgentMayCreate` and `AGENT_TICKET_KINDS` go: any
  role creates any kind. `agentSetPriority` and `agentAddDep` lose the
  pinned check. `editTicket` and `deleteTicket` are allowed for the lead
  (today terminal only); the agent API's `terminalOnly` gate goes.
- MCP server: `board_claim` and `board_submit` become `board_move`;
  `board_update_ticket` and `board_delete_ticket` show for the lead.
  `board_create_ticket` accepts `state: "ready"` and `"in_progress"` for
  the lead.
- `requested` hook: a request on a ticket in progress parks that ticket
  (`waiting`), as today; the lead keeps the others.
- Stop and pause: every ticket in progress goes back to `ready` with the
  work kept, as the lead loop's `finally` does today.

**Tests.** `agent-api.spec.ts`: moves allowed and refused; two tickets in
progress; `review → done` refused with the reviewer on and allowed with
it off; create as ready. `board.spec.ts`: the kind and pinned rules are
gone. `run.spec.ts`: two tickets in progress, one submitted, the other
kept; pause requeues both.

**Docs.** `docs/BOARD.md` States; `docs/SANDBOX.md` Boundary 4 (the agent
API's shape); `docs/DRIVERS.md` The board MCP server.

## Step 3 · Prompts are facts  (M)

**Status: not started.**

**What.** The agent reads where it is, not how to work.

**How.**
- `verstasMd` becomes about twenty lines: the working directory and HOME,
  the repositories with their branches, attachments, the notes directory
  (`/workspace/notes` persists across your lives; `state.md` is what a
  fresh lead is given), the network allowlist and the `request` tool for
  hosts and packs, sudo and `svc`, the tools of the MCP server in one
  line each, the review rule (which transitions the harness owns and how
  the reviewer finds the ticket's commits), that the harness commits
  whatever is uncommitted when a life ends, and that a message starting
  "Message from the user:" or "Message from Verstas:" may arrive. Delete
  `verifyRule`, the long-commands paragraph, the "user is asleep"
  paragraph, the "ask only for what you cannot do" paragraph.
- `systemMd`: for `lead`, the override file's text when it exists, else
  nothing beyond "Read /workspace/VERSTAS.md." For `reviewer`, the verdict
  contract only: you did not write this change; reply starting with
  `VERDICT: ok | fixable | blocked` and your reasons; notes with
  `board_add_note`; do not fix the code. Drop the two-passes recipe and the
  checks reminder. For `prompt` and `terminal`, the facts that differ
  (the user is at the keyboard; no `request`). Delete the `implementer`,
  `setup`, `planner`, `goal` entries, `TICKET_SIZE_GUIDE`,
  `ticketSizeRule`, `recentReports` (the lead reads reports with
  `board_get_ticket` when it wants them), `withContext` (no brief, no
  env.md to put first; the notes directory is listed instead),
  `notesIndexMd`, `workspaceClaudeMd` (shortened to the two-line pointer at
  VERSTAS.md), `PAUSE_NUDGE` shortened to "the user asked the run to pause:
  reach a sensible point, update notes/state.md, reply with one line and
  stop", `PROGRESS_NUDGE` shortened to "post a short progress update for
  the user with the `message` tool, then carry on".
- The reviewer prompt: the ticket, the lead's report when there is one,
  the change per repository (Section "The review boundary"), the
  unlabelled commits. Nothing about which checks to run.
- `src/context/context.ts` ("Copy context for an LLM") loses the size
  guide and the setup paragraphs; it describes the box and the board
  format only.

**Tests.** `prompts-reviewer.spec.ts`; a new `prompts.spec.ts` that
asserts `verstasMd` names every tool the lead sees and contains none of
the words "must", "never" or "always" outside the review rule (the
cheap guard against rules creeping back). `run.spec.ts`: the lead rules
file case stays.

**Docs.** README: the Setup, Ask the box and How tickets are worked
sections; `docs/SANDBOX.md` Threat model's "full autonomy" sentence stays
true and gets a line that the harness gives no working rules.

## Step 4 · Initialize is the box  (M)

**Status: not started.**

**What.** No setup worker, no requirements, no readiness, no notes
contract. Initialize clones, creates the container, runs the recipes,
takes the snapshot, and is done; Initialize and start goes on to the lead.

**How.**
- `run.ts` `loop()`: the `opts.init || opts.setup` block keeps only the
  initialization mark, the snapshot and the `start` hand-over. Delete
  `opts.setup`, `opts.brief`, `parseSetup`, `SETUP_MIN_*`, the
  `requestOutcome` answers for setup, the `checking` session state.
- `types.ts`: delete `setupModeSchema`, `session.setupMode`,
  `session.requirements`, `readinessSchema`, `session.readiness`,
  `environmentFrom.readinessCarried` (keep `environmentFrom.session` and
  `at`), the `checking` state. Keep `setupScripts`, `setup` (recipe
  results), `rootScripts`, `snapshot`. `migrateSession` drops the removed
  fields.
- `src/web/api.ts`: delete `/sessions/:id/setup/rerun`,
  `/sessions/:id/brief`, `/sessions/:id/requirements`,
  `/sessions/:id/setup/confirm`, `/sessions/:id/recipe/promote` (Save as
  recipe read `notes/setup.sh`; a recipe is now written by hand or by the
  agent terminal into the library through the Recipes page), the `brief`
  and `setup` actions of `/sessions/:id/run`. `GET /sessions/:id/setup`
  stays for the recipe results.
- `src/sessions/from-environment.ts`: the environment copy is the home
  volume, the snapshot, the recipes, the network settings and the notes
  directory as a whole (no `ENVIRONMENT_NOTES` / `PROJECT_NOTES` split;
  `state.md` still never copies). `environmentSettings` drops
  `requirements` and `setupMode`.
- `src/sessions/archive.ts`: the archive drops `requirements`, `readiness`
  and `setupMode`; import tolerates old archives that carry them.
- Drafts: `draft.requirements` goes from `src/drafts/draft.ts`,
  `draft_update` and the Draft page; `draft_validate` stops warning about
  it. `verstas_context` and `src/drafts/setup.ts`'s first message lose the
  requirements sentence.
- `src/scripts/library.ts` is unchanged; `web/src/pages/Scripts.tsx` loses
  "from a session's setup.sh" wording.
- UI `Session.tsx`: delete `SetupSection`, `ReadinessView`,
  `InitNeedsCard`, the "Accept as is" flow, the requirements editor, the
  setup worker line in the Environment sheet head, the "the next setup
  worker rewrites them" note. `NotesSection` stays (the notes are the
  lead's memory and worth a look). `NewSession.tsx` and `Sessions.tsx`
  lose their setup mode and requirements inputs and the `checking` label.
- Recipes still run as root at container creation; `docs/examples/scripts`
  stay as they are.

**Tests.** `run.spec.ts`: delete the initialization cases that involve the
setup worker; keep and adjust "initialize without start" and "skip mode"
(now the only mode). `sessions.spec.ts`, `archive.spec.ts`,
`from-environment.spec.ts`, `drafts.spec.ts`, `drafts-mcp.spec.ts`,
`packs.spec.ts` lose the requirements and readiness cases.

**Docs.** README steps 3, 5 and 6 (Setup becomes one sentence under
Initialize); `docs/SANDBOX.md` "A session from another session's
environment" and the Snapshots section (the snapshot is now the only
record of system installs); `docs/DRAFTS.md` What a draft holds.

## Step 5 · The board loses its rails  (M)

**Status: not started.**

**What.** Chores, sweeps, kinds restrictions, pinned, attempts, size,
planning guidance, a ticket's own agent, the per-ticket review override.

**How.**
- `types.ts`: delete `choreSchema`, `sweepSchema`, `sweepResultSchema`,
  `choreImportSchema`, `board.chores` and `board.sweep`,
  `SWEEP_PROTECTED_GLOBS` and the glob matcher, `ticket.pinned`,
  `ticket.attempts`, `ticket.size`, `ticketSizeSchema`,
  `TICKET_SIZE_GUIDE`, `ticket.agent`, `ticket.review`, `reviewModeSchema`
  and `normalizeReviewMode`, `planningSchema` and `session.planning`,
  `caps.ticketAttempts`, `caps.sweepMaxLines`, `caps.sweepMaxFiles`,
  `caps.choreApproval`, `caps.choreSweepAt`, `caps.goalRounds`,
  `caps.resumeWorker`, `caps.workerMinutes`, `caps.workerTurns`,
  `caps.runTickets`. `caps.leadMinutes` and `caps.leadTurns` become
  optional with no default. `ticketKindSchema` stays as a label the user
  and the lead may set freely. `deps` and `priority` stay as plain data
  the lead reads and may change; the harness orders nothing by them
  (`nextReady` and `canStart` are deleted; `hasOpenWork` and
  `describeBlockers` stay for the UI).
- Import (`importBoard`, `parseMarkdownBoard`, `parseBoardPaste`): the
  removed fields are accepted and ignored, so an old board pastes clean.
  The `(M)` size suffix in Markdown headings is still parsed and dropped.
- `board.ts`: delete the chore and sweep functions, `assertAgentMayCreate`,
  the pinned checks, `AGENT_TICKET_KINDS`, `AgentRole`.
- `judging.ts`: delete `reviewLevel` (the session's `caps.reviewer` is
  the whole rule), `earlierAttempts`, the sweep rules. Keep
  `plannedVsTouched` as a note for the reviewer.
- `run.ts`: delete `judgeSweep`, `sweepStarted`, `sweepSubmitted`, the
  attempt counting in `judge` (a fixable verdict moves the ticket to
  `ready` with the notes, every time; the lead decides whether to try
  again or drop it), `withAgentPacks` and `boardDrivers` for ticket
  agents (`sessionDrivers` reads the session's agents only).
- Agent API: delete `/chores*`, the kind check in `POST /tickets`, the
  pinned checks, `agent` and `size` in the create and patch bodies,
  `previewJudging`'s review level.
- MCP server: delete `chore`, `chores_list`, `chore_drop`, `chores_sweep`,
  `chores_submit`; `board_create_ticket` and `board_update_ticket` lose
  `size`, `agent`, `pinned`.
- Web API: delete `/sessions/:id/chores*`; `/sessions/:id/caps` loses the
  removed caps and `planning`; the ticket create and edit bodies lose
  `size`, `pinned`, `agent`, `review`.
- Remote (`src/remote/view.ts`, `commands.ts`): the view drops chores and
  the sweep; `ticket.create` drops `size`.
- UI: delete `ChoresPanel`, `ReviewOptions`, the own-agent and pinned
  controls in `NewTicketForm` and `TicketDrawer`, the attempt pills, the
  size select and `TICKET_SIZE_HELP`, the planning guidance fields and the
  removed caps in `SessionSettings` (left: budget, reviewer on or off,
  lead minutes and turns as optional fields, progress minutes, limits,
  network). `AgentOptions.tsx` keeps worker and reviewer agents.
- Drafts: `draft.planning`, ticket `size`, `pinned`, `agent` go from the
  model, the tools and the Draft page; `draft_validate` drops the "large
  tickets" warning.
- `docs/examples/*.json` lose the removed fields.

**Tests.** Delete `chores.spec.ts`, `ticket-size.spec.ts`,
`ticket-agent.spec.ts`, `clear-board.spec.ts`'s chore half. `board.spec.ts`
gets "old fields are accepted and ignored on import". `judging.spec.ts`
shrinks to `plannedVsTouched`. `run.spec.ts`: a fixable verdict always
returns the ticket to ready. `remote.spec.ts`, `drafts*.spec.ts`,
`agent-api.spec.ts`, `mcp-server.spec.ts`, `terminal.spec.ts` lose the
removed cases.

**Docs.** `docs/BOARD.md` is rewritten: the JSON shape, import rules,
Judging (the review boundary section above), States, Timing, Markdown,
Export; no Chores, no Ticket size. README step 8 and the Chores
paragraph. `docs/DRIVERS.md` The board MCP server. `docs/REMOTE.md` what
is sent.

## Step 6 · Remove Plan tickets  (S)

**Status: not started.**

**What.** The planner role and the Plan tickets dialog go; the lead and
the agent terminal write tickets.

**How.** `run.ts`: `opts.plan`, the planner block, the `planning` session
state. `prompts.ts`: `plannerPrompt`. `types.ts`: `WorkerRole` and the
event roles lose `planner`; `session.prompts[].kind` loses `plan` (old
entries migrate to `prompt`). Web API: the `plan` action. UI:
`PlanDialog`, the Plan tickets buttons (session page, `NextRoundDialog`'s
`onPlan`, `WorkPanel`), "Earlier planning requests". MCP server:
`forPlanning` and the `planner` role. `docs/DRIVERS.md` roles.

**Tests.** `run.spec.ts` planner case; `terminal.spec.ts` keeps the
terminal's ticket writing.

## Step 7 · Docs and the version  (S)

**Status: not started.**

Rewrite README's Running it section to the new flow (Settings, New
session, Initialize, write a goal or tickets, Start; Publish PR). Prune
`docs/BACKLOG.md` to what still applies and point its Direction paragraph
here. `docs/UI-AUDIT.md` loses the removed screens. `docs/SANDBOX.md`
Reviewer checklist reads against the new API surface. Bump the minor
version with the first code step and once per later commit that changes
behaviour, per CLAUDE.md.

## Order and migration

Steps 1 and 2 are one commit or two adjacent ones: the lead cannot own
the board while the loop still picks tickets for an implementer. Steps 3
to 6 are independent of each other and each lands alone. Step 7 closes.

Existing sessions keep working: `migrateSession` drops `mode`,
`setupMode`, `requirements`, `readiness` and the removed caps; a board
file with `chores`, `sweep`, `size`, `pinned`, `attempts`, `agent` or
`review` parses with those fields dropped. A session that was in goal
mode has its goal and no tickets, and runs as before. A session that was
in loop mode has tickets and no goal, and the lead works them. A session
whose initialization was waiting on a setup request is initialized by the
next Initialize, which now just brings the box up.

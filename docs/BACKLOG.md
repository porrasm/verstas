# Verstas backlog

Ordered work list. Items are written so a fresh session can do one without
further context: what, why, how, what stays compatible, what to test, which
docs to touch. Sizes: S under half a day, M about a day, L several days.
Progress goes in a `Status:` line under the heading.

**Direction (2026-10-04).** Verstas is a loop manager: a box that can
become any development environment, a loop that says "do the next item",
and a boundary that makes it safe to walk away. Setup is the one place a
person is expected; after it, every park is a night lost. The design is
the [Verstas Loop Manager](https://claude.ai/artifact/HZq6BDVKcU1bwLs9MBqxDm)
artifact. Phase 0 (fixes) and Phase 1 (root inside, setup phase) are done;
Phase 2 is below as LM-2x and needs design before it starts.

Rules that apply to every item: `docs/SANDBOX.md` changes in the same commit
as any boundary change; a new loop outcome gets a unit test with the fakes
in `tests/unit/run.spec.ts`; the agent API never gains a route that touches
sessions, Docker or other runs.

---

## V-01 · Remote dashboard relay (MVP)  (M)

**Status: done 2026-10-04**, with two changes to the plan below: HTTPS
push plus long-poll instead of a WebSocket (the monorepo's loefoe agent
pattern; nothing to keep alive through Dokku), and the dashboard drops a
host's state when it stops polling instead of showing the last snapshot.
See docs/REMOTE.md. Not yet: push notifications from the dashboard,
end-to-end encryption of what is relayed.

**Why.** Watch sessions and answer the inbox from a phone without leaving
the Mac open on the desk. Work code stays local by default.

**Shape.** A small service at `agents.porras.club` that owns nothing. In
its web page you create a token; you paste it into Verstas Settings. The
host app opens an outbound WebSocket to the relay and, while it is up,
pushes state; the relay serves a dashboard that shows it and forwards your
actions back. When the host app is down the dashboard shows "offline" and
the last snapshot.

**MVP scope.** Sessions table (name, state, counts, current ticket, cost),
the inbox with approve/deny/answer, ticket titles and states, the last ~50
status and ticket events (never tool results or diffs). Actions: approve,
deny, answer, pause, stop, start.

**Privacy.** A per-session tick "Allow remote dashboard", **off by
default**. Only ticked sessions are pushed. Even for those, tool results,
file contents and diffs are never relayed in the MVP; a later item may add
end-to-end encryption for logs. The relay keeps the last snapshot in memory
only.

**How.** Host side: `src/relay/client.ts` with reconnecting WS, a
`RelayView` built from the hub's change and event streams filtered by the
per-session flag. Relay side: a new app in the porras.club monorepo (Express
+ WS, token table, static dashboard reusing `web/` components where
sensible). Actions arrive as messages and call the same UI API handlers.

**Tests.** Unit: the view builder redacts what it must (property test over
event kinds). e2e with a fake relay server: connect, push, receive an
approve, apply it.

**Docs.** New "Remote dashboard" section in README and SANDBOX.md
("Residual risks": what leaves the machine when the tick is on).

## V-02 · Apply exported work to the real repository  (S)

**Status: done 2026-10-03.** "Apply to repo" per repository on the session
page: bundle inside the container, `git fetch` on the host into the work
target as `verstas/<session>` (force-updated, never the checked-out
branch), commit list since the base, and the next terminal lines.

**Why.** Export writes bundles and prints a `git fetch` line; one click is
better and the host git reading a bundle from your own repo is safe.

**How.** On the session page, per repository: "Apply to work target" runs
on the host `git -C <work target path> fetch <bundle> verstas/<session>:verstas/<session>`
(force-update of that one branch only, never the current branch), then
shows `git log --oneline` of the branch and the exact merge/cherry-pick
lines. Refuse if the work target path moved or is not a git tree. Per-ticket
cherry-pick is a later add since every ticket is one commit.

**Tests.** Unit test against a temp work target: branch appears, current
branch untouched, second apply updates. **Docs.** README "Taking the work
back"; SANDBOX.md Boundary 5 (host git touches only a bundle and your repo).

## V-03 · Setup scripts  (S)

**Status: done 2026-10-03.** Also: the **project brief**. The orientation
(preflight) worker writes `notes/brief.md` (purpose, layout, verified
commands, conventions, traps, where to look for the tickets, under 1500
words); the harness puts it first in every worker prompt and writes a
`/workspace/CLAUDE.md` pointer so Claude Code loads it on its own. "Write
brief" / "Refresh brief" on the session page runs an orientation worker
without ticket work. Library under `~/.verstas/scripts/`, "Setup
scripts" tab, tick at creation, copied into `<session>/setup/`, run as root
on container creation, logs and results on the session page, re-run
button, hosts merged into the allowlist, note in VERSTAS.md. Also shipped:
**agentic initialization** (`caps.preflight`): a preflight worker checks
the box against goal and board before any ticket, files requests, and the
run proceeds only after `PREFLIGHT: ok`.

**Why.** Optional and custom dependencies (Chromium, Postgres, Godot, an SDK
from a zip) without baking everything into the image.

**How.** Settings gets a script library: name, bash body, optional
"needs hosts" list, optional note for `VERSTAS.md`. Stored in
`~/.verstas/scripts/<name>.sh` + `.json`. The New session form lists them
as checkboxes; chosen scripts are copied into `<session>/setup/` so library
edits do not change a running session. After the container is created, each
runs once as root (`bash -e`), output to `<session>/setup/<name>.log`,
shown on the session page; a failure fails creation with the log. Replayed
on container recreate like approved root commands. "Needs hosts" merges
into the session allowlist. A "Re-run setup" button on the session page.

**Tests.** Unit: ordering, copy-on-create, allowlist merge. Docker test by
hand with an `apt-get install tree` script. **Docs.** README; SANDBOX.md
Boundary 7 (scripts are yours, run as root in the box, same rule as
approved commands).

## V-04 · Token never enters the box: proxy credential injection  (M)

**Status: interim done 2026-10-04.** The tokens are no longer in the
container environment (each worker's exec gets them by name) and every
commit is scanned for the Claude token. The proxy injection below is still
open, and matters more now that root in the box can read any process's
environment.

**Why.** Today `CLAUDE_CODE_OAUTH_TOKEN` is in the container environment and
readable by every process, including installers and agent commands. The
only way to keep a secret from a process is not to give it to it.

**How.** Per session, generate a private CA and a leaf cert for
`api.anthropic.com` (openssl on the host). The proxy terminates TLS for
that one host, replaces the `Authorization` header with the real token
(which lives only in the proxy container's env), and forwards over a fresh
TLS connection. The session container gets a dummy token with the right
prefix and trusts the CA via `NODE_EXTRA_CA_CERTS` and the system store.
All other hosts stay opaque tunnels. First verify with a five-minute
experiment that `claude` accepts a dummy token locally before the first
request.

**Also.** The proxy now sees real status codes: rate-limit detection
becomes "a 429 happened" and per-request token counts give an honest cost
view (see V-08).

**Interim (S, do first).** Pass the token only on the worker's
`docker exec -e`, not in the env file, so gates, harness git and approved
root commands never see it. Scan the staged diff for the token before every
commit and block the ticket if found.

**Tests.** Proxy test against a local TLS server with the generated CA.
**Docs.** SANDBOX.md Boundary 6 rewritten.

## V-05 · "Copy context for an LLM"  (S)

**Status: done 2026-10-03.** `GET /api/context?tail=script|board|free`
with image facts probed once per image id; buttons on the Setup scripts
page, the New session board box, and the session's Setup panel.

**Why.** Let any assistant write setup scripts and boards with the facts
of this box, with no model calls from Verstas.

**How.** A generator that assembles Markdown from live facts: image
versions (probed once per image id with `docker run --rm`), sandbox rules
(the same strings `VERSTAS.md` uses), the session's repos, goal and
allowlist, script library names, the board format from `docs/BOARD.md`.
Tails: "write a setup script" (output only bash, idempotent, header naming
download hosts), "write a board" (JSON in this format, repos limited to
these names), free-form. Buttons next to the script textarea, the board box
on New session, and on the session page.

## V-06 · Diff review with "request changes"  (M)

**Why.** Reading a ticket's change in the app and sending line comments
back into the loop closes the human review loop.

**How.** Keep the staged diff per ticket as `runs/<n>/tickets/<id>.diff`
(the harness already computes it for the reviewer). Render with `diff2html`
on the ticket page. Line comments become notes on the ticket; "Request
changes" reopens it to ready with those notes, so the next implementer
sees exactly what the reviewer's notes look like today. "Accept" is the
existing done state.

## V-07 · Tokens as the cost figure  (S)

**Why.** On a subscription, dollars mean nothing; tokens and cache share
show plan consumption.

**How.** Accumulate input, cache-read, cache-write and output tokens per
ticket and per run from the `cost` events (already emitted); show
"1.2M in (90% cached) · 9k out · $0.14 API-equiv." on cards, header and the
sessions list. After V-04 the proxy's counts replace the stream's.

## V-08 · Session resume: keep a Claude session across attempts or tickets  (M)

**Status: deferred by decision, 2026-10-04.** Fresh context per ticket plus
notes for the next worker is the memory model. Resume has real benefits and
stays on the list; it starts only when the questions below have answers
from real runs.

**Why.** Context gathering is the expensive part of a chain of small
tickets, and a retry after a cap or a fixable verdict starts from a report,
a lossy compression of what the previous attempt knew.

**Open questions first.** When to resume (after a park on a request, yes;
after a cap? after a fixable verdict, whose context produced the mistake?).
When to compact, and who decides: Claude Code's own auto-compaction, or a
harness threshold. When to discard: a repo change, a rate-limit sleep, a
reviewer's "blocked". How a resumed session sees what changed while it was
parked (the user's answer, other tickets' commits).

**How, once answered.** Drop `--no-session-persistence`, record the Claude
session id from the init event in `worker_done`, pass `resumeSessionId` in
the next `job.json`, the driver adds `--resume`. Per-session policy
`fresh | keep | auto`; reviewer and planner always fresh. Sessions live in
the home volume, so they survive a container recreate.

## V-09 · UI design pass  (M)

After a few real sessions. Phone-width first (V-01), ticket page as the
primary surface, inbox always visible, board for orientation. Write the
proposal as an artifact before building.

## V-10 · Image packs (bake scripts into images)  (M)

When setup scripts become slow: a script flagged "bake" runs during
`docker build` of a derived image tagged by base + sorted pack names +
architecture + pack version; cached forever, no network at session start.
Same script text as V-03.

## V-11 · Pre-approval rules and notifications  (S each)

Per session: auto-allow listed hosts and packs (root commands no longer
need approval: the agent has sudo). Part of this is LM-25. A notification when a request arrives (voice channel
from the porras.club setup, or the V-01 dashboard's push).

## V-12 · Second worker driver  (M)

**Status: done 2026-10-04; Codex verified live, Cursor pending a key.** Codex CLI and Cursor CLI
drive behind the contract in `docs/DRIVERS.md`, in the same image and the
same worker; a session picks its agents per role under "Agent options"
(the reviewer may differ from the worker). Each agent's credential reaches
the worker process only; Codex's rotating login round-trips through the
worker's stdout and is stored on the host. Claude Code stays the default
and is untouched when the others are missing or unconfigured.

Verified live on 2026-10-04 with Codex CLI 0.160.0: a prompt run inside
the sandbox read the workspace files, ran shell commands, called the board
through the MCP server and the proxy, and finished clean; the stream
shapes match the translator and the generated config passes
`--strict-config`. The proxy allowed `chatgpt.com` only; it denied
`ab.chatgpt.com` (telemetry) and `*.oaiusercontent.com` (attachment
storage), neither needed. Cursor ran live in the sandbox the same day: the agent reached its
backend through the proxy (`*.cursor.sh`), ran tools, and its stream shapes
match the translator. Its board MCP server failed to load in that run
because a project-level `.cursor/mcp.json` shadows the user-level file the
driver writes and demands an interactive approval; the project-level file
is no longer written and the user-level path was verified inside the image
(`agent mcp list` reports the board server ready and a headless run calls
it). One more sandbox run with Cursor should confirm the board round trip
end to end. Still open: the exact quota-exhausted messages (matched by text
today), the shell tool's result summary for Cursor (shows the command, not
its output), and per-driver
rate-limit backoff (pause only the agent that hit its limit); today any
rate limit pauses the run as before.

## V-13 · Parallel tickets  (L)

Two workers on independent tickets in two containers sharing one
workspace; needs per-ticket worktrees or branch-per-ticket merges. Not
before everything above is boring.

## V-14 · Virtual machine sandbox backend  (L, out of MVP scope)

**Why.** Some setups need what a container cannot give safely: root for
the agent, a Docker daemon inside the box (`docker compose up` across ten
repositories, testing Verstas's own sandbox code), kernel-level isolation
instead of a shared kernel. A VM gives all three; nested Docker in a
container does not (socket mount = root on the host, docker-in-docker =
`--privileged`, rootless/Sysbox not available on Docker Desktop).

**Shape.** A second implementation of the sandbox seam (argument builder,
lifecycle, shell, worker runner) driven by a VM CLI: Tart on Apple Silicon
(Virtualization.framework, fast clones from a base image, `softnet`
network isolation with an allowlist), Lima as the alternative, Firecracker
or plain KVM on Linux. Workers start over SSH; logs come over SSH. The
workspace is a shared directory (virtiofs). The proxy and the agent API
stay on the host unchanged; the guest gets a route only to the host, so a
root agent cannot lift the allowlist from inside. Snapshots give a clean
box in seconds. The loop, board and agent API do not change.

**Costs.** Gigabytes of RAM reserved per VM, seconds to a minute to boot,
a disk image per session, two backends to keep working, less convenient
observability than `docker exec`/`docker logs`. Do it only after V-04, so
that a root agent still never holds the real token.

**Trigger.** The first session that genuinely needs Docker inside, or
more than a handful of repositories with their own compose stacks.

## Loop manager, Phase 2 (needs design before it starts)

From the Loop Manager design. Not started; each item wants a short design
pass first, which is why Phase 1 stopped here.

### LM-21 · Better handoffs between fresh workers  (S)

The next attempt's prompt carries the diff stat and the last report; the
implementer files its report early and keeps it current, so a cap does not
erase what it knew; a cap hit twice in a row asks the reviewer to split the
ticket. Open: whether the harness should write a report itself when the
worker filed none.

### LM-22 · Checks the box can pass  (S)

The brief gains a `verify` block (the setup worker writes the commands it
saw pass) and a ticket may carry `checks`; those become the gates, and the
harness's guessed npm/pytest gates stay evidence for the reviewer. Open:
format, and what a check that needs a running service does.

### LM-23 · Sidecar services  (M)

A `service` request kind: image, tag, environment, port. The host app runs
it on the session's internal network, labelled and memory-capped, reachable
as `<name>:<port>`. Official images from a curated list are approved
automatically (decided 2026-10-04); others are one click. Open: pull
through which network, volumes for data, lifecycle with the session.

### LM-24 · Compose reader  (M)

Offers the `image:`-only services of a repository's docker-compose file as
sidecars, and writes their connection strings into env.md. Depends on LM-23.

### LM-25 · Denials become requests by themselves  (S)

The loop already reads the proxy's denial lines. Group them per host and
file a pending network request with the count and the ticket, so a worker
never spends a turn asking for a host it already tried. With pre-approval
rules from V-11.

### LM-26 · Inbox items per done ticket  (S)

The number to steer by, on every session and in the sessions list:
requests filed after the setup phase, divided by done tickets.

### LM-3 · A container runtime inside the box  (L, out of the MVP)

Rootless podman in the session container, or V-14's VM backend. Decided
2026-10-04: out of the MVP; the VM is the likely answer when a real
project needs it, with its resource cost accepted then.

---

## Done

- 2026-10-04 · Draft sessions over MCP (docs/DRAFTS.md): an assistant builds
  a draft step by step through `/mcp` (Streamable HTTP on the UI port, plus a
  stdio bridge); drafts are files under `~/.verstas/drafts`; a review page
  follows edits live; Continue fills the New session form; Create marks the
  draft and makes it read-only. No tool creates or starts a session.
- 2026-10-04 · Loop manager Phase 1: the agent has passwordless sudo (logged),
  `svc` for services, browser libraries in the image, a per-session home
  volume; session requirements with a setup worker and a gate you confirm;
  notes/env.md and notes/setup.sh; a prompt box; a snapshot of the box on
  confirmation; recipes saved from sessions; root_script retired; tokens
  only on the worker's exec and commits scanned for the token.
- 2026-10-04 · Loop manager Phase 0: root in the box can install (Docker's
  default capabilities minus NET_RAW and MKNOD), executable /tmp, approved
  hosts reach the proxy live, attempts count verdicts only, gates advise
  the reviewer, tickets can be done without a diff, host restarts leave no
  orphans, network packs detected from the repositories.

- 2026-10-03 · Requests reshaped: one request = summary + typed actions
  (network, resources, root_script, instruction, question), each decided
  on its own; `halt` is a separate tool; old inbox files migrate on load.
- 2026-10-03 · First real run; fixes: unknown-repo validation at every
  entry point, gates skipped without dependencies, blockers named on pause,
  proxy survives client resets and restarts on failure, sandbox healed per
  ticket, rate limits only on failed results, worker code mounted from the
  host, per-session model, four request kinds with root commands run after
  reading, container recreated only on spec change, legacy inbox migration.

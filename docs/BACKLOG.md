# Verstas backlog

Ordered work list. Items are written so a fresh session can do one without
further context: what, why, how, what stays compatible, what to test, which
docs to touch. Sizes: S under half a day, M about a day, L several days.
Progress goes in a `Status:` line under the heading.

Rules that apply to every item: `docs/SANDBOX.md` changes in the same commit
as any boundary change; a new loop outcome gets a unit test with the fakes
in `tests/unit/run.spec.ts`; the agent API never gains a route that touches
sessions, Docker or other runs.

---

## V-01 · Remote dashboard relay (MVP)  (M)

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

## V-08 · Continuity policy: keep a worker across dependent tickets  (S)

**Why.** Context gathering is the expensive part of a chain of small
tickets; a fresh context per ticket is still the right default.

**How.** Drop `--no-session-persistence`, record the Claude session id
from the init event in `worker_done`, pass `resumeSessionId` in the next
`job.json`, driver adds `--resume`. Per-session policy `fresh | keep | auto`;
`auto` continues when the next ticket depends on the one just finished in
the same repo, and starts fresh after a fixable or blocked verdict, a repo
change, or a rate-limit sleep. Reviewer and planner always fresh.

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

Per session: auto-allow listed hosts; auto-approve root commands matching
a pattern you wrote. A notification when a request arrives (voice channel
from the porras.club setup, or the V-01 dashboard's push).

## V-12 · Second worker driver  (M)

Codex CLI or OpenCode behind the driver contract in `docs/DRIVERS.md`;
derived image with the binary; same board MCP server. Only after V-04, so
the second agent never sees the token either.

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

---

## Done

- 2026-10-03 · First real run; fixes: unknown-repo validation at every
  entry point, gates skipped without dependencies, blockers named on pause,
  proxy survives client resets and restarts on failure, sandbox healed per
  ticket, rate limits only on failed results, worker code mounted from the
  host, per-session model, four request kinds with root commands run after
  reading, container recreated only on spec change, legacy inbox migration.

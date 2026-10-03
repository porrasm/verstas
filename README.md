# Verstas

A local, dockerized workshop where agents work through a kanban board for
hours or days, on fresh clones of your repositories, while you watch, pause,
stop, and take the result back with git. Finnish for "workshop".

The design is in the
[Verstas proposal](https://claude.ai/artifact/BxbpNuVcvLnewg5JTnymdF);
`docs/SANDBOX.md` is the security design and the first thing to read.

## Shape

- **Host app** (`src/`): a Node process you run on your machine. It owns the
  sessions root directory, the board, the run loop, and the Docker CLI. It
  serves the web UI on `127.0.0.1:4700` and a token-protected agent API on
  `4701` that only the sandbox proxy may reach.
- **Session sandbox** (`images/devbox`): one container per session on an
  internal Docker network with no route out except a small allowlist proxy.
  Workers run inside it as `claude -p` (or any other agent command that
  speaks the same event contract, see `docs/DRIVERS.md`) against
  `/workspace`.
- **Board**: tickets in plain JSON (`docs/BOARD.md`), editable by hand in
  the UI, by paste (import), and by the agent through a stdio MCP server
  that talks to the agent API.

## Running it

Requirements: Node 22, Docker Desktop (or a Docker daemon), and Claude Code
installed on the host for `claude setup-token`.

```bash
npm install
npm run build          # host app + the proxy and worker code that containers mount
npm run web:build      # the web UI into web/dist
npm run image:build    # builds verstas-devbox:local (runs npm run build first)
claude setup-token     # long-lived subscription token; paste it in Settings
npm run dev            # host app on http://127.0.0.1:4700
```

Then, in the web app:

1. **Settings**: choose the sessions root (default `~/verstas/sessions`),
   add work targets (local git repositories), paste the Claude token.
2. **New session**: name, goal, pick repositories (fresh clones) and zip
   attachments, edit the network allowlist and caps, optionally paste a
   board. Tick "start the planner" to let it draft tickets from the goal.
3. **Session page**: approve tickets by moving them from backlog to ready,
   start the run, watch the live log, answer requests in the inbox, pause
   or stop at any time.
4. **Recipes** (own tab): bash that runs once when a session's container
   is created, so the box starts set up. After a session's setup worker
   built an environment, "Save as recipe" on the session page puts its
   `notes/setup.sh` and `notes/env.md` in the library; tick it on the next
   session for the same repositories. Hand-written ones run as root; two
   to paste are in `docs/examples/scripts/` (Postgres, Chromium). "Copy
   context for an LLM" gives any assistant the facts of the box so it can
   write one, or a board.
5. **Session requirements** (optional, on the New session form): what the
   box must be able to do before any ticket runs ("Postgres 17 reachable,
   migrations applied; the e2e suite runs"). When set, the session has a
   **setup phase**, the one place it expects you: a setup worker starts
   right after creation, installs what it can with sudo, asks you in one
   request for what it cannot, and runs again once you answer. It reports
   each requirement as met or not. Tickets cannot run until it says
   ready and you press **Confirm and start work**; after that the loop runs
   alone. Left empty, there is no setup phase. The setup worker writes
   three notes every later worker reads: `notes/brief.md` (the project
   brief), `notes/env.md` (what is installed, services, verified
   commands) and `notes/setup.sh` (the recipe that rebuilds the box after
   the container is recreated).
6. **Ask the box** (on the session page): one worker with your text, the
   brief and env.md, outside any ticket. "Make sure you can run the e2e
   suite", "why is the dev server slow?". It can install and configure; a
   repository change becomes one commit; the reply stays on the page.
7. **Remote dashboard** (optional, Settings): follow ticked sessions and
   answer the inbox from your phone through the `verstas` app in the apps
   monorepo. Off by default, and per session off until you tick it; see
   [docs/REMOTE.md](docs/REMOTE.md) for what is and is not sent.
8. **Apply to repo** when you want the work: the session page's Work panel
   puts a repository's commits on the branch `verstas/<session>` in your
   real checkout, one commit per ticket, without touching the branch you
   have checked out. Merge, rebase or cherry-pick from there. Export
   bundles remain for moving work to another machine: one `git fetch` line per
   repository is shown. Bundles are pure data; nothing from the repository
   runs on your machine.
9. **Delete** the session when done. Its containers, network and directory
   go with it.

Run `npm run dev` in a terminal that stays open; the host app stops its
runs when it exits and requeues the ticket a worker held.

## Watching a run closely

Three views, from least to most detail:

- **Session page**: the live log (translated, trimmed events), the board,
  the inbox. Enough for a normal run.
- **Terminal**: `npm run dev` prints one line per API request and per run
  event. `npm run dev:debug` (or `VERSTAS_DEBUG=1`) adds every Docker
  command with its exit code, worker stderr, full tool output, and the
  events untrimmed.
- **Files**, under `<sessions root>/<session>/runs/<n>/`:
  `events.jsonl` (every event), `tickets/<id>.md` (the worker reports per
  ticket), and in debug mode `worker-<ticket>-<role>-<time>.raw.jsonl`,
  the raw `claude -p` stream of each worker, for when you want to see
  exactly what the model saw and said.

Two Docker commands are useful while a run is on:

```bash
docker logs -f verstas-<session-id>-proxy     # allowed and denied connections, live
```

```bash
docker exec -it verstas-<session-id> bash     # look around the box as the agent user
```

## Development

```bash
npm run typecheck && npm run typecheck:web
npm run test:unit
npm run web:dev        # UI with hot reload on 4710, proxied to the host app
```

The unit suite needs no Docker: it covers the board, the proxy (run for
real against local servers), the Docker argument builder, cloning and zip
extraction, the stream translator, the MCP server, the agent API and the
loop with fakes. Running a session needs Docker and the image.

## Documents

- `docs/SANDBOX.md`: what the agent can and cannot touch, and why each
  boundary is where it is. Review this before running a session.
- `docs/BOARD.md`: the ticket and board format for import and export.
- `docs/DRIVERS.md`: the worker contract, for running another agent.
- `docs/REMOTE.md`: the remote dashboard, what it sends and what it can do.

## Layout

```
src/
  core/types.ts       zod schemas: tickets, board, inbox, sessions, runs, events
  board/              pure board logic, import/export, file store
  sessions/           session directories, clones, zips, the in-process hub
  sandbox/            docker argv builder, CLI runner, lifecycle
  proxy/              the allowlist egress proxy (mounted into node:22-alpine)
  worker/             in-container: claude -p driver, stream translator, board MCP server
  agent-api/          what a worker may do, behind a run token
  harness/            the loop, prompts, Docker-backed runner
  web/api.ts          the UI's API (loopback)
  remote/             the remote dashboard client: what is sent, what may be asked
  main.ts             entrypoint
images/devbox/        the session image
web/                  React UI (Vite)
tests/unit/           Playwright unit project
docs/                 SANDBOX, BOARD, DRIVERS, REMOTE
```

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
  Workers run inside it as `claude -p`, `codex exec` or Cursor's `agent -p`
  (chosen per session and per role under "Agent options"; any other agent
  that speaks the same event contract works too, see `docs/DRIVERS.md`)
  against `/workspace`.
- **Board**: tickets in plain JSON (`docs/BOARD.md`), editable by hand in
  the UI, by paste (import), and by the agent through a stdio MCP server
  that talks to the agent API.
- **Drafts**: a session prepared by an assistant on your machine through
  the draft MCP endpoint (`/mcp` on the UI port), step by step, then
  reviewed and created by you (`docs/DRAFTS.md`).

## Running it

Requirements: Node 22.12+, git, Docker Desktop (or a Docker daemon), and
Claude Code on the host for `claude setup-token`.

```bash
npm install
npm run setup     # checks the tools, builds the app, the UI and the images, asks for the Claude token
npm start         # Verstas in its own window
```

`npm run setup` builds everything `npm start` needs: the host app with the
proxy and worker code containers mount (`dist/`), the UI (`web/dist`), the
session image `verstas-devbox:local` and the proxy's `node:22-alpine`. Run it
again after a pull. It asks for the token from `claude setup-token` when
none is saved (you can also paste it later in Settings). Codex and Cursor
are optional: add their credentials in Settings and pick them per session
under "Agent options" (`docs/DRIVERS.md`); without them everything runs on
Claude Code as before.

`npm start` runs the host app inside the desktop window's process. Closing
the window quits Verstas: active runs stop and put their tickets back to
ready, session containers stop, and nothing keeps running out of sight. The
Sessions page has the same controls for the whole host: pause every run,
stop every container, quit.
Without a window: `npm run serve`, then open http://127.0.0.1:4700.

Then, in the web app:

1. **Settings**: choose the sessions root (default `~/verstas/sessions`),
   add work targets (local git repositories), paste the Claude token.
2. **New session**: a name and, if you have one, a board. That is all the
   form asks. The session starts as a **plan**: nothing is cloned and no
   container exists yet. Or let an assistant prepare a draft first
   (**Connect an assistant** on the New session page, `docs/DRAFTS.md`);
   creating from its review page brings its repositories, packs, recipes
   and board along.
3. **Session page, while it is a plan**: add repositories (cloned fresh at
   initialization, at the branch you pick), attachments, recipes, network
   packs, agents and caps, write or import tickets. Come back to it over
   hours if you like. Then press **Initialize** (or **Initialize and
   start**, which goes on to the ready tickets when initialization
   succeeds). Initialization clones the repositories, creates the
   container, runs the recipes and, unless you chose to skip it, a setup
   worker (step 5). After that: approve tickets by moving them from backlog
   to ready, start the run, watch the live log, answer requests in the
   inbox, pause or stop at any time. **Plan tickets…** takes a request
   ("build the mapping engine, done means …") and runs a planner that
   drafts backlog tickets from it and the repositories. **Reset
   environment** removes the container and the clones and makes the
   session a plan again; the board and the notes stay.
4. **Recipes** (own tab): bash that runs once when a session's container
   is created, so the box starts set up. After a session's setup worker
   built an environment, "Save as recipe" on the session page puts its
   `notes/setup.sh` and `notes/env.md` in the library; tick it on the next
   session for the same repositories. Hand-written ones run as root; two
   to paste are in `docs/examples/scripts/` (Postgres, Chromium). "Copy
   context for an LLM" gives any assistant the facts of the box so it can
   write one, or a board.
5. **Setup** (Environment panel on the session page): what happens at
   initialization after the container and the recipes. Two modes. **Setup
   worker** (the default): an agent reads the repositories and the board
   and makes the box a sensible place to develop them: toolchains at the
   pinned versions, dependencies from the lockfiles, the services the
   tests need, the build and test commands verified by running them. It
   implements nothing and installs nothing only a later ticket would need.
   Your **instructions** ("Postgres 17 reachable, migrations applied; the
   e2e suite runs") go on top of that. It asks you in one request for
   what it cannot do and runs again once you answer; a "ready" verdict
   completes initialization (and starts the tickets, with Initialize and
   start). "Needs" leaves the session uninitialized with the report;
   **Accept as is** completes it by hand. **Skip**: the container and the
   recipes only. The setup worker writes three notes every later worker
   reads: `notes/brief.md` (the project brief), `notes/env.md` (what is
   installed, services, verified commands) and `notes/setup.sh` (the
   recipe that rebuilds the box after the container is recreated).
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

Runs continue while Verstas is open (on macOS, also with the window
closed). Quitting stops them and requeues the ticket a worker held.

## Watching a run closely

Three views, from least to most detail:

- **Session page**: the live log (translated, trimmed events), the board,
  the inbox. Enough for a normal run.
- **Terminal**: `npm start` and `npm run serve` print one line per API
  request and per run event. `npm run dev` (or `VERSTAS_DEBUG=1`) adds
  every Docker command with its exit code, worker stderr, full tool
  output, and the events untrimmed.
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
npm run dev       # watch everything, debug logs, a window with DevTools
npm run typecheck && npm run typecheck:web
npm run test:unit
```

`npm run dev` runs four processes in one terminal: `tsc --watch` (keeps
`dist/` current for the containers), the host app under `tsx watch` with
`VERSTAS_DEBUG=1` (docker commands, raw worker streams, full tool output),
Vite with hot reload on 4710, and a window on it with DevTools open.
Closing the window or Ctrl-C stops all four. `npm run dev:server` is the
host app alone in watch mode, without a window.

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
- `docs/DRAFTS.md`: draft sessions over MCP, how to connect an assistant.

## Layout

```
src/
  core/types.ts       zod schemas: tickets, board, inbox, sessions, runs, events
  board/              pure board logic, import/export, file store
  sessions/           session directories, clones, zips, the in-process hub
  sandbox/            docker argv builder, CLI runner, lifecycle
  proxy/              the allowlist egress proxy (mounted into node:22-alpine)
  worker/             in-container: the worker loop, one driver per agent (Claude, Codex, Cursor), translators, board MCP server
  agent-api/          what a worker may do, behind a run token
  harness/            the loop, prompts, Docker-backed runner
  web/api.ts          the UI's API (loopback)
  remote/             the remote dashboard client: what is sent, what may be asked
  drafts/             draft sessions: model, file store, MCP tools, /mcp endpoint, stdio bridge
  server.ts           startVerstas(): the host app, for the window and the command line
  main.ts             command-line entrypoint (npm run serve, npm run dev:server)
electron/main.mjs     the desktop window (npm start, npm run dev)
scripts/              setup.mjs (npm run setup), dev.mjs (npm run dev)
images/devbox/        the session image
web/                  React UI (Vite)
tests/unit/           Playwright unit project
docs/                 SANDBOX, BOARD, DRIVERS, REMOTE, DRAFTS
```

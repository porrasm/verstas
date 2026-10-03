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
npm run build          # host app + the proxy and worker the image needs
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
4. **Export bundles** when you want the work: one `git fetch` line per
   repository is shown. Bundles are pure data; nothing from the repository
   runs on your machine.
5. **Delete** the session when done. Its containers, network and directory
   go with it.

Run `npm run dev` in a terminal that stays open; the host app stops its
runs when it exits and requeues the ticket a worker held.

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
  main.ts             entrypoint
images/devbox/        the session image
web/                  React UI (Vite)
tests/unit/           Playwright unit project
docs/                 SANDBOX, BOARD, DRIVERS
```

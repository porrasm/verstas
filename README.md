# Verstas

A local, dockerized workshop where agents work through a kanban board for
hours or days, on fresh clones of your repositories, while you watch, pause,
stop, and take the result back with git. Finnish for "workshop".

Status: early implementation. The design is in the
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
  speaks the same event contract) against `/workspace`.
- **Board**: tickets in plain JSON, editable by hand in the UI, by paste
  (import), and by the agent through a stdio MCP server that talks to the
  agent API.

## Development

Node 22. `npm install`, then:

```bash
npm run typecheck
npm run test:unit
```

The host app does not depend on Docker at build or test time; only running a
session does.

## Documents

- `docs/SANDBOX.md`: what the agent can and cannot touch, and why each
  boundary is where it is. Review this before running a session.
- `docs/BOARD.md`: the ticket and board JSON format for import and export
  (added with the board module).

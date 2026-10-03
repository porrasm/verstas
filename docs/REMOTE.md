# Remote dashboard

Follow sessions and act on them from your phone while Verstas runs on your
machine. Optional, off until you turn it on, and **per session off by
default**: nothing about a session leaves this machine until you tick
"Remote dashboard" on its page.

## Shape

```
 phone ──https──▶ dashboard (apps monorepo, `verstas` app)  ◀──https── Verstas (this repo)
                  owns nothing: last push in memory,             pushes ticked sessions,
                  your actions queued in memory                  long-polls for actions
```

- **Verstas connects out; nothing here listens.** The UI stays on
  `127.0.0.1`. One outbound HTTPS client pushes state and long-polls for
  commands (`src/remote/client.ts`).
- **The dashboard owns nothing.** It keeps the last push and the command
  queue in its process memory. Its database holds only each token's sha256
  and a name. When Verstas stops (cleanly: it says so; or by crashing: it
  stops polling) the dashboard drops the state within 45 s and shows
  "Verstas is not running" with no sessions. It never shows a stale copy.
- **Actions are commands Verstas checks.** A command names a kind and a
  payload. Verstas validates it (`src/remote/commands.ts`), refuses it for a
  session you did not tick, and carries it out through its own UI API on
  the loopback address, the same handler a click in the local UI uses.

## Setting it up

1. In the dashboard (`/verstas` on the apps site), open **Tokens**, create
   one (name it after the machine) and copy it. It is shown once.
2. In Verstas, **Settings → Remote dashboard**: paste the base URL (the
   dashboard's origin, e.g. `https://porras.club`) and the token, press
   **Test connection**, then tick **Connect to the remote dashboard**.
3. On each session you want to see there, click **Remote dashboard: off**
   in the header and confirm.

For testing against a local dashboard, use `https://localhost:3001` (the
monorepo's dev backend). A self-signed certificate is accepted for
loopback addresses only; `http://` is accepted only for loopback too.

## What is sent, for a ticked session

Sent (texts capped): name, state, goal, repository names, requirements and
the setup verdict, run state and costs, every ticket (title, kind, state,
priority, spec, acceptance, last report, last notes, diff size), open
requests and the last ten answered ones, the last twenty agent messages,
the last five prompts and replies, and the run's last 80 activity lines.

Never sent: tool results (command output, file contents), diffs, worker
stderr, the full worker report text of `worker_done` events, setup logs,
the sudo log, notes files, secrets, the allowlist and settings of a
session. A tool call shows as one line, e.g. `Bash: npm test`.

## What the dashboard can do

| Command | Becomes |
|---|---|
| `run` start, pause, stop, setup, plan, prompt | `POST /sessions/:id/run` |
| `decide` approve/decline actions, answer | `POST /sessions/:id/requests/:rid` |
| `ticket.create` | `POST /sessions/:id/tickets` |
| `ticket.move` to backlog, ready, blocked, done | `POST /sessions/:id/tickets/:tid/state` |
| `ticket.update` title, spec, priority | `PUT /sessions/:id/tickets/:tid` |
| `ticket.note` | `POST /sessions/:id/tickets/:tid/notes` |
| `tickets.approveAll` | `POST /sessions/:id/tickets/approve-all` |
| `setup.confirm` | `POST /sessions/:id/setup/confirm` |
| `message.read` | `POST /sessions/:id/messages/:mid/read` |

Not possible remotely: creating or deleting sessions, settings, the
allowlist, caps, recipes, secrets, export and apply, reading files or logs.
Approving a network or pack request from the phone does widen that
session's allowlist, exactly as it does locally.

## Protocol (version 1)

All under `<base>/api/verstas/host`, with `Authorization: Bearer <token>`.
A wrong token gets 404.

- `GET /hello` → `{ ok, protocol, name }`: the settings page's test.
- `POST /state` with `{ protocol: 1, host: { version, sentAt }, sessions: [...] }`
  a second after any change to a ticked session and every 15 s.
- `GET /commands?wait=25` → `{ commands: [{ id, kind, payload }], needState }`.
  `needState` asks for a push at once (the dashboard restarted).
- `POST /commands/:id` with `{ ok, status?, error?, result? }`.
- `DELETE /state` when Verstas stops or the connection is turned off.

The session shape is `remoteSession()` in `src/remote/view.ts`; the
dashboard's copy of the types is `common/src/apps/verstas.ts` in the apps
monorepo. Change both together and bump the protocol when a field changes
meaning.

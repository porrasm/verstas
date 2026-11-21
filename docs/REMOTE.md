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

## One round of work, and nothing else

The dashboard is not a second Verstas UI. It does one round of work from
start to finish, away from the machine: new work in the same box, paste a
board, set the goal, start, pause and stop, message the lead, read and
clear the inbox, stop the container and publish draft pull requests. Managing a
session stays in the app: its repositories, agents, recipes, settings and
the allowlist, and editing tickets. A session appears there only once it
is initialized; a plan has nothing to run or watch.

## What is sent, for a ticked, initialized session

Sent (texts capped): name, state, the goal and the lead's claim that it is
met, run state and costs, every ticket (title, kind, state, priority,
spec, acceptance, last report, last notes, diff size), open requests and
the last ten answered ones, the last thirty messages from the agents, the
ideas not yet promoted (what Clear inbox hid is not sent, and of the
progress updates only the latest), the last five prompts you asked the box and their
replies, the run's last 80 activity lines, whether the container runs,
and for each GitHub repository: its name, base branch, how many commits
and uncommitted files the clone has (read at most once a minute while the
container runs) and its latest pull request (number, link, state, title).
The outcome of the dashboard's last action on the session is sent too, so
a publish that took a minute still shows its answer.

Never sent: tool results (command output, file contents), diffs, commit
subjects, worker stderr, the full worker report text of `worker_done`
events, setup and its verdict, notes files, secrets, the allowlist and
the settings of a session. A tool call shows as one line, e.g.
`Bash: npm test`.

## What the dashboard can do

| Command | Becomes |
|---|---|
| `run` start, pause, stop, prompt (ask the box) | `POST /sessions/:id/run` |
| `message` (to the lead running now) | `POST /sessions/:id/run/message` |
| `goal.set` | `PUT /sessions/:id/goal` |
| `board.import` (a pasted board) | `POST /sessions/:id/board/import` |
| `board.clear` | `POST /sessions/:id/board/clear` |
| `decide` approve/decline actions, answer | `POST /sessions/:id/requests/:rid` |
| `message.read` | `POST /sessions/:id/messages/:mid/read` |
| `inbox.clear` | `POST /sessions/:id/inbox/clear` |
| `ticket.create` | `POST /sessions/:id/tickets` |
| `ticket.approve` (backlog to ready) | `POST /sessions/:id/tickets/:tid/state` |
| `tickets.approveAll` | `POST /sessions/:id/tickets/approve-all` |
| `work.new` (New work: a goal, a board, start) | `POST /sessions/:id/new-work` |
| `publish` (Publish all as drafts) | `POST /sessions/:id/publish-all` |
| `container.stop` | `POST /sessions/:id/sandbox` |

`publish` is Publish all: a draft pull request per repository with the
default title and text, or an update of the open one. When the changes
touch CI or build files nothing is pushed and the files are named; the
dashboard asks before sending `acknowledgeFlagged`. `work.new` is New
work, with all it clears and discards; from the dashboard it never stops
a run on its way (an active run refuses) and leaves the goal template as
it is. A pasted board always adds; updating tickets by id stays in the
app.

Not possible remotely: initializing, recipes, editing or moving tickets
other than approving them, creating or deleting sessions, settings, the
allowlist, caps, secrets, goal templates, syncing or publishing one
repository, removing the container, reclone, export, the
agent terminal, reading files or logs. Approving a network or pack
request from the phone does widen that session's allowlist, exactly as it
does locally.

## Protocol (version 3)

All under `<base>/api/verstas/host`, with `Authorization: Bearer <token>`.
A wrong token gets 404.

- `GET /hello` → `{ ok, protocol, name }`: the settings page's test.
- `POST /state` with `{ protocol: 3, host: { version, sentAt }, sessions: [...] }`
  a second after any change to a ticked session and every 15 s.
- `GET /commands?wait=25` → `{ commands: [{ id, kind, payload }], needState }`.
  `needState` asks for a push at once (the dashboard restarted).
- `POST /commands/:id` with `{ ok, status?, error?, result? }`; `result` is
  the UI API's answer when it is small (which tickets a paste made, each
  repository's pull request).
- `DELETE /state` when Verstas stops or the connection is turned off.

The session shape is `remoteSession()` in `src/remote/view.ts`; the
dashboard's copy of the types is `common/src/apps/verstas.ts` in the apps
monorepo. Change both together and bump the protocol when a field changes
meaning.

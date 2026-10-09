# Worker drivers

A driver is what runs one ticket inside the session container. The
reference driver is Claude Code (`src/worker/worker.ts`, shipped in the
image as `/opt/verstas/worker.js`). The same worker also drives Codex CLI
and Cursor CLI (`src/worker/driver-*.ts`): a session chooses its agents
under "Agent options", per role, and the reviewer may be a different agent
(a single ticket may also name its own agent, `docs/BOARD.md`, for work
that needs that agent's particular strength)
than the worker. Any other agent can replace the worker by honouring the
same contract; the loop does not change.

## The contract

The harness runs, inside the container as the agent user, with
`/workspace` as the working directory:

```
<driver command> --job /workspace/.verstas/jobs/<run>-<n>-<role>/job.json
```

Each worker has its own directory under `/workspace/.verstas/jobs`, so two
workers of one run (a lead and the reviewer judging its ticket) never share
a file. `job.json`:

```jsonc
{
  "role": "implementer",            // implementer | reviewer | planner | setup | prompt | lead
  "ticket": "T-12",                 // absent for the planner and the lead
  "promptFile": "/workspace/.verstas/jobs/4-7-implementer/prompt.md",   // the task
  "systemPromptFile": "/workspace/.verstas/jobs/4-7-implementer/system.md", // the rules
  "caps": { "minutes": 25, "turns": 60, "budgetUsd": 5 },
  "mcpConfigFile": "/workspace/.verstas/mcp.json",       // board tools
  "driver": "claude",               // claude | codex | cursor; absent means claude
  "model": "claude-fable-5-1",      // optional; any id the chosen CLI accepts
  "budgetFile": "/workspace/.verstas/jobs/4-7-implementer/budget.json",  // optional
  "agentSession": { "id": "…uuid…", "resume": false }   // optional
}
```

`agentSession` asks the driver to keep the agent's conversation on disk
under that id (`resume: false`) or to continue it (`resume: true`). The
Claude driver passes `--session-id` or `--resume`; a driver that cannot
resume ignores it and starts fresh. A resume that fails before its first
turn makes the harness retry once with a fresh conversation.

`budgetFile`: write the running totals there after every turn (`turns`,
`seconds`, `contextTokens` as the last call's input tokens, `outputTokens`,
`caps`), atomically. The board server's `budget` tool reads it. Set
`VERSTAS_ROLE` (the job's role) and `VERSTAS_BUDGET_FILE` in the board
server's environment: the role decides which tools it shows.

The driver must:

1. Do the work described in `prompt.md`, under the rules in `system.md`,
   in `/workspace`.
2. Use the board through the MCP server named in `mcp.json` (stdio, see
   below), or call the agent API directly with the same HTTP calls. The
   API base URL and the run token are in `VERSTAS_AGENT_API` and
   `VERSTAS_RUN_TOKEN`.
3. Write **events** to stdout, one JSON object per line, in Verstas's event
   schema (`src/core/types.ts`, `eventSchema`). Unknown lines are ignored.
   The useful kinds: `text`, `tool_use`, `tool_result`, `status`, `cost`,
   `error`.
4. Stop by itself at the caps, and end with one `worker_done` line.
   Optionally, read **messages from the user** on stdin, one JSON line
   `{"kind":"message","text":"…"}` each, and hand them to the agent as
   user messages; a driver that cannot is simply never sent one (the
   harness refuses the message with a reason).
5. Keep the agent alive while one of its background commands runs. The
   built-in Claude driver uses streaming input for this: a turn that ends
   with a command still running is not the end of the session, the agent
   is re-invoked when the command finishes, and the session ends when a
   turn ends with nothing running. That is what makes sleep-polling
   unnecessary; the rules tell the agent so.
6. End with the `worker_done` line:

```json
{"kind":"worker_done","t":"…","ticket":"T-12","role":"implementer","ok":true,
 "stopReason":"success","rateLimited":false,"costUsd":0.42,"turns":12,
 "seconds":380,"text":"final message","stderr":""}
```

`rateLimited: true` makes the loop sleep instead of blaming the ticket.
Exit code 0 means `ok`.

The harness, not the driver, decides what happens to the ticket: it reads
`worker_done`, runs the gates, starts the reviewer, commits, and moves the
card. A lead submits its tickets itself (`board_submit`), and the harness
judges each one the same way while the lead waits.

## The board MCP server

`/opt/verstas/mcp-server.js` is a dependency-free stdio MCP server exposing
the board tools: `board_list_tickets`, `board_get_ticket`, `board_add_note`,
`board_report`, `board_create_ticket`, `chore`, `chores_list`, `board_set_priority`,
`board_add_dep`, `request` (summary + actions: network, pack, resources,
instruction, question), `halt`, `message`, `idea`. Each is one call to the
agent API under `/agent/`; the API enforces every rule. A driver that
speaks MCP can load it with:

```json
{ "mcpServers": { "board": { "command": "node", "args": ["/opt/verstas/mcp-server.js"] } } }
```

Inside the box, plain HTTP must go through the proxy (`HTTP_PROXY` is set);
`src/worker/http.ts` shows the forward-proxy request form.

## The built-in agents

| | Claude Code | Codex CLI | Cursor CLI |
|---|---|---|---|
| Command | `claude -p --input-format stream-json --output-format stream-json` | `codex exec --json` (prompt on stdin) | `agent -p --output-format stream-json --force` |
| Messages from the user mid-run | yes (a user message on stdin) | no | no |
| Background commands outlive a turn | yes (the agent is re-invoked) | no | no |
| Rules (`system.md`) | `--append-system-prompt` | prepended to the prompt | prepended to the prompt |
| Board MCP server | `--mcp-config .verstas/mcp.json` | `$CODEX_HOME/config.toml`, written per run | `~/.cursor/mcp.json`, written per run (a project-level file would need an interactive approval) |
| Pointers file | `CLAUDE.md` | `AGENTS.md` | `AGENTS.md` (and `CLAUDE.md`) |
| Credential, env var | setup token, `CLAUDE_CODE_OAUTH_TOKEN` | `auth.json` contents, `VERSTAS_CODEX_AUTH` | user API key, `CURSOR_API_KEY` |
| Network pack | `anthropic` | `openai` (`chatgpt.com` confirmed live) | `cursor` (`*.cursor.sh`, confirmed live) |
| Reports USD cost | yes (`--max-budget-usd` applies) | tokens only; budget cap does not apply | no; budget cap does not apply |
| Quota exhausted | `result` line names it | `turn.failed` message text | `result` error text |

The image installs all three (`images/devbox/Dockerfile`); the Codex and
Cursor installs are best-effort. A job for an agent whose binary is
missing ends with `worker_done` `stopReason: "driver_missing"` and the
ticket is handled like any failed worker; sessions on Claude Code never
notice.

### Credentials and the no-pay-as-you-go setup

Each agent's credential lives in `~/.verstas/secrets.json` (mode 0600) and
reaches only the worker process, by name on its `docker exec`
(docs/SANDBOX.md, Boundary 6). Use subscription logins:

- **Claude**: `claude setup-token` (Pro or Max); long-lived.
- **Codex**: `codex login --device-auth` on the host with a ChatGPT
  account, then "Import login" in Settings. Codex rotates the tokens in
  `auth.json` (about every eight days; the refresh token is single use).
  The driver writes the file into a private `CODEX_HOME` for the run and,
  when Codex changed it, hands it back on stdout as one line
  `{"kind":"credential","driver":"codex","value":"<file>"}`. The harness
  stores it and never logs it, so the next run starts from the rotated
  token. Once the login is older than seven days, Codex workers run one at
  a time across sessions until the refreshed file is stored. Never import
  an API-key login: that bills per use.
- **Cursor**: a user API key from the Cursor dashboard. It authenticates
  the Cursor account and draws on the plan, not on a provider key.

Verstas cannot see your account's billing switches. For a hard stop at the
plan's limit turn off: Claude "extra usage"; Codex usage credits (keep the
balance at zero) and automatic reload; Cursor on-demand usage. An
exhausted quota then fails the worker, the translator marks it
`rateLimited`, and the loop pauses and retries instead of blaming the
ticket.

## Writing a driver for another agent

- Add a `DriverImpl` in `src/worker/driver-<name>.ts` (how to spawn, how to
  translate output lines, what to do after exit) and register it in
  `DRIVER_IMPLS`; add the host side (credential field, env var, pack,
  hint, models) to `src/harness/drivers.ts` and the name to
  `driverNameSchema`. Put the binary in the image.
- Or, outside this codebase: write a launcher that reads `job.json`, runs
  the agent in print or batch mode with the prompt and the MCP config,
  maps its output to events, enforces the caps, and prints `worker_done`,
  and point the worker command at it. The session container, the proxy,
  the agent API and the loop stay the same.

# Worker drivers

A driver is what runs one ticket inside the session container. The
reference driver is Claude Code (`src/worker/worker.ts`, shipped in the
image as `/opt/verstas/worker.js`). Any other agent can replace it by
honouring the same contract; the loop does not change.

## The contract

The harness runs, inside the container as the agent user, with
`/workspace` as the working directory:

```
<driver command> --job /workspace/.verstas/job.json
```

`job.json`:

```jsonc
{
  "role": "implementer",            // implementer | reviewer | planner
  "ticket": "T-12",                 // absent for the planner
  "promptFile": "/workspace/.verstas/prompt.md",         // the task
  "systemPromptFile": "/workspace/.verstas/system.md",   // the rules
  "caps": { "minutes": 25, "turns": 60, "budgetUsd": 5 },
  "mcpConfigFile": "/workspace/.verstas/mcp.json",       // board tools
  "model": "claude-fable-5-1"       // optional
}
```

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
4. Stop by itself at the caps, and end with one `worker_done` line:

```json
{"kind":"worker_done","t":"…","ticket":"T-12","role":"implementer","ok":true,
 "stopReason":"success","rateLimited":false,"costUsd":0.42,"turns":12,
 "seconds":380,"text":"final message","stderr":""}
```

`rateLimited: true` makes the loop sleep instead of blaming the ticket.
Exit code 0 means `ok`.

The harness, not the driver, decides what happens to the ticket: it reads
`worker_done`, runs the gates, starts the reviewer, commits, and moves the
card.

## The board MCP server

`/opt/verstas/mcp-server.js` is a dependency-free stdio MCP server exposing
the board tools: `board_list_tickets`, `board_get_ticket`, `board_add_note`,
`board_report`, `board_create_ticket`, `board_set_priority`,
`board_add_dep`, `request` (summary + actions: network, pack, resources,
instruction, question), `halt`, `message`, `idea`. Each is one call to the
agent API under `/agent/`; the API enforces every rule. A driver that
speaks MCP can load it with:

```json
{ "mcpServers": { "board": { "command": "node", "args": ["/opt/verstas/mcp-server.js"] } } }
```

Inside the box, plain HTTP must go through the proxy (`HTTP_PROXY` is set);
`src/worker/http.ts` shows the forward-proxy request form.

## Writing a driver for another agent

- Put the agent's binary in a derived image (`FROM verstas-devbox:local`).
- Write a small launcher that reads `job.json`, runs the agent in print or
  batch mode with the prompt and the MCP config, maps its output to events,
  enforces the caps, and prints `worker_done`.
- Point the session's driver command at it. The session container, the
  proxy, the agent API and the loop stay the same.

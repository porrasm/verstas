# Draft sessions over MCP

Plan a session with an assistant, let it write the plan into Verstas step by
step, then review it and create the session yourself. The assistant prepares;
only you create, start or run.

## What a draft holds

| Field | Notes |
| --- | --- |
| Name, goal | The goal becomes the first planning request on the session page (Plan tickets); it is not part of the setup and workers do not read it. |
| Session requirements | Instructions for the setup worker, on top of what it works out from the repositories and the board. |
| Notes | For you: the assistant's assumptions and open questions. |
| Repositories | Work targets from Settings, with a branch and an optional directory name. A draft cannot add work targets. |
| Network | Packs and extra hosts. The Claude API is always on. |
| Recipes | Library recipes by name. A draft never carries a script of its own. |
| Board | Tickets in the board format (`docs/BOARD.md`), including a ticket's optional `agent` (its own driver and model) and chores. |

Left out on purpose: caps, budget, model, memory limits and attachments. You
set those on the session page, before you initialize.

Drafts are files in `~/.verstas/drafts/<id>.json` (`$VERSTAS_HOME/drafts`),
written only by the host app.

## Connect an assistant

Verstas must be running. The Sessions page and the New session page have a
**Connect an assistant** panel with these filled in for your installation:

- **Claude Code**, once, for every project:

  ```bash
  claude mcp add --scope user --transport http verstas http://127.0.0.1:4700/mcp
  ```

- **Claude Desktop** and other clients that start a command: an entry in
  `claude_desktop_config.json` that runs `dist/src/drafts/mcp-stdio.js` with
  Node. The bridge holds no logic; it forwards each message to the same
  endpoint. Run `npm run build` once so the file exists (`npm run --silent
  mcp` starts it by hand; without `--silent`, npm's banner would corrupt
  the stdio stream). Inside the desktop
  app the panel gives Electron's own binary with `ELECTRON_RUN_AS_NODE=1`.

Then describe what you want built, and send the panel's first message: it
asks the assistant to read `verstas_context`, build the draft step by step,
validate it, and give you the review link.

## Tools

| Tool | Does |
| --- | --- |
| `verstas_context` | The box, the network rules, the recipe library, the board format, the packs and the workflow. Read first. |
| `list_repositories` | Work targets with branches and the packs their manifests imply. |
| `list_recipes` | The recipe library, optionally with the scripts. |
| `draft_list`, `draft_get`, `draft_get_ticket` | Read drafts. |
| `draft_create` | A new draft from a name and a goal. |
| `draft_update` | Name, goal, requirements, notes. |
| `draft_set_repositories`, `draft_set_network`, `draft_set_recipes` | Replace those lists. Unknown work targets, branches, packs and recipes are refused. |
| `draft_add_tickets` | Up to 20 tickets per call. A dependency on a ticket added later is allowed and shows as a problem until it exists. |
| `draft_update_ticket`, `draft_remove_tickets` | Edit tickets. Removing a ticket drops it from other tickets' deps and says which. |
| `draft_import_board` | A whole board at once, merged by id or replacing. |
| `draft_validate` | Errors (what creation would refuse) and warnings (weak tickets). |

Every editing tool answers with the draft's problems and the review link.
There is no tool that deletes a draft, creates, starts or runs a session, or
touches settings; the unit test `tests/unit/drafts-mcp.spec.ts` pins the
list.

## Review and create

1. The draft appears on the Sessions page as it is written; its page
   (`#/d/<id>`) follows the assistant's edits live.
2. **Continue to create session** opens the New session form with the
   draft's name and board; its repositories, requirements, packs and
   recipes come along.
3. **Create** is the normal create call with the draft's id. The session
   is a plan: change anything on its page (repositories, caps, agents,
   attachments), then press Initialize. The draft is marked with the
   session it became and is read-only from then on, to the assistant and
   to a second Create.

Errors block Continue. Delete a draft from its page.

## Boundaries

- The endpoint is `POST /mcp` on the UI port, bound to `127.0.0.1`. It
  answers only requests whose `Host` is a loopback name and refuses any
  `Origin` that is not loopback, so a web page cannot reach it through DNS
  rebinding.
- The draft tools read the work targets' branch names and manifests (as
  data, like the New session form) and write draft files. They run nothing
  in a container and nothing from a repository.
- The surface is the boundary for an assistant that only has these tools.
  An assistant that also has a shell on your machine can do whatever you
  can, including calling the UI API; the MCP server does not contain it.

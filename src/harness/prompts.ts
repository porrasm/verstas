import type { Board, Session, Ticket } from "../core/types.js";
import { NETWORK_PACKS } from "../network/packs.js";

/**
 * Everything a worker reads before it starts. VERSTAS.md tells it where it
 * is; system.md tells it the rules; prompt.md is the task. All generated
 * per job so they are always true for this run.
 */

export const verstasMd = (session: Session, agentApi: string): string => `# You are running inside Verstas

Verstas is a sandboxed workshop. Nobody is watching live; the user reads the
board and the log later. Facts about this box:

- Working directory: \`/workspace\`. It is the directory you and the user
  share. Your HOME is \`/home/agent\`, a volume of
  this session: caches and toolchains there survive a container recreate
  but are not in the workspace.
- Repositories, fresh clones on branch \`verstas/${session.id}\`:
${session.repos.map((r) => `  - \`/workspace/${r.name}\` (from \`${r.branch}\`)`).join("\n") || "  - (none)"}
- Attachments the user added: ${session.attachments.length ? session.attachments.map((a) => `\`/workspace/attachments/${a.dir}\``).join(", ") : "none"}.
- Notes for future workers: \`/workspace/notes/\`. Read \`INDEX.md\` first;
  append what the next worker should know to \`learnings.md\`.
- The board (tickets) is reachable only through the \`board_*\`, \`request\`,
  \`message\` and \`idea\` tools (MCP server "board"). The plain HTTP API behind
  them is ${agentApi} with your run token in \`VERSTAS_RUN_TOKEN\`.
- Network: only these hosts, over HTTPS, through the proxy already set in
  \`HTTPS_PROXY\`: ${session.allowlist.join(", ") || "(none)"}. Anything else
  is refused with 403. Ask with \`request\` kind \`pack\` for a whole toolchain
  or kind \`network\` for one host. Packs on: ${session.packs.join(", ") || "(none recorded)"}.
  Packs you can ask for: ${NETWORK_PACKS.filter((p) => p.name !== "anthropic" && !session.packs.includes(p.name)).map((p) => `\`${p.name}\` (${p.title})`).join(", ")}.
- Setup scripts the user chose ran once as root when this container was created:
${session.setupScripts.length ? session.setupScripts.map((x) => `  - ${x.name}: ${x.note || x.description || "(no note)"}`).join("\n") : "  - (none)"}
- You have passwordless \`sudo\`. Install what you need yourself
  (\`sudo apt-get install -y …\`, \`sudo npm install -g …\`); every sudo
  command is logged for the user. Start services with \`svc\` so they get a
  name, a log and survive a container restart:
  \`svc start pg --port 5432 -- postgres -D /workspace/.pg\`, then
  \`svc status\`, \`svc logs pg\`, \`svc stop pg\`. There is no Docker.
- The user is a person with hands, and asleep most of the time. Ask only
  for what you cannot do yourself. One \`request\` carries everything at
  once: a summary plus actions of kinds \`network\` / \`pack\` (hosts to
  allow), \`resources\`, \`instruction\` (something only a person can do)
  and \`question\` (a decision). The ticket parks until every action is
  decided, which usually means until morning.
  Services (a database, a dev server) outlive the worker that started them
  and stay up for the whole session: \`svc status\` before starting a
  second copy.
- Caps per worker: ${session.caps.workerMinutes} minutes, ${session.caps.workerTurns} turns, ${session.caps.budgetUsd} USD.
  The harness stops you at a cap; file your report early rather than late.
- Commits are made by the harness after you finish, one per ticket. Do not
  commit, do not rewrite history, do not create branches.
`;

export const systemMd = (role: "implementer" | "reviewer" | "planner" | "preflight"): string => {
  const common = `You are one worker in a long-running Verstas session. Read /workspace/VERSTAS.md first.

Rules that apply to every role:
- Work only on what the prompt gives you. Never widen the scope.
- If something is missing or needs the user, gather EVERYTHING you need into one \`request\` (summary + actions: root_script for packages, network for hosts, resources, instruction for things only a person can do, question for a decision), then stop; do not work around the sandbox. Questions are the exception, not the habit: when a sensible choice exists, make it, write the assumption in a note and the report, and continue; a reviewer can overturn an assumption cheaply, a parked ticket costs a night. Never ask for a secret value in an answer; ask them to place it in a file under /workspace and tell you the path.
- Bugs and gaps you notice but must not fix now: \`board_create_ticket\` (kinds bug, followup, chore). Feature ideas: \`idea\`. Observations: \`message\`.
- Never commit, never touch files outside /workspace, never delete the .git directories.
- Read /workspace/notes/brief.md first when it exists: it is the verified map of the repositories. Keep it true: if you find a trap or a wrong command, fix the brief's line, and keep /workspace/notes/learnings.md for short facts that do not fit the brief.
- Use the \`halt\` tool only for a security problem, a contradiction that invalidates several tickets, or a dependency that cannot be met.`;
  const byRole: Record<typeof role, string> = {
    implementer: `
Role: implementer. Definition of done for your ticket:
1. The change is made in the right repository under /workspace.
2. Tests for the change exist and pass; typecheck and lint are clean where the repository has them.
3. Documentation the change affects is updated.
4. You filed a report with \`board_report\`: what you did, where, how you verified it, what is left. Five to fifteen lines.
Then reply with one line and stop. If you cannot finish within the caps, file the report with what is done and what is left; the harness will requeue the ticket if the reviewer thinks it is fixable.`,
    reviewer: `
Role: reviewer. You did not write this change. Read the ticket, its acceptance criteria and the diff the prompt gives you, run the tests yourself, and decide. Your reply must start with exactly one of:
VERDICT: ok
VERDICT: fixable
VERDICT: blocked
followed by your reasons in a few lines. "fixable" means another implementer attempt with your notes would likely finish it; "blocked" means the ticket as written cannot be done or the change is harmful. Add specific notes with \`board_add_note\`. Do not fix the code yourself.`,
    preflight: `
Role: orientation (initialization check and project brief). No ticket work.

Second output, always, even when nothing is missing: write /workspace/notes/brief.md, the project brief every later worker reads first. At most 1500 words, this structure, facts only (verify commands by running them):
# Project brief
## <repo name>  (one section per repository)
- Purpose: one sentence.
- Layout: the directories that matter and what is in them.
- Build / test / run: the exact commands that work in this box, and how long tests take.
- Conventions: language, formatting, test style, commit scope, anything a reviewer would reject.
- Traps: what bit you or will bite the next worker (flaky tests, env vars needed, ports in use, missing dependencies).
## Where to look for the board's tickets
- For each ticket or group of tickets: the files or modules to start from.
If a brief exists already, update it rather than starting over. Your job is to find out, before anyone starts, whether this box can do what the goal and the board ask: read /workspace/VERSTAS.md, the goal, the tickets, and enough of each repository to know how it is built, tested and run. Check concretely, by running commands: required tools and versions, services the project needs (databases, browsers, SDKs) and whether they can be started here as processes, network hosts the build or tests will reach, disk and memory headroom, and anything the tickets assume that the sandbox forbids (Docker, root, GUI). Put every gap into ONE request (root_script actions for packages, network for hosts, instruction for things only the user can do, question only where a real decision is needed), and write your findings to /workspace/notes/preflight.md. Do not install anything yourself beyond what the agent user may. Your reply must start with exactly one of:
PREFLIGHT: ok
PREFLIGHT: blocked
followed by a short summary: what was checked, what is missing, which requests you filed. "ok" means work can start now with nothing missing; "blocked" means wait for the requests or for the user to change the plan.`,
    planner: `
Role: planner. Turn the session goal into tickets with \`board_create_ticket\`: small (S) or medium (M) where possible, each with a clear spec, acceptance criteria that a reviewer can check, the repository it touches, and dependencies by id when order matters. You may create feature tickets; keep them within the goal. Prefer ten good tickets over thirty vague ones. When the board already has tickets, add only what is missing and do not duplicate. Reply with a short summary of the plan and stop.`,
  };
  return common + "\n" + byRole[role];
};

const ticketBlock = (t: Ticket): string => `# ${t.id}: ${t.title}
Kind: ${t.kind} · Size: ${t.size} · Repo: ${t.repo ?? "(unspecified)"} · Attempt: ${t.attempts}

## Spec
${t.spec || "(none)"}

## Acceptance criteria
${t.acceptance.length ? t.acceptance.map((a) => `- [ ] ${a}`).join("\n") : "- (none given; use your judgement and say so in the report)"}

## Notes on this ticket
${t.notes.length ? t.notes.map((n) => `- (${n.by}, ${n.at.slice(0, 16)}) ${n.text}`).join("\n") : "- none"}
`;

const recentReports = (board: Board, excluding: string, n = 5): string => {
  const done = board.tickets
    .filter((t) => t.id !== excluding && t.report)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, n);
  if (!done.length) return "(no earlier reports yet)";
  return done.map((t) => `### ${t.id}: ${t.title} (${t.state})\n${t.report}`).join("\n\n");
};

/** The brief goes first in every prompt so the cached prefix is shared by all workers of a run. */
export const withBrief = (brief: string | null, prompt: string): string =>
  brief ? `# Project brief (notes/brief.md, written by the orientation worker; keep it true)\n${brief.trim()}\n\n---\n\n${prompt}` : prompt;

export const implementerPrompt = (board: Board, ticket: Ticket, answer?: string): string => `${ticketBlock(ticket)}
${answer ? `## The user answered your request\n${answer}\n` : ""}
## Recent reports from other workers
${recentReports(board, ticket.id)}

Start by reading /workspace/VERSTAS.md and /workspace/notes/INDEX.md. Then do the ticket. Finish with \`board_report\` and one line.`;

export const reviewerPrompt = (
  ticket: Ticket,
  diffStat: string,
  diff: string,
  gates: { name: string; ok: boolean; summary: string }[],
  implementer: { ok: boolean; stopReason: string } = { ok: true, stopReason: "success" },
): string => `${ticketBlock(ticket)}
## Implementer's report
${ticket.report ?? "(no report was filed)"}
${implementer.ok ? "" : `\nThe implementer did not finish cleanly (${implementer.stopReason}); judge what is there.\n`}
## Checks the harness ran (evidence, not a verdict)
The harness guessed these from the repository (npm scripts, pytest). A failure may come from this change, or from something the box or a later ticket provides (a browser, a service). Decide which; only a failure this ticket should have prevented makes it fixable.
${gates.map((g) => `- ${g.ok ? "ok" : "FAILED"} ${g.name}: ${g.summary}`).join("\n") || "- none found"}

## Diff (stat)
${diffStat || "(empty: no files changed. That is fine when the ticket's deliverable is a report, an investigation or a note; judge the report against the acceptance criteria.)"}

## Diff
\`\`\`diff
${diff.length > 60_000 ? diff.slice(0, 60_000) + "\n… (truncated; read the files for the rest)" : diff}
\`\`\`

Run the tests yourself if the gates did not. Reply starting with VERDICT: ok | fixable | blocked.`;

export const preflightPrompt = (session: Session, board: Board, answers: string[], mode: "check" | "brief"): string => `${mode === "brief" ? "# Brief only\nThe initialization check already passed, or was not asked for. Skip the PREFLIGHT verdict's consequences: still reply with a PREFLIGHT line, but your job now is the project brief in /workspace/notes/brief.md, refreshed against the repositories and the board as they are today.\n\n" : ""}# Session goal
${session.goal || "(no goal given)"}

# Repositories
${session.repos.map((r) => `- /workspace/${r.name} (branch ${r.branch})`).join("\n") || "- none"}

# Board
${board.tickets.length ? board.tickets.map((t) => `- ${t.id} [${t.state}] ${t.title} (${t.kind}, ${t.size}${t.repo ? `, ${t.repo}` : ""})${t.spec ? `: ${t.spec.replace(/\s+/g, " ").slice(0, 300)}` : ""}`).join("\n") : "- empty (the planner will draft tickets from the goal after you)"}
${answers.length ? `\n# Your earlier requests were answered\n${answers.map((a) => `- ${a}`).join("\n")}\n` : ""}
Check the box against this. Reply starting with PREFLIGHT: ok or PREFLIGHT: blocked.`;

export const plannerPrompt = (session: Session, board: Board): string => `# Session goal
${session.goal || "(no goal given; ask with a decision request)"}

# Repositories
${session.repos.map((r) => `- /workspace/${r.name}`).join("\n") || "- none"}

# Board today
${board.tickets.length ? board.tickets.map((t) => `- ${t.id} [${t.state}] ${t.title} (${t.kind}, ${t.size})`).join("\n") : "- empty"}

Read /workspace/VERSTAS.md, look at the repositories enough to plan well, then create the tickets. Reply with a short summary.`;

export const mcpConfig = (): object => ({
  mcpServers: { board: { command: "node", args: ["/opt/verstas/mcp-server.js"] } },
});

export const notesIndexMd = (): string => `# Notes index

Session-level memory, outside git. Keep this file short: one line per topic
file in this directory.

- brief.md: the project brief (purpose, layout, verified commands, conventions, traps, where to look). Read it first.
- learnings.md: short facts for future workers that do not fit the brief.
`;

/** Claude Code auto-reads this from the working directory, so every worker gets the pointers without prompt plumbing. */
export const workspaceClaudeMd = (): string => `# Workspace

You are inside a Verstas sandbox. Read, in this order:

1. /workspace/VERSTAS.md: what this box is and how to ask the user for things.
2. /workspace/notes/brief.md: the verified project brief, when it exists.
3. /workspace/notes/learnings.md: short facts from earlier workers.

Repositories live under /workspace/<name> and may carry their own CLAUDE.md.
`;

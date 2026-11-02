import { promises as fs } from "node:fs";
import path from "node:path";
import { verstasHome } from "../config.js";
import { attachmentLines, describeAgent, TICKET_SIZE_GUIDE, type Board, type Chore, type DriverName, type Planning, type Session, type SweepResult, type Ticket } from "../core/types.js";
import type { RepoChange } from "./judging.js";
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
- Attachments the user added${session.attachments.length ? `, with what the user said they are:\n${attachmentLines(session.attachments, "  ")}` : ": none."}
- Notes for future workers: \`/workspace/notes/\`. Read \`INDEX.md\` first;
  append what the next worker should know to \`learnings.md\`.
- The environment: \`/workspace/notes/env.md\` says what is installed, which
  services exist and how to start them. \`/workspace/notes/setup.sh\` is the
  recipe that rebuilds the box's system-level installs after the container
  is recreated. When you install something system-wide (sudo apt-get, sudo
  npm -g, a binary under /usr/local), append the command to setup.sh
  (idempotent) and a line to env.md, or the next box will not have it.${session.requirements.trim() ? `
- Setup instructions the box was set up with:
${session.requirements.trim().split("\n").map((l) => `  ${l}`).join("\n")}` : ""}
- The board (tickets and the chore list) is reachable only through the
  \`board_*\`, \`chore\`, \`chore_drop\`, \`chores_*\`, \`request\`, \`message\` and \`idea\` tools
  (MCP server "board"). The plain HTTP API behind them is ${agentApi} with
  your run token in \`VERSTAS_RUN_TOKEN\`.
- Network: only these hosts, over HTTPS, through the proxy already set in
  \`HTTPS_PROXY\`: ${session.allowlist.join(", ") || "(none)"}. Anything else
  is refused with 403. Ask with \`request\` kind \`pack\` for a whole toolchain
  or kind \`network\` for one host. Packs on: ${session.packs.join(", ") || "(none recorded)"}.
  Packs you can ask for: ${NETWORK_PACKS.filter((p) => p.name !== "anthropic" && !session.packs.includes(p.name)).map((p) => `\`${p.name}\` (${p.title})`).join(", ")}.
- Recipes the user chose ran when this container was created:
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
- Caps: ${session.caps.budgetUsd} USD per run${session.caps.leadMinutes || session.caps.leadTurns ? `; one lead life ends at ${[session.caps.leadMinutes ? `${session.caps.leadMinutes} minutes` : "", session.caps.leadTurns ? `${session.caps.leadTurns} turns` : ""].filter(Boolean).join(" or ")}, and a fresh lead continues from notes/state.md` : "; a lead life has no time or turn cap of its own"}.
  The reviewer has ${session.caps.workerMinutes} minutes and ${session.caps.workerTurns} turns per ticket.
- Commits: commit your own work, on the branch you are on, with the ticket
  id in the subject when the work is a ticket's ("T-12: …"); the reviewer
  reads the commits since the ticket entered in_progress that carry its id,
  plus the uncommitted working tree. Whatever is uncommitted when your life
  ends is committed by the harness, labelled with the tickets in progress.
  Do not rewrite history, do not create branches.
${verifyRule(session)}`;

/**
 * How work is verified, for VERSTAS.md: the harness runs no checks of its
 * own. An implementer runs the tests of what it changed; the reviewer runs
 * each changed repository's own check (the command the brief names).
 */
export const verifyRule = (session: Pick<Session, "repos" | "caps">): string => `- Verifying: the harness runs no checks of its own. ${
  session.caps.reviewer
    ? `A ticket you move to
  review goes to an independent reviewer, who runs each changed repository's
  own check (the command the brief names under Build / test / run, such as
  \`bash scripts/check.sh\` or \`npm test\`) and the commands the acceptance
  criteria name, then reads the diff. Work toward the goal outside tickets
  has no reviewer: nobody checks it but you.`
    : `This session has no
  reviewer: you move tickets to done yourself, and nobody checks your work
  but you.`
}
- Long commands (a build, a test suite, anything that takes minutes):
  either run them in the foreground with the Bash tool's timeout raised to
  what the command needs (up to 30 minutes), or, when you have other work
  to do meanwhile, run them in the background and END YOUR TURN: you are
  re-invoked with the result when the command finishes. Never \`sleep\` and
  poll: every sleep is a turn against your cap, and the log shows you as
  idle.
- The user may send you a message while you work; it arrives as a user
  message starting with "Message from the user:". Answer it briefly in
  text and carry on with your task; it neither widens the ticket nor ends
  your work, and the board is still changed only through the tools. One
  starting with "Message from Verstas:" is from the harness itself (a
  progress check, a pause); do what it says, then carry on.
`;

/** Where a lead's rules can be replaced without a rebuild: read for every new lead. */
export const leadRulesFile = (): string => path.join(verstasHome(), "prompts", "lead.md");

/** The lead's role rules: the override file when it exists and is not empty, else the built-in text. */
export const readLeadRules = async (file = leadRulesFile()): Promise<string | undefined> => {
  const text = await fs.readFile(file, "utf8").catch(() => "");
  return text.trim() ? `\nRole: lead.\n${text.trim()}` : undefined;
};

export const systemMd = (role: "reviewer" | "planner" | "setup" | "prompt" | "lead", roleRules?: string, planning?: Planning): string => {
  const common = `You are one worker in a long-running Verstas session. Read /workspace/VERSTAS.md first.

Rules that apply to every role:
- ${role === "lead" ? "Work the goal in your prompt and the board's tickets. Work you find that neither covers becomes a ticket (board_create_ticket), so the user sees it on the board." : "Work only on what the prompt gives you. Never widen the scope."}
- Nobody is watching while you work; the user reads the board, the commits and the log later. Fix what you can yourself: install missing tools with sudo (and append the command to /workspace/notes/setup.sh and a line to env.md), restart a service with svc, re-create a dummy config. The environment was set up before work started; if it broke, repair it rather than asking.
- Only for what you cannot do yourself (a host the proxy refuses, something only a person can do, a decision that is genuinely the user's), gather EVERYTHING into one \`request\` (summary + actions: pack or network for hosts, resources, instruction, question), then stop; do not work around the proxy. Questions are the exception, not the habit: when a sensible choice exists, make it, write the assumption in a note and the report, and continue; the user can overturn an assumption cheaply when they read the board and the commits, a parked ticket costs a night. Never ask for a secret value in an answer; ask them to place it in a file under /workspace and tell you the path.
- Work you notice but do not do now, by size: a small, self-contained fix (a nit, a rename, a missing guard, a doc line, a weak test name; a few dozen changed lines at most) is a \`chore\`: one line and where. An open chore that no longer applies or is not worth doing: \`chore_drop\` with the reason. A bug, anything a user would notice, or anything bigger is a ticket: \`board_create_ticket\`. Feature ideas: \`idea\`. Observations: \`message\`.
- ${role === "lead" ? "Commit your own work as VERSTAS.md says. Never touch files outside /workspace, never delete the .git directories." : "Never commit, never touch files outside /workspace, never delete the .git directories."}
- Read /workspace/notes/brief.md first when it exists: it is the verified map of the repositories. Keep it true: if you find a trap or a wrong command, fix the brief's line, and keep /workspace/notes/learnings.md for short facts that do not fit the brief.
- Use the \`halt\` tool only for a security problem, a contradiction that makes the goal impossible as written or invalidates several tickets, or a dependency that cannot be met.`;
  const byRole: Record<typeof role, string> = {
    reviewer: `
Role: reviewer. You did not write this change; the lead did, and may be working on other tickets in the same working tree meanwhile. Two passes, both required.
1. Acceptance: read the ticket and its criteria. Run each changed repository's own check yourself: the command the brief names under Build / test / run (\`bash scripts/check.sh\`, \`npm test\`, or its test, typecheck and lint scripts), in the foreground with the Bash timeout raised to what it needs; when the brief says other repositories build on a changed one, run their checks too. Then run the commands the criteria name and check each criterion. Nobody ran these before you: the harness runs no checks. Quote the last lines of each check in your verdict. A failure this change should have prevented makes the ticket fixable; a failure that was there before it (say so, and file a chore or a ticket for it) does not.
2. Code: read every hunk of the diff, not only the tests. Look for a test that mirrors the implementation or a threshold tuned until a fixture passes; user input that can throw, recurse or grow memory without bound; a loop that allocates or does string work per element where the design asks for a hot path; a contract document (a DESIGN or README the repository treats as its spec) that the change contradicts or should have updated; copied code where a call would do; a decision the ticket did not ask for and the report does not mention.
Name at least one concrete finding with file and line, or write "code pass: nothing found" and the number of hunks you read. A finding that does not block the ticket: a correctness bug or a user-visible effect becomes a ticket with \`board_create_ticket\`; anything smaller becomes a \`chore\` (one line and where; a lead sweeps chores in batches later). The verdict stays ok either way. Your reply must start with exactly one of:
VERDICT: ok
VERDICT: fixable
VERDICT: blocked
followed by your reasons in a few lines, the code pass included. "fixable" means another implementer attempt with your notes would likely finish it; "blocked" means the ticket as written cannot be done or the change is harmful. Add specific notes with \`board_add_note\`. Do not fix the code yourself.`,
    setup: `
Role: setup (the environment and the project brief). No ticket work.

This is the one phase where the user expects to be asked things. After it, workers run unattended, so anything you do not settle now costs a night later.

1. Make the box ready to develop the repositories: what they need to build, test and run today, plus the setup instructions the user gave. Nothing speculative: a package only one later ticket would need is that ticket's job. You have passwordless sudo. Install toolchains and system packages yourself (sudo apt-get install -y …, sudo npm install -g …), install project dependencies (npm ci, pip install …), start services with svc (svc start <name> --port N -- <command>), create local config with dummy values where the project needs it (never real secrets), and run the project's own build, test and dev commands until they work. Verify every requirement by running something, not by reading.
2. Record what you did, for the next box and the next worker:
   - /workspace/notes/setup.sh: an idempotent bash recipe of the system-level steps (the sudo installs, binaries under /usr/local), in order, safe to run twice, with \`# needs-hosts: …\` on its second line. It runs as the agent user (use sudo inside it) when the container is recreated. Project dependencies under /workspace and services under svc survive a recreate on their own; leave them out.
   - /workspace/notes/env.md: what is installed and where; each service, its svc name, port and how to start it; env files you created and what is dummy in them; the exact commands that build, test and run the project here, and how long they take.
   - /workspace/notes/brief.md: the project brief every later worker reads first. At most 1500 words, facts only, this structure:
     # Project brief
     ## <repo name>  (one section per repository)
     - Purpose, Layout, Build / test / run (verified commands), Conventions, Traps.
     ## Where to look for the board's tickets
     If a brief exists, update it rather than starting over.
3. The checks. The harness runs no checks of its own; the reviewer of every ticket runs each changed repository's check from the brief. So for each repository, the brief's Build / test / run line names the one command that says whether a change broke it (the repository's own script when it has one, \`bash scripts/check.sh\`, \`npm test\`; "nothing to run" for documentation, assets, data), how long it takes, and which other repositories build on it (their checks should run too when it changes). Run each command once, now, so it passes before any ticket runs; a check that fails today needs the environment fixed, or the brief says why it fails and what to run instead. Run it once only: nothing else will run it again before the tickets start.
4. What you cannot do yourself (a host the proxy refuses, a file or account only a person can provide, a decision that is genuinely the user's): put ALL of it in ONE request, then stop. Network: prefer kind \`pack\` for a toolchain's hosts.

Your reply must start with exactly one of:
SETUP: ready
SETUP: needs
then one line per requirement, as a checklist, in the user's words:
- [x] <requirement> (how you verified it)
- [ ] <requirement> (what is missing)
then a short summary. "ready" means every requirement is checked and work can start now. "needs" means something is missing; say what, and file the request.`,
    prompt: `
Role: the user's direct request. The user typed the task below on the session page; do exactly that. There is no ticket and no reviewer. You may install and configure (with sudo), start services, investigate, and update the notes (env.md, setup.sh, brief.md, learnings.md) when what you do changes what they say. Change repository files only if the request asks for it; the harness commits any repository change as one commit after you. Do not work on board tickets. End with a reply for the user, a few lines: what you did, what you found, anything they should decide.`,
    lead: `
Role: lead. You work this session: the goal in your prompt when it has one, and the board's tickets. Nobody picks work for you: you choose the order, how to cut the work, when to read and when to build, whether to use subagents, and which tickets are in progress at once. What is fixed is the contract with the board and the reviewer:

1. Tickets move with \`board_move\`: backlog, ready, in_progress, review, blocked, done. Move a ticket to in_progress before you change files for it; several may be in progress at once. Moving a ticket to review hands it to an independent reviewer (when the session has one): it runs the repositories' checks and reads the change, then the harness moves the ticket to done, or back to ready with the reviewer's notes, or to blocked. While the session has a reviewer only the harness moves a ticket to done; without one you move it to done yourself. \`board_move\` to review waits for the verdict and returns it.
2. Commit your own work with the ticket id in the subject ("T-12: …"). The reviewer reads the commits since the ticket entered in_progress that carry its id, plus the uncommitted working tree; a commit without an id is listed to it as unlabelled. File a report with \`board_report\` before review when the change does not speak for itself.
3. The board is yours: \`board_create_ticket\` (any kind; straight to ready or in_progress when you mean to do it now), \`board_update_ticket\`, \`board_delete_ticket\`, priorities and deps. Work you find and do not do now becomes a ticket, so the user sees it. Chores (\`chores_list\`) are small fixes filed by reviewers and workers: \`chores_sweep\` takes a batch, \`chores_submit\` ends it, and the batch becomes one commit after a size check and the reviewer's look.
4. /workspace/notes/state.md is your plan and progress note and the only memory that survives you. Keep it current. Watch your context with \`budget\`; when it has become noise, \`handoff\` with a note (what is in flight, what you tried, what you learned that is not in notes/ yet, what to do next) and stop. A fresh lead starts from that note, the notes directory, the goal and the board.
5. What only the user can give: one \`request\` with everything, naming the ticket it is about when it is a ticket's; that ticket parks until they answer and you carry on with other work. A request about the goal itself pauses the run once nothing else can go on.
6. \`done\` when every part of the goal holds (say how you verified each part) and no ticket is left that you can do; the run ends after you stop. Being out of ideas is a handoff with a note that says so, not \`done\`. When nothing you can start is left and the goal is as far as you can take it, reply with one line and stop.`,
    planner: `
Role: planner. Turn the user's planning request into tickets with \`board_create_ticket\`: ${planning?.ticketSize ? `sized for this session's target (below)` : "small (S) or medium (M) where possible"}, each with a clear spec, acceptance criteria that a reviewer can check, the repositories you expect it to touch (a hint for the user and the worker, not a limit; list every one), and dependencies by id when order matters. You may create feature tickets; keep them within the request. Set a ticket's \`agent\` only when the request asks for a particular agent or model for some of the work. Prefer ten good tickets over thirty vague ones. When the board already has tickets, add only what is missing and do not duplicate. Reply with a short summary of the plan and stop.${ticketSizeRule(planning)}`,
  };
  return common + "\n" + (role === "lead" && roleRules ? roleRules : byRole[role]);
};

/**
 * The session's ticket size and your guidance, for whoever writes tickets
 * (the planner, an agent terminal). Empty when the session sets neither, so
 * a session without them reads exactly as before.
 */
export const ticketSizeRule = (planning?: Planning): string => {
  const size = planning?.ticketSize;
  const guidance = planning?.guidance?.trim();
  if (!size && !guidance) return "";
  const lines = ["", "", "Ticket size for this session:"];
  if (size)
    lines.push(
      `- Aim for ${size}: ${TICKET_SIZE_GUIDE[size]}.`,
      "- Every ticket costs the same fixed overhead however small it is: a worker reads its way in, a reviewer runs the checks and reads the change, a commit is made. So fold small related changes (the same files, a chain of small steps, a feature and its follow-ups) into one ticket of this size rather than several smaller ones, and split only what a reviewer would judge separately.",
    );
  if (guidance) lines.push(`- How the user wants the work cut: ${guidance}`);
  return lines.join("\n");
};

const ticketBlock = (t: Ticket): string => `# ${t.id}: ${t.title}
Kind: ${t.kind} · Size: ${t.size} · Expected repos: ${t.repos.join(", ") || "(unspecified)"} · Attempt: ${t.attempts}${t.agent ? ` · Agent: ${describeAgent(t.agent)} (this ticket runs on its own agent)` : ""}

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

/** The brief and the environment go first in every prompt so the cached prefix is shared by all workers of a run. */
export const withContext = (brief: string | null, env: string | null, prompt: string): string =>
  [
    brief ? `# Project brief (notes/brief.md, written by the setup worker; keep it true)\n${brief.trim()}` : "",
    env ? `# Environment (notes/env.md: what is installed and how to run it here)\n${env.trim()}` : "",
    prompt,
  ]
    .filter(Boolean)
    .join("\n\n---\n\n");

/** What the reviewer is told about the change beyond the diff: why it reviews, how plan and change differ. */
export type ReviewContext = {
  why: string;
  /** "planned api; touched api, docs" when they differ. */
  planned?: string;
};

const DIFF_BUDGET = 60_000;

/** One section per changed repository, the diffs cut to a budget in order; a ticket's commits in the range are listed so the reviewer can `git show` them. */
const changeSections = (changes: readonly RepoChange[]): string[] => {
  let budget = DIFF_BUDGET;
  return changes.map((c) => {
    const body = c.diff.length > budget ? c.diff.slice(0, Math.max(0, budget)) + "\n… (truncated; read the files for the rest)" : c.diff;
    budget -= body.length;
    const commits = [
      c.commits.mine.length ? `This ticket's commits (in the diff): ${c.commits.mine.join("; ")}.` : "",
      c.commits.others.length ? `Other tickets' commits in the range (not in the diff): ${c.commits.others.join("; ")}.` : "",
      c.commits.unlabelled.length ? `Commits in the range that name no ticket (${c.commits.others.length ? "not in the diff; look at them" : "in the diff"}): ${c.commits.unlabelled.join("; ")}.` : "",
    ].filter(Boolean);
    return `### /workspace/${c.repo}: ${c.files} files, +${c.added} −${c.removed}
${commits.length ? `${commits.join("\n")}\n` : ""}${c.stat}

\`\`\`diff
${body}
\`\`\``;
  });
};

const CHECKS_REMINDER = "Nobody has run the repositories' checks on this change: run each changed repository's own check (the brief names it) and the commands the criteria name, then do the code pass over every hunk above (read the files when a diff is truncated).";

export const reviewerPrompt = (ticket: Ticket, changes: readonly RepoChange[], ctx: ReviewContext = { why: "" }): string => {
  const sections = changeSections(changes);
  return `${ticketBlock(ticket)}
## The lead's report
${ticket.report ?? "(no report was filed; the change and the commits speak for it)"}

${ctx.why ? `Why this change is reviewed: ${ctx.why}.\n` : ""}${ctx.planned ? `The ticket's expected repositories and the change differ (${ctx.planned}). The list was a guess; judge whether the change covers the ticket.\n` : ""}
## Changes, per repository
${sections.join("\n\n") || "(none: no files changed. That is fine when the ticket's deliverable is a report, an investigation or a note; judge the report against the acceptance criteria.)"}

${CHECKS_REMINDER} Reply starting with VERDICT: ok | fixable | blocked.`;
};

/**
 * A chore sweep for the reviewer: the chores the lead took stand in for the
 * ticket, its one line per chore for the report. Any verdict but ok refuses
 * the sweep (the chores reopen, the changes stay in the working tree).
 */
export const sweepReviewerPrompt = (sweep: { n: number }, chores: readonly Chore[], results: readonly SweepResult[], changes: readonly RepoChange[]): string => {
  const chore = (id: string) => chores.find((c) => c.id === id);
  const lines = results.map((r) => {
    const c = chore(r.id);
    return `- ${r.id} ${r.outcome}${r.note ? ` (${r.note.trim()})` : ""}: ${c?.text.split("\n")[0] ?? "(unknown chore)"}${c?.where ? ` [${c.where}]` : ""}`;
  });
  return `# Chore sweep ${sweep.n}
A lead took a batch of chores (small fixes filed by reviewers and workers) and did them in one go. There is no ticket: the chores are the acceptance criteria, and the lead's line per chore is the report. The whole batch becomes one commit when you accept it; any other verdict refuses the batch (the chores reopen and the changes stay in the working tree for the lead to redo, split into a ticket or revert).

## The chores and what the lead says it did
${lines.join("\n") || "- (no results)"}

## Changes, per repository
${changeSections(changes).join("\n\n") || "(none: no files changed.)"}

Judge: does each "done" chore do what it says and nothing more; is a "dropped" or "promoted" chore reasonably so; does the batch stay a batch of small fixes (no design change, no contract document, no fixture). ${CHECKS_REMINDER} Reply starting with VERDICT: ok | fixable | blocked.`;
};

export const setupPrompt = (session: Session, board: Board, answers: string[], mode: "setup" | "brief"): string => `${mode === "brief" ? "# Brief only\nRefresh /workspace/notes/brief.md (and env.md if it is out of date) against the repositories and the board as they are today. Install nothing unless a command you need to verify is missing. Still reply with a SETUP line.\n\n" : ""}# Set up the environment
Make this box a sensible place to develop the repositories below: their toolchains at the versions they pin, their dependencies installed from their lockfiles, the services their tests need, their own build and test commands verified by running them, and env.md written for the workers. Work out what is needed from the repositories and the board; do not implement any ticket, and do not install things only one later ticket would need.

# Setup instructions from the user
${session.requirements.trim() || "(none)"}

# Repositories
${session.repos.map((r) => `- /workspace/${r.name} (branch ${r.branch})`).join("\n") || "- none"}
${session.attachments.length ? `\n# Attachments (what the user said they are)\n${attachmentLines(session.attachments)}\n` : ""}
# Board
${board.tickets.length ? board.tickets.map((t) => `- ${t.id} [${t.state}] ${t.title} (${t.kind}, ${t.size}${t.repos.length ? `, ${t.repos.join(" ")}` : ""})${t.spec ? `: ${t.spec.replace(/\s+/g, " ").slice(0, 300)}` : ""}`).join("\n") : "- empty"}
${answers.length ? `\n# Your earlier setup requests were answered\n${answers.map((a) => `- ${a}`).join("\n")}\n` : ""}
Read /workspace/VERSTAS.md and the existing notes (env.md, setup.sh, brief.md) first; a previous setup worker may have done most of the work. Reply starting with SETUP: ready or SETUP: needs.`;

export const userPrompt = (text: string): string => `# Request from the user

${text.trim()}

Read /workspace/VERSTAS.md first if you have not. Reply with what you did and found.`;

/**
 * The rules for the agent in an agent terminal: Claude Code gets them as an
 * appended system prompt, Codex as its global AGENTS.md. Unlike every other
 * worker, it has the user at the keyboard.
 */
export const terminalMd = (session: Pick<Session, "planning">, driver: DriverName): string => `# Agent terminal

You are running in an interactive terminal inside a Verstas session's sandbox (${driver === "codex" ? "Codex" : "Claude Code"}). Unlike the other workers here, the user is at the keyboard: they type to you and read your answers now. Read /workspace/VERSTAS.md for the box (network, sudo, svc, notes). A few of its rules are written for unattended workers and are different here:

- Ask the user in this conversation when something is theirs to decide. There is no \`request\` or \`halt\` for you.
- No run is active while this terminal is open: no lead is changing the repositories or the board. Starting a run from the session page ends this terminal.
- The board is reachable through the MCP server "board": \`board_list_tickets\`, \`board_get_ticket\`, \`board_create_ticket\` (any kind, features included; it goes to the backlog for the user's approval, or straight to ready with \`state: "ready"\` when the user asks for that), \`board_update_ticket\` and \`board_delete_ticket\` (the user is here to say what goes), \`board_add_note\`, \`board_set_priority\`, \`board_add_dep\`, \`chore\`, \`chores_list\`, \`chore_drop\`, \`idea\` and \`message\`. To merge tickets, update the one that stays with the combined spec and every acceptance criterion of the others, then delete the others with \`replacedBy\` so tickets that depended on them follow. You cannot move tickets into progress or review: implementing a ticket belongs to a run, which has the lead and the reviewer.
- When you write tickets: look at the board first and do not duplicate. Each ticket gets a spec that names the files and the commands, acceptance criteria a reviewer can run, the repositories you expect it to touch (a hint; the worker may touch others), and dependencies by id only where order matters. Say what you created or changed, one line per ticket.${ticketSizeRule(session.planning)}
- Change repository files when the user asks you to. Do not commit, rewrite history or create branches: when this terminal ends, Verstas commits whatever changed in the repositories as one commit.
- Each repository's check is the command the brief names under Build / test / run; reviewers run it. When the user asks you to change one, change the brief's line.
- Keep /workspace/notes/ true for the workers that come after you, as every worker does.
- When the user asks to see a file (a screenshot, a report, a generated image), publish it with \`artifact\`: it appears under this terminal, to view or download. Do not publish artifacts they did not ask for.
`;

export const plannerPrompt = (session: Session, board: Board, goal: string): string => `# What to plan
${goal.trim() || "(nothing given; ask with a decision request)"}

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
- env.md: the environment: what is installed, services and how to start them, verified commands.
- setup.sh: the recipe that rebuilds system-level installs when the container is recreated.
- learnings.md: short facts for future workers that do not fit the brief.
`;

/** Claude Code auto-reads this from the working directory, so every worker gets the pointers without prompt plumbing. */
export const workspaceClaudeMd = (): string => `# Workspace

You are inside a Verstas sandbox. Read, in this order:

1. /workspace/VERSTAS.md: what this box is and how to ask the user for things.
2. /workspace/notes/brief.md: the verified project brief, when it exists.
3. /workspace/notes/env.md: what is installed and how to run it here.
4. /workspace/notes/learnings.md: short facts from earlier workers.

Repositories live under /workspace/<name> and may carry their own CLAUDE.md.
`;

const boardLines = (board: Board): string =>
  board.tickets.length
    ? board.tickets.map((t) => `- ${t.id} [${t.state}] ${t.title} (${t.kind}, ${t.size}${t.repos.length ? `, ${t.repos.join(" ")}` : ""}${t.deps.length ? `, after ${t.deps.join(" ")}` : ""}, priority ${t.priority}${t.agent ? `, agent ${describeAgent(t.agent)}: board_run, not claim` : ""})`).join("\n")
    : "- empty";

/** The chore list as a lead sees it: what a sweep may take, and what waits for the user. */
const choreLines = (board: Board, sweepAt?: number): string => {
  const open = board.chores.filter((c) => c.state === "open");
  const proposed = board.chores.filter((c) => c.state === "proposed").length;
  const sweeping = board.chores.filter((c) => c.state === "sweeping");
  const lines = [
    ...sweeping.map((c) => `- ${c.id} [in your sweep] ${c.text}${c.where ? ` (${c.where})` : ""}`),
    ...open.map((c) => `- ${c.id} ${c.text}${c.where ? ` (${c.where})` : ""}${c.fromTicket ? ` · from ${c.fromTicket}` : ""}`),
  ];
  const head = sweepAt ? `${open.length} open; the sweep line is ${sweepAt}${open.length >= sweepAt ? ": sweep (or drop) before the next ticket; claims are refused until the list is below it" : ""}\n` : "";
  if (!lines.length) return head + (proposed ? `- none open (${proposed} proposed, waiting for the user)` : "- none");
  return head + lines.join("\n") + (proposed ? `\n- (${proposed} more proposed, waiting for the user)` : "");
};

export type LeadPromptOptions = {
  /** The goal text, or empty when the board alone is the work. */
  goal: string;
  /** The life number within this run (1 for the first lead). */
  round: number;
  /** Tickets in progress: a previous lead started them and did not finish. */
  holds?: readonly Ticket[];
  /** The previous lead's handoff note (also in notes/state.md). */
  handoff?: string;
  /** The previous lead was stopped at a cap before it could update its note; its last words. */
  lastWords?: string;
  /** notes/state.md as it stands: the plan and progress note of the leads before this one. */
  stateNote?: string | null;
  /** The goal is not the one the notes were written for: revised while the session ran, or the next goal after an earlier one. */
  goalChange?: { kind: "revised" | "next"; at: string; previous: string; note?: string };
  /** A lead said this same goal was met and the user started again anyway. */
  metBefore?: { at: string; note: string };
  /** Recent commits per repository, newest first: what the earlier lives did, as git saw it. */
  history?: readonly { repo: string; log: string }[];
  /** Outcomes of requests the user decided, newest last. */
  answers?: readonly string[];
  /** Nothing to start; only chores remain: sweep them or stop. */
  onlyChores?: boolean;
  /** The session's `choreSweepAt` cap; 0 or undefined when off. */
  sweepAt?: number;
};

const sweepNote = (board: Board): string => {
  const sw = board.sweep;
  if (!sw || (sw.state !== "working" && sw.state !== "judging")) return "";
  return `## You hold sweep ${sw.n} (${sw.state})\nA previous lead took chores ${sw.ids.join(", ")} and did not submit. Their changes, if any, are in the working tree. Finish them and \`chores_submit\`, or submit with no results to release them.\n`;
};

const onlyChoresNote = (board: Board, onlyChores?: boolean): string =>
  onlyChores && board.chores.some((c) => c.state === "open") ? `\nNo ticket is ready. Only chores remain: sweep them (\`chores_sweep\`, do them, \`chores_submit\`), or reply with one line why not and stop.\n` : "";

const historyLines = (history: readonly { repo: string; log: string }[] | undefined): string =>
  history?.length ? history.map((h) => `### ${h.repo}\n${h.log.trim() || "(no commits since the clone)"}`).join("\n\n") : "(no repositories)";

const goalChangeNote = (c: LeadPromptOptions["goalChange"]): string =>
  !c
    ? ""
    : c.kind === "next"
      ? `## The previous goal was met${c.note ? ` (${c.at.slice(0, 16)}; the assessment: ${c.note.trim().slice(0, 1500)})` : ` at ${c.at.slice(0, 16)}`}
The goal above is the next one. The notes and the commits describe the work done for the previous goal:
${c.previous.trim().slice(0, 2000)}
Rewrite notes/state.md for the new goal before you build.
`
      : `## The goal was revised at ${c.at.slice(0, 16)}
The notes and the commits may aim at the earlier text:
${c.previous.trim().slice(0, 2000)}
Reconcile notes/state.md with the goal as it now reads before you continue.
`;

const holdsNote = (holds: readonly Ticket[] | undefined): string =>
  holds?.length
    ? `## In progress: ${holds.map((t) => t.id).join(", ")}\nA previous lead started ${holds.length === 1 ? "this ticket" : "these tickets"} and did not finish. ${holds.length === 1 ? "Its" : "Their"} changes, if any, are in the working tree and in the commits that carry ${holds.length === 1 ? "its id" : "their ids"}. Continue, or file a request on one that needs the user.\n\n${holds.map(ticketBlock).join("\n")}`
    : "";

const stateNoteBlock = (opts: LeadPromptOptions): string =>
  opts.handoff
    ? `## Note from the previous lead\n${opts.handoff.trim()}\n\n`
    : opts.stateNote?.trim()
      ? `## Your plan and progress note (notes/state.md)\n${opts.stateNote.trim()}\n\n`
      : "## Your plan and progress note (notes/state.md)\n(empty: you are the first lead here; write it as you start)\n\n";

/** A fresh lead: the goal, the board, what is in progress, the memory it inherits, and what changed since that memory was written. */
export const leadPrompt = (board: Board, opts: LeadPromptOptions): string => `# Work the session
Life ${opts.round} of this run.
${opts.goal ? `\n## Goal\n${opts.goal.trim()}\n` : "\n(No goal is written: the board is the work.)\n"}
${goalChangeNote(opts.goalChange)}${opts.metBefore ? `## A lead said this goal was met (${opts.metBefore.at.slice(0, 16)}) and the user started the run again without changing it\nThat means not yet. Its assessment:\n${opts.metBefore.note.trim().slice(0, 3000)}\nLook for what falls short of the goal as written, check each part by running it, and improve what you find; call done again only when you have made it better and every part holds.\n\n` : ""}${stateNoteBlock(opts)}${opts.lastWords ? `## The previous lead was stopped at a cap before it updated the note\nIts last words:\n${opts.lastWords.trim().slice(0, 3000)}\n\n` : ""}${holdsNote(opts.holds)}${sweepNote(board)}
## Board
${boardLines(board)}

## Chores (small fixes, swept in batches)
${choreLines(board, opts.sweepAt)}
${onlyChoresNote(board, opts.onlyChores)}
## Recent reports
${recentReports(board, "")}

## Recent commits (newest first)
${historyLines(opts.history)}
${opts.answers?.length ? `\n## Requests the user decided (newest last)\n${opts.answers.map((a) => `- ${a}`).join("\n")}\n` : ""}
Read /workspace/VERSTAS.md and /workspace/notes/INDEX.md if you have not. Then work: \`board_get_ticket\` for the full spec of a ticket, \`board_move\` to in_progress before changing files for it and to review when it is finished, \`chores_sweep\` and \`chores_submit\` for a batch of chores, \`handoff\` when your context has become noise, \`done\` when every part of the goal holds and the board is finished.`;

/** The lead continuing its own conversation: the life number, what the last life left in git, the board as it stands, and the goal only when it changed. */
export const leadContinuePrompt = (board: Board, opts: { round: number; committed: readonly string[]; holds?: readonly Ticket[]; goal?: string; goalChangedAt?: string; answers?: readonly string[]; onlyChores?: boolean; sweepAt?: number }): string => `# Continue
You are continuing in the same conversation; this is life ${opts.round} of this run. The harness committed what your last life left in ${opts.committed.length ? opts.committed.join(", ") : "no repository (nothing had changed)"}.
${opts.goal ? `\n## The goal was revised at ${(opts.goalChangedAt ?? "").slice(0, 16)}\nIt now reads:\n${opts.goal.trim()}\nReconcile notes/state.md with it before you continue.\n` : ""}${opts.answers?.length ? `\n## The user decided your requests\n${opts.answers.map((a) => `- ${a}`).join("\n")}\n` : ""}
## Board
${boardLines(board)}

Chores:
${choreLines(board, opts.sweepAt)}
${opts.holds?.length ? `\nIn progress: ${opts.holds.map((t) => `${t.id} (${t.state})`).join(", ")}.` : ""}${sweepNote(board) ? `\n${sweepNote(board)}` : ""}${onlyChoresNote(board, opts.onlyChores)}
Carry on: keep notes/state.md current, \`handoff\` when your context is noise, \`done\` when every part of the goal holds and the board is finished. When you reach a sensible point with nothing more you can start, reply with one line and stop.`;

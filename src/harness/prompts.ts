import { promises as fs } from "node:fs";
import path from "node:path";
import { verstasHome } from "../config.js";
import { attachmentLines, type Board, type DriverName, type Session, type Ticket } from "../core/types.js";
import type { RepoChange } from "./judging.js";
import { NETWORK_PACKS } from "../network/packs.js";

/**
 * Everything a worker reads before it starts. VERSTAS.md says where it is
 * and what the tools do; system.md names its role; prompt.md is the task.
 * All generated per job so they are always true for this run. The harness
 * tells the lead facts, not how to work: the lead decides that.
 */

export const verstasMd = (session: Session, agentApi: string): string => `# You are running inside Verstas

Verstas is a sandboxed workshop. Nobody is watching live; the user reads the
board, the commits and the log later. Facts about this box:

- Working directory: \`/workspace\`, the directory you and the user share.
  Your HOME is \`/home/agent\`, a volume of this session: caches and
  toolchains there survive a container recreate but are not in the
  workspace. The box is committed to an image when a run ends, so what you
  install system-wide is still there after a recreate.
- Repositories, fresh clones on branch \`verstas/${session.id}\`:
${session.repos.map((r) => `  - \`/workspace/${r.name}\` (from \`${r.branch}\`)`).join("\n") || "  - (none)"}
- Attachments the user added${session.attachments.length ? `, with what the user said they are:\n${attachmentLines(session.attachments, "  ")}` : ": none."}
- \`/workspace/notes/\` persists across lead lives and is shown to the user.
  \`notes/state.md\` is handed to the next lead when yours ends; the rest of
  the directory is yours to organize.
- The board is reachable only through the \`board_*\` tools (MCP server
  "board"), with \`request\`, \`message\`, \`idea\`, \`artifact\`, \`budget\`,
  \`handoff\` and \`done\`. The plain HTTP API behind them is ${agentApi} with
  your run token in \`VERSTAS_RUN_TOKEN\`.
- The user follows the work on the board: which tickets exist, their
  states and their notes are the progress report. \`message\` is for what
  the board cannot say.
- Network: only these hosts, over HTTPS, through the proxy already set in
  \`HTTPS_PROXY\`: ${session.allowlist.join(", ") || "(none)"}. Anything else
  is refused with 403. \`request\` kind \`pack\` asks for a whole toolchain's
  hosts, kind \`network\` for one host. Packs on: ${session.packs.join(", ") || "(none recorded)"}.
  Packs you can ask for: ${NETWORK_PACKS.filter((p) => p.name !== "anthropic" && !session.packs.includes(p.name)).map((p) => `\`${p.name}\` (${p.title})`).join(", ")}.
- Recipes the user chose ran when this container was created:
${session.setupScripts.length ? session.setupScripts.map((x) => `  - ${x.name}: ${x.note || x.description || "(no note)"}`).join("\n") : "  - (none)"}
- You have passwordless \`sudo\`; every sudo command is logged for the user.
  \`svc\` runs services so they get a name, a log and survive a container
  restart: \`svc start pg --port 5432 -- postgres -D /workspace/.pg\`, then
  \`svc status\`, \`svc logs pg\`, \`svc stop pg\`. There is no Docker.
- \`request\` reaches the user, who is away most of the time: a summary plus
  actions of kinds \`network\` / \`pack\` (hosts to allow), \`resources\`
  (memory), \`instruction\` (something only a person can do) and
  \`question\` (a decision). A ticket named in it parks until every action
  is decided; the outcomes are in the next prompt.
${capsFacts(session)}
- Commits are yours: commit on the branch you are on, with the ticket id in
  the subject when the work is a ticket's ("T-12: …"). Whatever is
  uncommitted when your life ends is committed by the harness, labelled
  with the tickets in progress. History is not rewritten and no branches are
  made; the user publishes the branch as a pull request.
${reviewFacts(session)}
- Long commands: a turn that ends with a command still running in the
  background is not the end of your life; you are re-invoked with the
  result when it finishes.
- A message from the user arrives in your conversation as "Message from the
  user: …"; one from the harness (a progress check, a pause) as "Message
  from Verstas: …".
`;

const capsFacts = (session: Pick<Session, "caps">): string => {
  const { leadMinutes, leadTurns } = session.caps;
  if (!leadMinutes && !leadTurns) return "- A lead life has no time or turn cap; it ends when you stop, hand off, or the user pauses.";
  const caps = [leadMinutes ? `${leadMinutes} minutes` : "", leadTurns ? `${leadTurns} turns` : ""].filter(Boolean).join(" or ");
  return `- A lead life ends at ${caps}; a fresh lead then continues from notes/state.md. \`budget\` shows where you stand.`;
};

/** The review contract, for VERSTAS.md: the one place where the harness, not the lead, moves a ticket. */
export const reviewFacts = (session: Pick<Session, "caps">): string =>
  session.caps.reviewer
    ? `- Review: a ticket you move to \`review\` goes to an independent reviewer,
  which reads the commits since the ticket entered \`in_progress\` that
  carry its id, plus the uncommitted working tree, and runs the
  repositories' checks. The harness then moves the ticket to \`done\`, back
  to \`ready\` with the reviewer's notes, or to \`blocked\`. Only the harness
  moves a ticket to \`done\`; every other move is yours (\`board_move\`). A
  ticket may carry its own review setting (\`review: none\` skips the
  reviewer). The harness runs no checks of its own.`
    : `- Review: this session has no reviewer. You move tickets to \`done\`
  yourself (\`board_move\`); a ticket may still ask for one
  (\`review: full\`). The harness runs no checks of its own.`;

/** Where the lead's rules can be replaced without a rebuild: read for every new lead. */
export const leadRulesFile = (): string => path.join(verstasHome(), "prompts", "lead.md");

/** Your own rules for the lead, when `~/.verstas/prompts/lead.md` exists and is not empty. */
export const readLeadRules = async (file = leadRulesFile()): Promise<string | undefined> => {
  const text = await fs.readFile(file, "utf8").catch(() => "");
  return text.trim() ? text.trim() : undefined;
};

/**
 * The system prompt per role. The lead gets its role and the facts, and
 * nothing about how to work unless `~/.verstas/prompts/lead.md` says so.
 * The reviewer is the exception you asked to keep: an independent reader
 * with a procedure and a verdict contract.
 */
export const systemMd = (role: "reviewer" | "prompt" | "lead", roleRules?: string): string => {
  const head = "You are a worker in a long-running Verstas session. Read /workspace/VERSTAS.md first: it says where you are and what the tools do.";
  const byRole: Record<typeof role, string> = {
    lead: `
Role: lead. You work this session: the goal in your prompt when it has one, and the board's tickets. The board is yours to move, create, edit and delete; how you work is yours to decide. The harness keeps you alive: it commits what you leave, continues your conversation or starts a fresh lead from notes/state.md, and judges a ticket you move to review. Call \`done\` when the work is done; \`handoff\` when you want a fresh lead to take over.${roleRules ? `\n\n${roleRules}` : ""}`,
    reviewer: `
Role: reviewer. You did not write this change; the lead did, and may be working on other tickets in the same working tree meanwhile. Never commit and change no repository file. Two passes, both required.
1. Acceptance: read the ticket and its criteria. Run each changed repository's own check yourself (its test, typecheck and lint scripts, or the command its README or notes name), in the foreground with the Bash timeout raised to what it needs; when other repositories build on a changed one, run their checks too. Then run the commands the criteria name and check each criterion. Nobody ran these before you: the harness runs no checks. Quote the last lines of each check in your verdict. A failure this change should have prevented makes the ticket fixable; a failure that was there before it (say so, and file a ticket for it) does not.
2. Code: read every hunk of the diff, not only the tests. Look for a test that mirrors the implementation or a threshold tuned until a fixture passes; user input that can throw, recurse or grow memory without bound; a loop that allocates or does string work per element where the design asks for a hot path; a contract document (a DESIGN or README the repository treats as its spec) that the change contradicts or should have updated; copied code where a call would do; a decision the ticket did not ask for and the report does not mention.
Name at least one concrete finding with file and line, or write "code pass: nothing found" and the number of hunks you read. A finding that does not block the ticket: a correctness bug or a user-visible effect becomes a ticket with \`board_create_ticket\`; anything smaller becomes a note on the ticket. The verdict stays ok either way. Your reply must start with exactly one of:
VERDICT: ok
VERDICT: fixable
VERDICT: blocked
followed by your reasons in a few lines, the code pass included. "fixable" means the lead can finish it with your notes; "blocked" means the ticket as written cannot be done or the change is harmful. Add specific notes with \`board_add_note\`. Do not fix the code yourself.`,
    prompt: `
Role: the user's direct request. The user typed the task below on the session page; do that. There is no ticket and no reviewer; any repository change becomes one commit after you. End with a reply for the user: what you did, what you found, anything they should decide.`,
  };
  return head + "\n" + byRole[role];
};

const ticketBlock = (t: Ticket): string => `# ${t.id}: ${t.title}
Kind: ${t.kind} · Expected repos: ${t.repos.join(", ") || "(unspecified)"}${t.review ? ` · Review: ${t.review}` : ""}

## Spec
${t.spec || "(none)"}

## Acceptance criteria
${t.acceptance.length ? t.acceptance.map((a) => `- [ ] ${a}`).join("\n") : "- (none given; use your judgement and say so)"}

## Notes on this ticket
${t.notes.length ? t.notes.map((n) => `- (${n.by}, ${n.at.slice(0, 16)}) ${n.text}`).join("\n") : "- none"}
`;

const recentReports = (board: Board, n = 5): string => {
  const done = board.tickets
    .filter((t) => t.report)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, n);
  if (!done.length) return "(no reports yet)";
  return done.map((t) => `### ${t.id}: ${t.title} (${t.state})\n${t.report}`).join("\n\n");
};

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

const CHECKS_REMINDER = "Nobody has run the repositories' checks on this change: run each changed repository's own check and the commands the criteria name, then do the code pass over every hunk above (read the files when a diff is truncated).";

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

export const userPrompt = (text: string): string => `# Request from the user

${text.trim()}

Read /workspace/VERSTAS.md first if you have not. Reply with what you did and found.`;

/**
 * The rules for the agent in an agent terminal: Claude Code gets them as an
 * appended system prompt, Codex as its global AGENTS.md. Unlike every other
 * worker, it has the user at the keyboard.
 */
export const terminalMd = (driver: DriverName): string => `# Agent terminal

You are running in an interactive terminal inside a Verstas session's sandbox (${driver === "codex" ? "Codex" : "Claude Code"}). Unlike the lead, the user is at the keyboard: they type to you and read your answers now. Read /workspace/VERSTAS.md for the box (network, sudo, svc, notes). What is different here:

- Ask the user in this conversation when something is theirs to decide. There is no \`request\` or \`halt\` for you.
- No run is active while this terminal is open: no lead is changing the repositories or the board. Starting a run from the session page ends this terminal.
- The board is reachable through the MCP server "board": \`board_list_tickets\`, \`board_get_ticket\`, \`board_create_ticket\` (any kind; it goes to the backlog unless the user asks for \`state: "ready"\`), \`board_update_ticket\`, \`board_delete_ticket\` (with \`replacedBy\` for a merge, so dependents follow), \`board_add_note\`, \`board_set_priority\`, \`board_add_dep\`, \`idea\` and \`message\`. You cannot move tickets into progress or review: implementing a ticket belongs to a run, which has the lead and the reviewer.
- Do not commit, rewrite history or create branches: when this terminal ends, Verstas commits whatever changed in the repositories as one commit.
- When the user asks to see a file (a screenshot, a report, a generated image), publish it with \`artifact\`: it appears under this terminal, to view or download.
`;

export const mcpConfig = (): object => ({
  mcpServers: { board: { command: "node", args: ["/opt/verstas/mcp-server.js"] } },
});

/** Claude Code auto-reads this from the working directory, so every worker gets the pointer without prompt plumbing. */
export const workspaceClaudeMd = (): string => `# Workspace

You are inside a Verstas sandbox. Read /workspace/VERSTAS.md: what this box is, what the tools do, and how to reach the user. Repositories live under /workspace/<name> and may carry their own CLAUDE.md; /workspace/notes/ is this session's memory.
`;

const boardLines = (board: Board): string =>
  board.tickets.length
    ? board.tickets.map((t) => `- ${t.id} [${t.state}] ${t.title} (${t.kind}${t.repos.length ? `, ${t.repos.join(" ")}` : ""}${t.deps.length ? `, after ${t.deps.join(" ")}` : ""}, priority ${t.priority}${t.review ? `, review ${t.review}` : ""})`).join("\n")
    : "- empty";

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
};

const historyLines = (history: readonly { repo: string; log: string }[] | undefined): string =>
  history?.length ? history.map((h) => `### ${h.repo}\n${h.log.trim() || "(no commits since the clone)"}`).join("\n\n") : "(no repositories)";

const goalChangeNote = (c: LeadPromptOptions["goalChange"]): string =>
  !c
    ? ""
    : c.kind === "next"
      ? `## The previous goal was met${c.note ? ` (${c.at.slice(0, 16)}; the assessment: ${c.note.trim().slice(0, 1500)})` : ` at ${c.at.slice(0, 16)}`}
The goal above is the next one. The notes and the commits describe the work done for the previous goal:
${c.previous.trim().slice(0, 2000)}
`
      : `## The goal was revised at ${c.at.slice(0, 16)}
The notes and the commits may aim at the earlier text:
${c.previous.trim().slice(0, 2000)}
`;

const holdsNote = (holds: readonly Ticket[] | undefined): string =>
  holds?.length
    ? `## In progress: ${holds.map((t) => t.id).join(", ")}\nA previous lead started ${holds.length === 1 ? "this ticket" : "these tickets"} and did not finish. ${holds.length === 1 ? "Its" : "Their"} changes, if any, are in the working tree and in the commits that carry ${holds.length === 1 ? "its id" : "their ids"}.\n\n${holds.map(ticketBlock).join("\n")}`
    : "";

const stateNoteBlock = (opts: LeadPromptOptions): string =>
  opts.handoff
    ? `## Note from the previous lead\n${opts.handoff.trim()}\n\n`
    : opts.stateNote?.trim()
      ? `## notes/state.md, as the leads before you left it\n${opts.stateNote.trim()}\n\n`
      : "## notes/state.md\n(empty: you are the first lead here)\n\n";

/** A fresh lead: the goal, the board, what is in progress, the memory it inherits, and what changed since that memory was written. */
export const leadPrompt = (board: Board, opts: LeadPromptOptions): string => `# The session
Lead life ${opts.round} of this run.
${opts.goal ? `\n## Goal\n${opts.goal.trim()}\n` : "\n(No goal is written: the board is the work.)\n"}
${goalChangeNote(opts.goalChange)}${opts.metBefore ? `## A lead said this goal was met (${opts.metBefore.at.slice(0, 16)}) and the user started the run again without changing it\nThat means not yet. Its assessment:\n${opts.metBefore.note.trim().slice(0, 3000)}\n\n` : ""}${stateNoteBlock(opts)}${opts.lastWords ? `## The previous lead was stopped at a cap before it updated the note\nIts last words:\n${opts.lastWords.trim().slice(0, 3000)}\n\n` : ""}${holdsNote(opts.holds)}
## Board
${boardLines(board)}

## Recent reports on tickets
${recentReports(board)}

## Recent commits (newest first)
${historyLines(opts.history)}
${opts.answers?.length ? `\n## Requests the user decided (newest last)\n${opts.answers.map((a) => `- ${a}`).join("\n")}\n` : ""}`;

/** The lead continuing its own conversation: the life number, what the last life left in git, the board as it stands, and the goal only when it changed. */
export const leadContinuePrompt = (board: Board, opts: { round: number; committed: readonly string[]; holds?: readonly Ticket[]; goal?: string; goalChangedAt?: string; answers?: readonly string[] }): string => `# Continue
You are continuing in the same conversation; this is lead life ${opts.round} of this run. The harness committed what your last life left in ${opts.committed.length ? opts.committed.join(", ") : "no repository (nothing had changed)"}.
${opts.goal ? `\n## The goal was revised at ${(opts.goalChangedAt ?? "").slice(0, 16)}\nIt now reads:\n${opts.goal.trim()}\n` : ""}${opts.answers?.length ? `\n## The user decided your requests\n${opts.answers.map((a) => `- ${a}`).join("\n")}\n` : ""}
## Board
${boardLines(board)}
${opts.holds?.length ? `\nIn progress: ${opts.holds.map((t) => `${t.id} (${t.state})`).join(", ")}.\n` : ""}`;

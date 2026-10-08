import { promises as fs } from "node:fs";
import path from "node:path";
import { verstasHome } from "../config.js";
import { attachmentLines, describeAgent, effectivePolicy, TICKET_SIZE_GUIDE, type Board, type DriverName, type GateResult, type Planning, type PolicyProposal, type RepoSpec, type Session, type Ticket } from "../core/types.js";
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
- Caps per worker: ${session.caps.workerMinutes} minutes, ${session.caps.workerTurns} turns, ${session.caps.budgetUsd} USD.
  The harness stops you at a cap; file your report early rather than late.
- Commits are made by the harness after you finish, one per ticket. Do not
  commit, do not rewrite history, do not create branches.
${checkRule(session)}`;

/** One repository's check and review, as the workers read it. */
export const policyLine = (r: RepoSpec): string => {
  const p = effectivePolicy(r);
  const src = (f: "check" | "review") => {
    const by = r.agentPolicy?.setBy[f];
    return by ? ` (set by ${by.by}${by.ticket ? ` on ${by.ticket}` : ""}: ${by.reason})` : "";
  };
  const check =
    p.check.kind === "command"
      ? `check \`${p.check.command}\`${p.checkFrom === "you" ? " (set by the user)" : src("check")}`
      : p.check.kind === "none"
        ? `no check${p.checkFrom === "you" ? " (set by the user)" : src("check")}`
        : "no check set yet (the harness guesses: npm typecheck, lint and test, or pytest; evidence for the reviewer, not a verdict)";
  const review = p.review ? `review ${p.review}${r.review ? " (set by the user)" : src("review")}` : "review: the session's setting";
  return `/workspace/${r.name}: ${check}; ${review}${p.alsoCheck.length ? `; a change here also runs the checks of ${p.alsoCheck.join(", ")}` : ""}`;
};

/** The repositories' checks for VERSTAS.md: the harness runs them at submission, so workers need not run the whole thing and wait. */
export const checkRule = (session: Pick<Session, "repos">): string => {
  if (!session.repos.length) return "";
  return `- Checks: when a ticket is submitted (and when a chore sweep is), the harness
  finds every repository the change touched, whatever the ticket's expected
  repositories say, and runs the checks of those repositories once, one
  after another; a repository nobody changed is not checked. Per repository:
${session.repos.map((r) => `  - ${policyLine(r)}`).join("\n")}
  A failed check command comes back to you with the log's last lines,
  before any reviewer; a flaky failure is retried once. So do not run a
  whole check yourself and never \`sleep\` waiting on one: run the tests
  of the code you changed (a filtered test run, the one spec), then submit.
  The logs are under /workspace/.verstas/logs/. When your ticket changes
  what a repository's check should be (a new test runner, package or lint),
  propose it with \`repo_policy_propose\`: it is tried on your change and
  applied when the ticket is accepted. A change to a check's own files (its
  script, the package scripts, test config) always gets a reviewer.
`;
};

/** Where a lead's rules can be replaced without a rebuild: read for every new lead. */
export const leadRulesFile = (): string => path.join(verstasHome(), "prompts", "lead.md");

/** The lead's role rules: the override file when it exists and is not empty, else the built-in text. */
export const readLeadRules = async (file = leadRulesFile()): Promise<string | undefined> => {
  const text = await fs.readFile(file, "utf8").catch(() => "");
  return text.trim() ? `\nRole: lead.\n${text.trim()}` : undefined;
};

export const systemMd = (role: "implementer" | "reviewer" | "planner" | "setup" | "prompt" | "lead", leadRules?: string, planning?: Planning): string => {
  const common = `You are one worker in a long-running Verstas session. Read /workspace/VERSTAS.md first.

Rules that apply to every role:
- ${role === "lead" ? "Work the board's tickets. Work you find that the board lacks becomes a ticket (board_create_ticket), not a silent addition to the ticket you hold." : "Work only on what the prompt gives you. Never widen the scope."}
- Nobody is watching while you work; the user reads the board later. Fix what you can yourself: install missing tools with sudo (and append the command to /workspace/notes/setup.sh and a line to env.md), restart a service with svc, re-create a dummy config. The environment was set up before work started; if it broke, repair it rather than asking.
- Only for what you cannot do yourself (a host the proxy refuses, something only a person can do, a decision that is genuinely the user's), gather EVERYTHING into one \`request\` (summary + actions: pack or network for hosts, resources, instruction, question), then stop; do not work around the proxy. Questions are the exception, not the habit: when a sensible choice exists, make it, write the assumption in a note and the report, and continue; a reviewer can overturn an assumption cheaply, a parked ticket costs a night. Never ask for a secret value in an answer; ask them to place it in a file under /workspace and tell you the path.
- Work you notice but must not do now, by size: a small, self-contained fix (a nit, a rename, a missing guard, a doc line, a weak test name; a few dozen changed lines at most) is a \`chore\`: one line and where. An open chore that no longer applies or is not worth doing: \`chore_drop\` with the reason. A bug, anything a user would notice, or anything bigger is a ticket: \`board_create_ticket\` (kinds bug, followup, chore). Feature ideas: \`idea\`. Observations: \`message\`.
- Never commit, never touch files outside /workspace, never delete the .git directories.
- Read /workspace/notes/brief.md first when it exists: it is the verified map of the repositories. Keep it true: if you find a trap or a wrong command, fix the brief's line, and keep /workspace/notes/learnings.md for short facts that do not fit the brief.
- Use the \`halt\` tool only for a security problem, a contradiction that invalidates several tickets, or a dependency that cannot be met.`;
  const byRole: Record<typeof role, string> = {
    implementer: `
Role: implementer. Definition of done for your ticket:
1. The change is made in the repositories under /workspace it needs. The ticket's expected repositories are the planner's guess: touch another one, or fewer, when the work calls for it, and say so in the report.
2. Tests for the change exist and pass; typecheck and lint are clean where the repository has them.
3. Documentation the change affects is updated.
4. You filed a report with \`board_report\`: what you did, where, how you verified it, what is left. Five to fifteen lines.
5. You left notes for the next worker, who starts with a fresh context and knows only what is written down: a trap, a command, a decision, a slow test goes into /workspace/notes/learnings.md (one line each); a wrong line in brief.md or env.md gets fixed.
Then reply with one line and stop. If you cannot finish within the caps, file the report with what is done and what is left; the harness will requeue the ticket if the reviewer thinks it is fixable.`,
    reviewer: `
Role: reviewer. You did not write this change. Two passes, both required.
1. Acceptance: read the ticket and its criteria, run the tests and the commands the criteria name yourself, and check each criterion.
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
3. The checks. For each repository, decide how a change to it is judged and record it with \`repo_policy_set\` (one call per repository, a one-line reason per field). The user never has to: you are the one who has just made the build and the tests work.
   - \`check\`: one bash command, run in the repository's clone, that says whether a change broke it: the test suite plus typecheck and lint where the repository has them, as fast as it can be while still covering the code. Name the repository's own script when it has one (\`bash scripts/check.sh\`, \`npm test\`). \`null\` for a repository with nothing to run (documentation, assets, data). The harness runs a command before accepting it and refuses one that fails today: fix the environment, or choose a narrower command and say why.
   - \`review\`: \`full\` (a reviewer reads every change; the default for code), \`checks\` (the check decides alone), or \`none\` (accepted when the worker finishes; only for a repository where a wrong change costs nothing, such as scratch notes). Documentation an agent or a user acts on is not "none".
   - \`alsoCheck\`: the repositories that build on this one (a shared library's consumers), whose checks should also run when it changes.
   - \`guardPaths\`: globs of the check's own files beyond the command's script (test config, lint config, CI scripts); a change to them always gets a reviewer.
   A field the user has set is theirs and is refused; leave it. When the policy is already set and still right, leave it too.
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
Role: lead. You work this session's board until nothing you can start is left. Nobody picks tickets for you: you choose the order, decide when to read and when to build, and may use subagents for research or for independent parts of a ticket. What is fixed is the contract with the board:

1. Claim a ticket with \`board_claim\` before you change files for it. You hold one ticket at a time; the repositories have one working tree, and each ticket becomes one commit. A ticket that names its own agent (\`agent\` on the board line) is not yours to implement: when you hold nothing, \`board_run\` it; a fresh worker on that agent does it in the working tree, the reviewer judges it, and you get the verdict. Pick its moment like any other ticket's.
2. When its work is finished (the change made, tests for it passing, the docs it affects updated), file the report with \`board_report\` and submit it with \`board_submit\`. The harness runs the checks and an independent reviewer, commits, and moves it to done, or back to ready with the reviewer's notes, or to blocked. You never mark a ticket done yourself. Read the verdict: fix and resubmit, or leave the ticket and come back to it later.
3. A ticket that needs something only the user can give: one \`request\` with everything, while you hold it. The ticket parks and you are free to claim the next one.
4. Keep notes/ true for whoever comes after you, as every worker does: traps and commands in learnings.md, a wrong line in brief.md or env.md fixed. When a repository's check (VERSTAS.md) is broken through no ticket's fault (a flaky suite, a service gone, far too slow), fix it between tickets with \`repo_policy_set\`; the user is told. A ticket that changes what a check should be proposes it with \`repo_policy_propose\` while you hold it.
5. Watch your context with \`budget\`. When it has become noise (the session has moved on from what you first read, you keep re-reading the same files, or the context is large), finish or park what you hold if you can, then \`handoff\` with a note: what is in flight, what you tried, what you learned that is not in notes/ yet, what to do next. A fresh lead starts from that note.
6. Chores: the board also keeps a list of small fixes filed by reviewers, workers and the user (\`chores_list\`). The list has a sweep line (shown with it): at or above it you sweep before the next ticket, and \`board_claim\` and \`board_run\` are refused until the list is below it again. Sweep earlier when you are in those files anyway or when no ticket you can start is left: \`chores_sweep\` takes a batch (hold no ticket at that moment), you do each one, run the repository's own checks, then \`chores_submit\` with one line per chore: done, dropped with the reason, or promoted when it is bigger than a chore (a backlog ticket is made from your note). A chore that is moot or not worth its change is dropped (\`chore_drop\`, or dropped in the sweep), not carried along. The harness runs the checks and a size check and commits the batch as one commit; there is no reviewer, so a sweep may not touch the project's contract documents or fixtures, and over the size limits it is refused with the reason while the changes stay in the working tree (claim a ticket for them, or revert).
7. When no ticket you can start is left and no chore is open (everything is done, waiting on the user, or blocked), reply with one line saying so and stop.`,
    planner: `
Role: planner. Turn the user's planning request into tickets with \`board_create_ticket\`: ${planning?.ticketSize ? `sized for this session's target (below)` : "small (S) or medium (M) where possible"}, each with a clear spec, acceptance criteria that a reviewer can check, the repositories you expect it to touch (a hint for the user and the worker, not a limit; list every one), and dependencies by id when order matters. You may create feature tickets; keep them within the request. Set a ticket's \`agent\` only when the request asks for a particular agent or model for some of the work. Prefer ten good tickets over thirty vague ones. When the board already has tickets, add only what is missing and do not duplicate. Reply with a short summary of the plan and stop.${ticketSizeRule(planning)}`,
  };
  return common + "\n" + (role === "lead" && leadRules ? leadRules : byRole[role]);
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
      "- Every ticket costs the same fixed overhead however small it is: a worker reads its way in, the harness runs the check, a reviewer reads the change, a commit is made. So fold small related changes (the same files, a chain of small steps, a feature and its follow-ups) into one ticket of this size rather than several smaller ones, and split only what a reviewer would judge separately.",
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

export const implementerPrompt = (board: Board, ticket: Ticket, answer?: string, continuing = false): string =>
  continuing
    ? `# Next ticket
You are continuing in the same conversation: what you learned about the repositories and the box still holds, so do not re-read what you already know. The harness has taken the previous ticket from you (judged, parked or requeued) and committed what there was. Check the board or the files only where this ticket needs something new.

${ticketBlock(ticket)}
${answer ? `## The user answered your request\n${answer}\n` : ""}
Do the ticket. Finish with \`board_report\` and one line.`
    : `${ticketBlock(ticket)}
${answer ? `## The user answered your request\n${answer}\n` : ""}
## Recent reports from other workers
${recentReports(board, ticket.id)}

Start by reading /workspace/VERSTAS.md and /workspace/notes/INDEX.md. Then do the ticket. Finish with \`board_report\` and one line.`;

/** What the reviewer is told about the change beyond the diff: why it reviews, how plan and change differ, proposed policy changes. */
export type ReviewContext = {
  why: string;
  /** "planned api; touched api, docs" when they differ. */
  planned?: string;
  proposals: readonly PolicyProposal[];
  guarded: readonly string[];
  /** Repositories whose own setting needs no review: shown last, as context, and cut first. */
  context: readonly string[];
};

const DIFF_BUDGET = 60_000;

export const reviewerPrompt = (
  ticket: Ticket,
  changes: readonly RepoChange[],
  gates: GateResult[],
  implementer: { ok: boolean; stopReason: string } = { ok: true, stopReason: "success" },
  ctx: ReviewContext = { why: "", proposals: [], guarded: [], context: [] },
): string => {
  const ordered = [...changes.filter((c) => !ctx.context.includes(c.repo)), ...changes.filter((c) => ctx.context.includes(c.repo))];
  let budget = DIFF_BUDGET;
  const sections = ordered.map((c) => {
    const body = c.diff.length > budget ? c.diff.slice(0, Math.max(0, budget)) + "\n… (truncated; read the files for the rest)" : c.diff;
    budget -= body.length;
    return `### /workspace/${c.repo}: ${c.files} files, +${c.added} −${c.removed}${ctx.context.includes(c.repo) ? " (context: this repository's changes need no review of their own; check they agree with the rest)" : ""}
${c.scattered.length ? `Earlier attempts of this ticket were committed before other work and are not in this diff: ${c.scattered.join(", ")} (\`git show\` them).\n` : ""}${c.stat}

\`\`\`diff
${body}
\`\`\``;
  });
  return `${ticketBlock(ticket)}
## Implementer's report
${ticket.report ?? "(no report was filed)"}
${implementer.ok ? "" : `\nThe implementer did not finish cleanly (${implementer.stopReason}); judge what is there.\n`}
${ctx.why ? `Why this change is reviewed: ${ctx.why}.\n` : ""}${ctx.planned ? `The ticket's expected repositories and the change differ (${ctx.planned}). The list was a guess; judge whether the change covers the ticket.\n` : ""}${ctx.guarded.length ? `The change touches the check's own files (${ctx.guarded.join(", ")}): make sure it does not weaken the check to pass.\n` : ""}${ctx.proposals.length ? `\n## Proposed check policy changes (applied if you accept)\n${ctx.proposals.map((p) => `- ${p.repo}: ${JSON.stringify(p.patch)}: ${p.reason}`).join("\n")}\nJudge them like code: a check that runs less than before needs a good reason.\n` : ""}
${checkSection(gates)}
## Changes, per repository
${sections.join("\n\n") || "(none: no files changed. That is fine when the ticket's deliverable is a report, an investigation or a note; judge the report against the acceptance criteria.)"}

${gates.some((g) => g.check) ? "Do not run the checks above again; run only what the criteria name and the tests of the changed code." : "Run the tests yourself if the gates did not."} Do the code pass over every hunk above (read the files when a diff is truncated). Reply starting with VERDICT: ok | fixable | blocked.`;
};

const gateWhere = (g: GateResult) => (g.repo ? `${g.repo}: ` : "");

/** What the reviewer is told about the checks: the repositories' own checks, which passed (a failed one never reaches a reviewer), and the harness's guesses. */
const checkSection = (gates: GateResult[]): string => {
  const own = gates.filter((g) => g.check);
  const guessed = gates.filter((g) => !g.check);
  const parts: string[] = [];
  if (own.length)
    parts.push(`## The repositories' checks (run by the harness, passed)
${own.map((g) => `- \`${g.command}\` in ${g.repo ?? g.name.replace(/^check /, "")}: ${g.summary} (log: ${g.log})`).join("\n")}
These are the projects' own checks and they passed on this change. Do not run them again: that costs minutes and tells you nothing new. Read a log if you need detail, and run only the commands the acceptance criteria name and the tests of the code this change touches.
`);
  if (guessed.length || !own.length)
    parts.push(`## Checks the harness ran (evidence, not a verdict)
The harness guessed these from the repositories (npm scripts, pytest). A failure may come from this change, or from something the box or a later ticket provides (a browser, a service). Decide which; only a failure this ticket should have prevented makes it fixable.
${guessed.map((g) => `- ${g.ok ? "ok" : "FAILED"} ${gateWhere(g)}${g.name}: ${g.summary}`).join("\n") || "- none found"}
`);
  return parts.join("\n");
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
- No run is active while this terminal is open: no worker or lead is changing the repositories or the board. Starting a run from the session page ends this terminal.
- The board is reachable through the MCP server "board": \`board_list_tickets\`, \`board_get_ticket\`, \`board_create_ticket\` (any kind, features included; it goes to the backlog for the user's approval, or straight to ready with \`state: "ready"\` when the user asks for that), \`board_update_ticket\` and \`board_delete_ticket\` (which only you, of all the agents, have: the user is here to say what goes), \`board_add_note\`, \`board_set_priority\`, \`board_add_dep\`, \`chore\`, \`chores_list\`, \`chore_drop\`, \`idea\` and \`message\`. To merge tickets, update the one that stays with the combined spec and every acceptance criterion of the others, then delete the others with \`replacedBy\` so tickets that depended on them follow. You cannot claim or submit tickets: implementing a ticket belongs to a run, which has the check and the reviewer.
- When you write tickets: look at the board first and do not duplicate. Each ticket gets a spec that names the files and the commands, acceptance criteria a reviewer can run, the repositories you expect it to touch (a hint; the worker may touch others), and dependencies by id only where order matters. Say what you created or changed, one line per ticket.${ticketSizeRule(session.planning)}
- Change repository files when the user asks you to. Do not commit, rewrite history or create branches: when this terminal ends, Verstas commits whatever changed in the repositories as one commit.
- Each repository's check and review (VERSTAS.md) are kept by the agents. When the user asks you to change one, use \`repo_policy_set\`; the harness tries a new check command before accepting it. A field the user set in the app is theirs and is refused.
- Keep /workspace/notes/ true for the workers that come after you, as every worker does.
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

type LeadPromptOptions = {
  holds?: Ticket;
  handoff?: string;
  /** Nothing to claim; only chores remain: sweep them or stop. */
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
  onlyChores && board.chores.some((c) => c.state === "open") ? `\nNo ticket can be claimed. Only chores remain: sweep them (\`chores_sweep\`, do them, \`chores_submit\`), or reply with one line why not and stop.\n` : "";

/** A fresh lead: the board, what it holds, and the previous lead's note. */
export const leadPrompt = (board: Board, opts: LeadPromptOptions = {}): string => `# Work the board
${board.goal ? `Goal: ${board.goal}\n` : ""}
${opts.handoff ? `## Note from the previous lead\n${opts.handoff.trim()}\n` : ""}
${opts.holds ? `## You hold ${opts.holds.id} (${opts.holds.state})\nA previous lead claimed it and did not finish. Its changes, if any, are in the working tree. Continue it, or file a request on it if it needs the user.\n\n${ticketBlock(opts.holds)}` : ""}${sweepNote(board)}
## Board
${boardLines(board)}

## Chores (small fixes, swept in batches without a reviewer)
${choreLines(board, opts.sweepAt)}
${onlyChoresNote(board, opts.onlyChores)}
## Recent reports
${recentReports(board, opts.holds?.id ?? "")}

Read /workspace/VERSTAS.md and /workspace/notes/INDEX.md if you have not. Then work: \`board_get_ticket\` for the full spec of a ticket, \`board_claim\` before changing files, \`board_submit\` when it is finished; \`chores_sweep\` and \`chores_submit\` for a batch of chores.`;

/** A lead continuing its own conversation: only what changed. */
export const leadContinuePrompt = (board: Board, holds?: Ticket, opts: { onlyChores?: boolean; sweepAt?: number } = {}): string => `# Continue
You are continuing in the same conversation. The board as it stands now:

${boardLines(board)}

Chores:
${choreLines(board, opts.sweepAt)}
${holds ? `\nYou still hold ${holds.id} (${holds.state}).` : ""}${sweepNote(board) ? `\n${sweepNote(board)}` : ""}${onlyChoresNote(board, opts.onlyChores)}
Carry on with the board. When nothing you can start is left and no chore is open, reply with one line and stop.`;

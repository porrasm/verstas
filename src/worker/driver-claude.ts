/**
 * Claude Code: `claude -p` with the board MCP server attached, the rules as
 * an appended system prompt, stream-json in and out. The reference driver.
 *
 * Streaming input (`--input-format stream-json`) keeps the session alive
 * between turns: a background command (Bash with run_in_background) that
 * finishes after the turn re-invokes the model, so the agent never has to
 * sleep-poll, and a message from the user can be written mid-run. The
 * worker closes stdin when a turn ended with nothing running.
 */
import type { DriverImpl, Job } from "./driver.js";
import { translateLine } from "./translate.js";


/** Bash tool limits for workers: a check script may take ten minutes, and the worker is told to wait in the foreground. */
export const BASH_DEFAULT_TIMEOUT_MS = 10 * 60_000;
export const BASH_MAX_TIMEOUT_MS = 30 * 60_000;

/** One user message on the agent's stdin. */
export const userMessageLine = (text: string): string => JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n";

export const claudeArgs = (job: Job): string[] => [
  "-p",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--permission-mode",
  "bypassPermissions",
  "--mcp-config",
  job.mcpConfigFile,
  "--strict-mcp-config",
  "--max-budget-usd",
  String(job.caps.budgetUsd),
  ...(job.agentSession ? [job.agentSession.resume ? "--resume" : "--session-id", job.agentSession.id] : ["--no-session-persistence"]),
  "--append-system-prompt",
  "@SYSTEM@", // replaced with the file's text at spawn time
  ...(job.model ? ["--model", job.model] : []),
];

export const claudeDriver: DriverImpl = {
  name: "claude",
  binaries: ["claude"],
  async prepare(job, prompt, system, bin) {
    return {
      bin,
      args: claudeArgs(job).map((a) => (a === "@SYSTEM@" ? system : a)),
      // A build or a test suite takes minutes; with the stock 2-minute foreground limit the agent backgrounds it and sleep-polls, which costs turns and looks stuck.
      env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", BASH_DEFAULT_TIMEOUT_MS: String(BASH_DEFAULT_TIMEOUT_MS), BASH_MAX_TIMEOUT_MS: String(BASH_MAX_TIMEOUT_MS) },
      cwd: job.cwd ?? "/workspace",
      stdin: userMessageLine(prompt),
      streaming: true,
    };
  },
  message: userMessageLine,
  translator(job) {
    const ctx = { ticket: job.ticket, role: job.role, maxLen: job.debug ? 6000 : undefined };
    return { line: (l) => translateLine(l, ctx), end: () => undefined };
  },
  stderrRateLimit: /rate.?limit|\b429\b/i,
};

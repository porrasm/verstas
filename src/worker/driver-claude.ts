/**
 * Claude Code: `claude -p` with the board MCP server attached, the rules as
 * an appended system prompt, and stream-json out. The reference driver.
 */
import type { DriverImpl, Job } from "./driver.js";
import { translateLine } from "./translate.js";


/** Bash tool limits for workers: a check script may take ten minutes, and the worker is told to wait in the foreground. */
export const BASH_DEFAULT_TIMEOUT_MS = 10 * 60_000;
export const BASH_MAX_TIMEOUT_MS = 30 * 60_000;

export const claudeArgs = (job: Job): string[] => [
  "-p",
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
      stdin: prompt,
    };
  },
  translator(job) {
    const ctx = { ticket: job.ticket, role: job.role, maxLen: job.debug ? 6000 : undefined };
    return { line: (l) => translateLine(l, ctx), end: () => undefined };
  },
  stderrRateLimit: /rate.?limit|\b429\b/i,
};

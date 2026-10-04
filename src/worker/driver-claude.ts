/**
 * Claude Code: `claude -p` with the board MCP server attached, the rules as
 * an appended system prompt, and stream-json out. The reference driver.
 */
import type { DriverImpl, Job } from "./driver.js";
import { translateLine } from "./translate.js";


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
  "--no-session-persistence",
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
      env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
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

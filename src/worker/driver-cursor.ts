/**
 * Cursor CLI: `agent -p --output-format stream-json --force`.
 *
 * Authentication is CURSOR_API_KEY in the worker's environment (a Cursor
 * user API key, which draws on the Cursor plan). No system-prompt flag, so
 * the rules are prepended to the task. Cursor reads AGENTS.md from the
 * working directory.
 *
 * MCP: Cursor loads servers from a project's .cursor/mcp.json only after an
 * interactive approval, which a headless worker can never give (seen live:
 * the board namespace was missing). Servers in the user-level
 * ~/.cursor/mcp.json load without approval, so the driver writes the board
 * server there for the run, with the env the server needs, and puts the
 * previous file back when the agent exits. The home is the session's own
 * volume and the run token in that file dies with the run.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { combinedPrompt, type DriverImpl, type Job } from "./driver.js";
import { createCursorTranslator } from "./translate-cursor.js";

const MCP_ENV = ["VERSTAS_AGENT_API", "VERSTAS_RUN_TOKEN", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"];

export const cursorArgs = (job: Job, prompt: string): string[] => ["-p", "--output-format", "stream-json", "--force", ...(job.model ? ["--model", job.model] : []), prompt];

type McpConfig = { mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }> };

/** The user-level MCP config for a run: the job's servers, each given the env the board server needs. */
export const cursorMcpConfig = (mcp: McpConfig, env: NodeJS.ProcessEnv): McpConfig => ({
  mcpServers: Object.fromEntries(
    Object.entries(mcp.mcpServers ?? {}).map(([name, s]) => [name, { ...s, env: { ...Object.fromEntries(MCP_ENV.filter((k) => env[k]).map((k) => [k, env[k]!])), ...(s.env ?? {}) } }]),
  ),
});

const userMcpFile = (env: NodeJS.ProcessEnv) => path.join(env.HOME || os.homedir(), ".cursor", "mcp.json");

/** What the user-level file held before the run, to put back afterwards (null: there was none). */
const previous = new WeakMap<Job, { file: string; text: string | null }>();

export const cursorDriver: DriverImpl = {
  name: "cursor",
  binaries: ["agent", "cursor-agent"],
  async prepare(job, prompt, system, bin) {
    let mcp: McpConfig = {};
    try {
      mcp = JSON.parse(await fs.readFile(job.mcpConfigFile, "utf8")) as McpConfig;
    } catch {
      // no board server; the agent can still work, it just cannot report
    }
    if (Object.keys(mcp.mcpServers ?? {}).length) {
      const file = userMcpFile(process.env);
      const text = await fs.readFile(file, "utf8").catch(() => null);
      previous.set(job, { file, text });
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify(cursorMcpConfig(mcp, process.env), null, 2), { mode: 0o600 });
    }
    return { bin, args: cursorArgs(job, combinedPrompt(system, prompt)), env: { ...process.env }, cwd: job.cwd ?? "/workspace" };
  },
  translator(job) {
    return createCursorTranslator({ ticket: job.ticket, role: job.role, maxLen: job.debug ? 6000 : undefined, model: job.model });
  },
  stderrRateLimit: /usage limit|rate.?limit|\b429\b|quota|on-demand/i,
  async finish(job) {
    const p = previous.get(job);
    if (!p) return undefined;
    previous.delete(job);
    if (p.text === null) await fs.rm(p.file, { force: true });
    else await fs.writeFile(p.file, p.text);
    return undefined;
  },
};

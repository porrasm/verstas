/**
 * Codex CLI: `codex exec --json` reading the prompt from stdin.
 *
 * Codex keeps its login in `$CODEX_HOME/auth.json` and rotates the tokens
 * inside on its own. The harness passes the file's contents in
 * VERSTAS_CODEX_AUTH (worker process only, like every credential); this
 * driver writes it to a private CODEX_HOME for the run, and when Codex
 * exits it hands the file back on stdout as a `credential` line when it
 * changed, then removes the directory. The host stores the refreshed file,
 * so the next run starts from the rotated token (docs/DRIVERS.md).
 *
 * Codex has no system-prompt flag, so the rules are prepended to the task.
 * The board MCP server is declared in CODEX_HOME/config.toml, built from
 * the same mcp.json the Claude driver loads. Codex's own sandbox and
 * approvals are off in that file: the container is the sandbox.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { combinedPrompt, type DriverImpl, type Job } from "./driver.js";
import { CODEX_RATE_LIMIT, createCodexTranslator } from "./translate-codex.js";

/** Environment the board MCP server needs; Codex starts MCP servers with the env named in its config. */
const MCP_ENV = ["VERSTAS_AGENT_API", "VERSTAS_RUN_TOKEN", "VERSTAS_ROLE", "VERSTAS_BUDGET_FILE", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"];

const toml = (s: string) => JSON.stringify(s); // a JSON string literal is a valid TOML basic string

/** config.toml for a run: no approvals, no inner sandbox, the MCP servers from mcp.json with the env they need. */
export const codexConfigToml = (mcp: { mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }> }, env: NodeJS.ProcessEnv): string => {
  const lines = ['approval_policy = "never"', 'sandbox_mode = "danger-full-access"', ""];
  for (const [name, s] of Object.entries(mcp.mcpServers ?? {})) {
    lines.push(`[mcp_servers.${name}]`, `command = ${toml(s.command)}`, `args = [${(s.args ?? []).map(toml).join(", ")}]`, "");
    const e: Record<string, string> = { ...Object.fromEntries(MCP_ENV.filter((k) => env[k]).map((k) => [k, env[k]!])), ...(s.env ?? {}) };
    if (Object.keys(e).length) {
      lines.push(`[mcp_servers.${name}.env]`);
      for (const [k, v] of Object.entries(e)) lines.push(`${k} = ${toml(v)}`);
      lines.push("");
    }
  }
  return lines.join("\n");
};

export const codexArgs = (job: Job): string[] => ["exec", "--json", "--skip-git-repo-check", ...(job.model ? ["-m", job.model] : []), "-"];

const homes = new WeakMap<Job, { dir: string; authIn: string | undefined }>();

export const codexDriver: DriverImpl = {
  name: "codex",
  binaries: ["codex"],
  async prepare(job, prompt, system, bin) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "verstas-codex-"));
    await fs.chmod(dir, 0o700);
    const authIn = process.env.VERSTAS_CODEX_AUTH;
    if (authIn) await fs.writeFile(path.join(dir, "auth.json"), authIn, { mode: 0o600 });
    let mcp: Parameters<typeof codexConfigToml>[0] = {};
    try {
      mcp = JSON.parse(await fs.readFile(job.mcpConfigFile, "utf8")) as typeof mcp;
    } catch {
      // no board server; the agent can still work, it just cannot report
    }
    await fs.writeFile(path.join(dir, "config.toml"), codexConfigToml(mcp, process.env), { mode: 0o600 });
    homes.set(job, { dir, authIn });
    const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: dir };
    delete env.VERSTAS_CODEX_AUTH;
    // Never API billing by accident: a key in the box would override the subscription login.
    delete env.OPENAI_API_KEY;
    delete env.CODEX_API_KEY;
    return { bin, args: codexArgs(job), env, cwd: job.cwd ?? "/workspace", stdin: combinedPrompt(system, prompt) };
  },
  translator(job) {
    return createCodexTranslator({ ticket: job.ticket, role: job.role, maxLen: job.debug ? 6000 : undefined, model: job.model });
  },
  stderrRateLimit: CODEX_RATE_LIMIT,
  async finish(job) {
    const h = homes.get(job);
    if (!h) return undefined;
    homes.delete(job);
    let credential: string | undefined;
    try {
      const after = await fs.readFile(path.join(h.dir, "auth.json"), "utf8");
      if (after.trim() && after !== h.authIn) credential = after;
    } catch {
      // no auth file: nothing to hand back
    }
    await fs.rm(h.dir, { recursive: true, force: true });
    return { credential };
  },
};

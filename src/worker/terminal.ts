/**
 * An agent terminal inside the box: starts Claude Code's or Codex's own
 * interactive interface on the TTY the host attached, with the board MCP
 * server and the terminal rules, and waits for it.
 *
 *   node /opt/verstas/terminal.js --job /workspace/.verstas/jobs/<name>/job.json
 *
 * Environment (from the host's exec only): the driver's credential
 * (CLAUDE_CODE_OAUTH_TOKEN or VERSTAS_CODEX_AUTH), VERSTAS_RUN_TOKEN and
 * VERSTAS_ROLE=terminal for the board server. Unlike a worker, nothing is
 * translated: the TTY is the user's.
 *
 * Codex keeps its home under ~/.verstas/codex-terminal so its sessions
 * (codex resume) survive between terminals; the login is written there for
 * the session and removed afterwards, and a login Codex rotated meanwhile
 * is handed back in the job's credential file for the host to store.
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexConfigToml } from "./driver-codex.js";

export type TerminalJob = {
  driver: "claude" | "codex";
  model?: string;
  mcpConfigFile: string;
  /** The terminal rules (src/harness/prompts.ts terminalMd). */
  rulesFile: string;
  /** Where a rotated Codex login is handed back; the host reads and removes it. */
  credentialOut: string;
};

/**
 * The container is the sandbox, as for every worker, so permission prompts
 * are off; the board server comes from the session's mcp.json alongside any
 * the user adds themselves.
 */
export const claudeTerminalArgs = (job: TerminalJob): string[] => [
  "--permission-mode",
  "bypassPermissions",
  "--mcp-config",
  job.mcpConfigFile,
  "--append-system-prompt-file",
  job.rulesFile,
  ...(job.model ? ["--model", job.model] : []),
];

export const codexTerminalArgs = (job: TerminalJob): string[] => (job.model ? ["-m", job.model] : []);

export const codexTerminalHome = (home = os.homedir()): string => path.join(home, ".verstas", "codex-terminal");

/**
 * Claude Code's first-run onboarding (theme, login) checks a host the
 * box's proxy refuses, and exits when it cannot reach it; workers never
 * meet it because `-p` skips it. The login is the token in the environment,
 * so mark onboarding done. The folder-trust and bypass-permissions
 * questions stay for you to answer, once per box.
 */
export const skipClaudeOnboarding = async (file: string): Promise<void> => {
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
  } catch (e) {
    // A file that exists but does not parse is Claude Code's to repair; leave it alone.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") return;
  }
  if (config.hasCompletedOnboarding === true) return;
  await fs.writeFile(file, JSON.stringify({ ...config, hasCompletedOnboarding: true }, null, 2), { mode: 0o600 });
};

const main = async (): Promise<number> => {
  const i = process.argv.indexOf("--job");
  const file = i >= 0 ? process.argv[i + 1] : undefined;
  if (!file) throw new Error("usage: terminal.js --job <job.json>");
  const job = JSON.parse(await fs.readFile(file, "utf8")) as TerminalJob;

  // Ctrl-C, Ctrl-\ and Ctrl-Z reach every process on the TTY: they are the agent's to handle, not this wrapper's.
  for (const sig of ["SIGINT", "SIGQUIT", "SIGTSTP"] as const) process.on(sig, () => undefined);

  const env: NodeJS.ProcessEnv = { ...process.env };
  let bin: string;
  let args: string[];
  let codexHome: string | undefined;
  let authIn: string | undefined;
  if (job.driver === "codex") {
    codexHome = codexTerminalHome();
    await fs.mkdir(codexHome, { recursive: true, mode: 0o700 });
    authIn = env.VERSTAS_CODEX_AUTH;
    if (authIn) await fs.writeFile(path.join(codexHome, "auth.json"), authIn, { mode: 0o600 });
    const mcp = JSON.parse(await fs.readFile(job.mcpConfigFile, "utf8").catch(() => "{}")) as Parameters<typeof codexConfigToml>[0];
    await fs.writeFile(path.join(codexHome, "config.toml"), codexConfigToml(mcp, env), { mode: 0o600 });
    // Codex has no system-prompt flag; its home's AGENTS.md is read as global instructions.
    await fs.copyFile(job.rulesFile, path.join(codexHome, "AGENTS.md"));
    env.CODEX_HOME = codexHome;
    delete env.VERSTAS_CODEX_AUTH;
    // Never API billing by accident: a key in the box would override the subscription login.
    delete env.OPENAI_API_KEY;
    delete env.CODEX_API_KEY;
    bin = "codex";
    args = codexTerminalArgs(job);
  } else {
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
    await skipClaudeOnboarding(path.join(os.homedir(), ".claude.json"));
    bin = "claude";
    args = claudeTerminalArgs(job);
  }

  const child = spawn(bin, args, { stdio: "inherit", env, cwd: "/workspace" });
  // A hangup or stop from the host goes to the agent; this wrapper exits when the agent has.
  for (const sig of ["SIGHUP", "SIGTERM"] as const) process.on(sig, () => child.kill(sig));
  const code = await new Promise<number>((resolve) => {
    child.on("error", (e) => {
      process.stderr.write(`\r\nCould not start ${bin}: ${e.message}\r\n`);
      resolve(127);
    });
    child.on("exit", (c, signal) => resolve(c ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 1)));
  });

  if (codexHome) {
    const auth = path.join(codexHome, "auth.json");
    const after = await fs.readFile(auth, "utf8").catch(() => "");
    if (after.trim() && after !== authIn) await fs.writeFile(job.credentialOut, after, { mode: 0o600 });
    await fs.rm(auth, { force: true });
  }
  return code;
};

// Only as the entry point: tests import the argument builders.
if (process.argv[1] && /worker\/terminal\.(?:[cm]?js|ts)$|^\/opt\/verstas\/terminal\.js$/.test(process.argv[1])) {
  main().then(
    (code) => process.exit(code),
    (e: Error) => {
      process.stderr.write(`terminal: ${e.message}\r\n`);
      process.exit(1);
    },
  );
}

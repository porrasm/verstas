import { promises as fs } from "node:fs";
import { containerName } from "../sandbox/docker-args.js";
import { dockerSocketPath, execTty } from "../sandbox/docker-api.js";
import { runInSandbox, type SandboxConfig } from "../sandbox/lifecycle.js";
import type { CredentialStore } from "./docker-worker.js";
import { credentialFor, driverInfo, missingCredentialError } from "./drivers.js";
import type { TerminalProcess, TerminalRunner } from "./terminal.js";

/** The wrapper that starts the agent's interface in the box (src/worker/terminal.ts). */
export const TERMINAL_PATTERN = "/opt/verstas/terminal.js";
export const terminalCommand = (jobFile: string): string[] => ["node", TERMINAL_PATTERN, "--job", jobFile];

/** How long a hung-up agent gets to save and exit before it is killed. */
const KILL_GRACE_MS = 5_000;

/**
 * Agent terminals in the session container, through the Engine API's TTY
 * exec (src/sandbox/docker-api.ts). Like a worker, the agent's credential
 * and the run token reach this one process only. When it ends, a login
 * Codex rotated meanwhile is stored, as after a Codex worker.
 */
export const dockerTerminal = (cfg: SandboxConfig, sessionId: string, store: CredentialStore): TerminalRunner => ({
  async open(spec) {
    const driver = driverInfo(spec.driver);
    const credential = credentialFor(await store.secrets(), driver.name);
    if (!credential) throw missingCredentialError(driver.name, "the agent terminal runs on it");
    const socketPath = await dockerSocketPath(cfg.docker);
    const exec = await execTty(socketPath, {
      container: containerName(sessionId),
      cmd: terminalCommand(spec.jobFile),
      env: { [driver.env]: credential, VERSTAS_RUN_TOKEN: spec.runToken, VERSTAS_ROLE: "terminal", TERM: "xterm-256color", COLORTERM: "truecolor" },
      workdir: "/workspace",
      cols: spec.cols,
      rows: spec.rows,
    });
    const closed = new Promise<void>((resolve) => {
      exec.stream.once("close", () => resolve());
      exec.stream.once("end", () => resolve());
      exec.stream.once("error", () => resolve());
    });
    const exited = closed.then(async () => {
      // The daemon may still report the process as running for a moment after the stream closes.
      for (let i = 0; i < 10; i++) {
        const code = await exec.exitCode().catch(() => null);
        if (code !== null) return code;
        await new Promise((r) => setTimeout(r, 200));
      }
      return null;
    }).finally(async () => {
      // Codex rotates its login while it runs; the wrapper left the new one here (see src/worker/terminal.ts).
      const handed = await fs.readFile(spec.credentialFile, "utf8").catch(() => "");
      await fs.rm(spec.credentialFile, { force: true }).catch(() => undefined);
      if (handed.trim() && handed !== credential) await store.save(driver.name, handed).catch((e: Error) => console.warn(`[terminal ${sessionId}] could not store the refreshed ${driver.title} login: ${e.message}`));
    });
    const proc: TerminalProcess = {
      write: (data) => {
        if (!exec.stream.destroyed) exec.stream.write(data);
      },
      resize: (cols, rows) => void exec.resize(cols, rows).catch(() => undefined),
      onData: (fn) => exec.stream.on("data", (chunk: Buffer) => fn(chunk)),
      exited,
      async kill() {
        // The wrapper passes a hangup on to the agent and hands back its login; only then is it forced.
        const own = `${TERMINAL_PATTERN} --job ${spec.jobFile}`;
        await runInSandbox(cfg, sessionId, ["pkill", "-HUP", "-f", own], { allowFailure: true, timeoutMs: 15_000 }).catch(() => undefined);
        const gone = await Promise.race([exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), KILL_GRACE_MS).unref())]);
        if (gone) return;
        await runInSandbox(cfg, sessionId, ["pkill", "-KILL", "-f", own], { allowFailure: true, timeoutMs: 15_000 }).catch(() => undefined);
        exec.stream.destroy();
        await exited;
      },
    };
    return proc;
  },
});

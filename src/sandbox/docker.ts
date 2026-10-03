import { spawn, type ChildProcess } from "node:child_process";

/**
 * Thin runner over the `docker` CLI. The CLI is used instead of the Engine
 * API so that every sandbox operation is an argv a reviewer can read and
 * replay by hand (`docker <args>`), and so the host app has no Docker
 * dependency to install. All argv come from docker-args.ts.
 */

export type DockerResult = { code: number; stdout: string; stderr: string };

export class DockerError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly result: DockerResult,
  ) {
    super(`docker ${args.slice(0, 3).join(" ")} failed (${result.code}): ${result.stderr.trim().slice(0, 500)}`);
  }
}

export type DockerRunner = {
  run(args: readonly string[], opts?: { input?: string; timeoutMs?: number; allowFailure?: boolean }): Promise<DockerResult>;
  /** `env` is added to the docker CLI's own environment: pair it with `-e NAME` (no value) to pass a secret without putting it in argv. */
  spawn(args: readonly string[], opts?: { env?: Record<string, string> }): ChildProcess;
};

const DEBUG = Boolean(process.env.VERSTAS_DEBUG);
const show = (args: readonly string[]): string => args.map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(" ").slice(0, 400);

export const createDockerRunner = (binary = "docker"): DockerRunner => ({
  async run(args, opts = {}) {
    const t0 = Date.now();
    const child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
    const timer = opts.timeoutMs
      ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs)
      : undefined;
    const code = await new Promise<number>((resolve) => {
      child.on("error", () => resolve(127));
      child.on("close", (c) => resolve(c ?? 1));
    });
    if (timer) clearTimeout(timer);
    const result = { code, stdout, stderr };
    if (DEBUG) console.log(`[docker] ${code} ${Date.now() - t0}ms  docker ${show(args)}${code !== 0 ? `\n         ${stderr.trim().slice(0, 300)}` : ""}`);
    if (code !== 0 && !opts.allowFailure) throw new DockerError(args, result);
    return result;
  },
  spawn(args, opts = {}) {
    if (DEBUG) console.log(`[docker] spawn  docker ${show(args)}`);
    return spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"], env: opts.env ? { ...process.env, ...opts.env } : process.env });
  },
});

/** Is a Docker daemon reachable? Used by the UI's status row and by `doctor`. */
export const dockerAvailable = async (docker: DockerRunner): Promise<{ ok: boolean; detail: string }> => {
  const r = await docker.run(["version", "--format", "{{.Server.Version}}"], { allowFailure: true, timeoutMs: 10_000 });
  return r.code === 0 ? { ok: true, detail: r.stdout.trim() } : { ok: false, detail: r.stderr.trim() || "docker not reachable" };
};

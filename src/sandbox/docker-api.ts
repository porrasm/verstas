import http from "node:http";
import type { Duplex } from "node:stream";
import type { DockerRunner } from "./docker.js";

/**
 * The one place Verstas talks to the Docker Engine API instead of the CLI:
 * an interactive exec with a TTY, for an agent terminal. `docker exec -it`
 * needs a terminal on the host side, which Node cannot make without a
 * native module (and the host app runs under both Node and Electron). The
 * API's exec gives the same thing over the daemon's socket: a raw stream
 * to a TTY in the container and a resize call. What runs is the argv a
 * reviewer would read as
 *
 *   docker exec -it -w /workspace -e NAME … <container> <cmd…>
 *
 * Secrets go in the request body to the local daemon, never in an argv or
 * the host CLI's environment.
 */

/** The daemon's unix socket: DOCKER_HOST when it names one, else the current docker context's, else the default. */
export const dockerSocketPath = async (docker: DockerRunner, env: NodeJS.ProcessEnv = process.env): Promise<string> => {
  const unix = (host: string | undefined): string | undefined => (host?.startsWith("unix://") ? host.slice("unix://".length) : undefined);
  if (env.DOCKER_HOST) {
    const p = unix(env.DOCKER_HOST);
    if (!p) throw new Error(`DOCKER_HOST is ${env.DOCKER_HOST}; an agent terminal needs the daemon on a unix socket`);
    return p;
  }
  const r = await docker.run(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], { allowFailure: true, timeoutMs: 10_000 });
  return (r.code === 0 ? unix(r.stdout.trim()) : undefined) ?? "/var/run/docker.sock";
};

type Reply = { status: number; body: string };

const call = (socketPath: string, method: string, path: string, body?: unknown): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method, path, headers: { "Content-Type": "application/json" } }, (res) => {
      let data = "";
      res.setEncoding("utf8").on("data", (c: string) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });

const apiError = (what: string, r: Reply): Error => {
  let message = r.body.trim();
  try {
    message = (JSON.parse(r.body) as { message?: string }).message ?? message;
  } catch {
    // not JSON; keep the text
  }
  return new Error(`docker ${what} failed (${r.status}): ${message.slice(0, 300)}`);
};

export type TtyExecSpec = {
  container: string;
  cmd: readonly string[];
  env: Record<string, string>;
  workdir: string;
  cols: number;
  rows: number;
};

export type TtyExec = {
  id: string;
  /** Raw bytes both ways: what you type in, what the TTY shows out. */
  stream: Duplex;
  resize(cols: number, rows: number): Promise<void>;
  /** The exit code once the process has ended; null while it runs or when Docker does not know. */
  exitCode(): Promise<number | null>;
};

/** Starts `cmd` in the container on a fresh TTY and returns the attached stream. */
export const execTty = async (socketPath: string, spec: TtyExecSpec): Promise<TtyExec> => {
  const size = [Math.max(1, spec.rows), Math.max(1, spec.cols)];
  const created = await call(socketPath, "POST", `/containers/${encodeURIComponent(spec.container)}/exec`, {
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
    Cmd: spec.cmd,
    Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
    WorkingDir: spec.workdir,
    ConsoleSize: size,
  });
  if (created.status !== 201) throw apiError("exec", created);
  const id = (JSON.parse(created.body) as { Id: string }).Id;
  const stream = await new Promise<Duplex>((resolve, reject) => {
    // An upgrade request makes the daemon hand over the raw connection (a "hijack"); with Tty there is no stream framing.
    const req = http.request({ socketPath, method: "POST", path: `/exec/${id}/start`, headers: { "Content-Type": "application/json", Connection: "Upgrade", Upgrade: "tcp" } });
    req.on("upgrade", (_res, socket, head) => {
      if (head.length) socket.unshift(head);
      resolve(socket);
    });
    req.on("response", (res) => {
      let data = "";
      res.setEncoding("utf8").on("data", (c: string) => (data += c));
      res.on("end", () => reject(apiError("exec start", { status: res.statusCode ?? 0, body: data })));
    });
    req.on("error", reject);
    req.end(JSON.stringify({ Detach: false, Tty: true, ConsoleSize: size }));
  });
  return {
    id,
    stream,
    async resize(cols, rows) {
      const r = await call(socketPath, "POST", `/exec/${id}/resize?h=${Math.max(1, Math.round(rows))}&w=${Math.max(1, Math.round(cols))}`);
      // A resize that races the process's exit is harmless.
      if (r.status >= 400 && r.status !== 404 && r.status !== 409) throw apiError("exec resize", r);
    },
    async exitCode() {
      const r = await call(socketPath, "GET", `/exec/${id}/json`);
      if (r.status !== 200) return null;
      const info = JSON.parse(r.body) as { Running?: boolean; ExitCode?: number | null };
      return info.Running ? null : (info.ExitCode ?? null);
    },
  };
};

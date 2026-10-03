import http from "node:http";
import https from "node:https";

/**
 * A small JSON client for the relay. node:http rather than fetch so a
 * self-signed certificate can be accepted for a loopback address (a dev
 * relay on https://localhost) and nowhere else.
 */

export type JsonResponse = { status: number; body: unknown };

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export const isLoopback = (url: URL): boolean => LOOPBACK.has(url.hostname) || url.hostname.endsWith(".localhost");

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const requestJson = (
  url: string,
  opts: { method?: string; token?: string; body?: unknown; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<JsonResponse> =>
  new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return reject(new Error(`Unsupported URL ${u.protocol}`));
    if (u.protocol === "http:" && !isLoopback(u)) return reject(new Error("Use https for a remote dashboard that is not on this machine"));
    const data = opts.body === undefined ? undefined : Buffer.from(JSON.stringify(opts.body));
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(
      u,
      {
        method: opts.method ?? "GET",
        headers: {
          accept: "application/json",
          ...(data ? { "content-type": "application/json", "content-length": String(data.length) } : {}),
          ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        },
        timeout: opts.timeoutMs ?? 15_000,
        signal: opts.signal,
        ...(u.protocol === "https:" && isLoopback(u) ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body: unknown = text;
          try {
            body = text ? JSON.parse(text) : null;
          } catch {
            // not JSON; keep the text
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });

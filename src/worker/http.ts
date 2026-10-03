import http from "node:http";

/**
 * Plain-HTTP client for the agent API from inside the box. Node's fetch does
 * not read HTTP_PROXY, and the only route out of the session network is the
 * proxy, so requests are sent to the proxy with an absolute URL (the classic
 * forward-proxy form). Without HTTP_PROXY (tests, local runs) it connects
 * directly. Dependency-free on purpose: this ships inside the image.
 */

export type HttpResponse = { status: number; body: string };

export const parseProxy = (env: NodeJS.ProcessEnv = process.env): { host: string; port: number } | null => {
  const raw = env.HTTP_PROXY ?? env.http_proxy;
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return { host: u.hostname, port: u.port ? Number(u.port) : 80 };
  } catch {
    return null;
  }
};

export const request = (
  method: string,
  url: string,
  opts: { token?: string; json?: unknown; proxy?: { host: string; port: number } | null; timeoutMs?: number } = {},
): Promise<HttpResponse> =>
  new Promise((resolve, reject) => {
    const target = new URL(url);
    const proxy = opts.proxy === undefined ? parseProxy() : opts.proxy;
    const payload = opts.json === undefined ? undefined : JSON.stringify(opts.json);
    const headers: Record<string, string> = { accept: "application/json" };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (payload !== undefined) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(payload));
    }
    const req = http.request(
      proxy
        ? { host: proxy.host, port: proxy.port, method, path: target.href, headers: { ...headers, host: target.host } }
        : { host: target.hostname, port: target.port ? Number(target.port) : 80, method, path: target.pathname + target.search, headers },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (d: string) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.setTimeout(opts.timeoutMs ?? 30_000, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });

/**
 * Allowlist rules for the sandbox egress proxy. Pure and dependency-free:
 * this file is compiled and mounted into a plain node:22-alpine container
 * together with proxy.ts, so it must not import anything but Node builtins.
 *
 * Entry syntax, one per line of allowlist.json's string array:
 *   "api.anthropic.com"        exact host, HTTPS (CONNECT to 443) only
 *   "*.githubusercontent.com"  any subdomain (not the bare suffix), 443 only
 *   "localhost:8443"           exact host and port (CONNECT to that port)
 *
 * Plain HTTP is never allowed by the list. The single plain-HTTP exception
 * is the agent API, configured separately, and only under its path prefix.
 */

export type AllowEntry = { host: string; wildcard: boolean; port: number | null };

export type Decision = { allow: true } | { allow: false; reason: string };

const HOST_RE = /^(\*\.)?([a-z0-9-]+\.)*[a-z0-9-]+$/i;

export const parseEntry = (raw: string): AllowEntry | null => {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  const m = /^(.+?)(?::(\d{1,5}))?$/.exec(s);
  if (!m) return null;
  const hostPart = m[1]!;
  const port = m[2] ? Number(m[2]) : null;
  if (port !== null && (port < 1 || port > 65535)) return null;
  if (!HOST_RE.test(hostPart) || isIpLiteral(hostPart)) return null;
  const wildcard = hostPart.startsWith("*.");
  return { host: wildcard ? hostPart.slice(2) : hostPart, wildcard, port };
};

export const parseAllowlist = (entries: readonly string[]): AllowEntry[] =>
  entries.map(parseEntry).filter((e): e is AllowEntry => e !== null);

const hostMatches = (entry: AllowEntry, host: string): boolean =>
  entry.wildcard ? host.endsWith("." + entry.host) : host === entry.host;

/** Would a CONNECT (TLS tunnel) to host:port be allowed? */
export const decideConnect = (list: readonly AllowEntry[], hostRaw: string, port: number): Decision => {
  const host = hostRaw.trim().toLowerCase().replace(/\.$/, "");
  if (!host || !HOST_RE.test(host)) return { allow: false, reason: "bad host" };
  if (isIpLiteral(host)) return { allow: false, reason: "ip literals are not allowed" };
  for (const e of list) {
    if (!hostMatches(e, host)) continue;
    const wanted = e.port ?? 443;
    if (port === wanted) return { allow: true };
  }
  return { allow: false, reason: "not on allowlist" };
};

export type AgentApiTarget = { host: string; port: number; pathPrefix: string };

/**
 * Would a plain HTTP request (absolute URL through the proxy) be allowed?
 * Only the agent API, only under its prefix. Everything else must use TLS
 * through CONNECT, where the allowlist decides.
 */
export const decideHttp = (target: AgentApiTarget | null, url: string): Decision => {
  if (!target) return { allow: false, reason: "plain http is disabled" };
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { allow: false, reason: "bad url" };
  }
  if (u.protocol !== "http:") return { allow: false, reason: "only http: here" };
  const port = u.port ? Number(u.port) : 80;
  if (u.hostname.toLowerCase() !== target.host.toLowerCase() || port !== target.port) {
    return { allow: false, reason: "not the agent api" };
  }
  // Normalise away dot segments before checking the prefix; URL does this
  // already for the pathname, so a "/agent/../sessions" cannot slip through.
  if (!u.pathname.startsWith(target.pathPrefix)) return { allow: false, reason: "outside agent api prefix" };
  return { allow: true };
};

export const isIpLiteral = (host: string): boolean =>
  /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");

export const parseAgentApiTarget = (raw: string | undefined): AgentApiTarget | null => {
  if (!raw) return null;
  const m = /^([a-z0-9.-]+):(\d{1,5})$/i.exec(raw.trim());
  if (!m) return null;
  return { host: m[1]!.toLowerCase(), port: Number(m[2]), pathPrefix: "/agent/" };
};

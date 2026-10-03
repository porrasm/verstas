import { test, expect } from "@playwright/test";
import {
  decideConnect,
  decideHttp,
  parseAgentApiTarget,
  parseAllowlist,
  parseEntry,
} from "../../src/proxy/allowlist.js";

const list = parseAllowlist(["api.anthropic.com", "*.githubusercontent.com", "localhost:8443", "Registry.NPMJS.org "]);

test("entries parse, normalise case and drop garbage", () => {
  expect(parseEntry("*.example.com")).toEqual({ host: "example.com", wildcard: true, port: null });
  expect(parseEntry("example.com:8443")).toEqual({ host: "example.com", wildcard: false, port: 8443 });
  expect(parseEntry("")).toBeNull();
  expect(parseEntry("http://example.com")).toBeNull();
  expect(parseEntry("exa mple.com")).toBeNull();
  expect(parseEntry("example.com:70000")).toBeNull();
  expect(list).toHaveLength(4);
});

test("CONNECT is allowed only to listed hosts on 443, or the entry's own port", () => {
  expect(decideConnect(list, "api.anthropic.com", 443)).toEqual({ allow: true });
  expect(decideConnect(list, "API.Anthropic.com.", 443)).toEqual({ allow: true });
  expect(decideConnect(list, "api.anthropic.com", 80).allow).toBe(false);
  expect(decideConnect(list, "api.anthropic.com", 8443).allow).toBe(false);
  expect(decideConnect(list, "localhost", 8443)).toEqual({ allow: true });
  expect(decideConnect(list, "localhost", 443).allow).toBe(false);
  expect(decideConnect(list, "registry.npmjs.org", 443)).toEqual({ allow: true });
});

test("wildcards match subdomains only, never the bare suffix or a lookalike", () => {
  expect(decideConnect(list, "objects.githubusercontent.com", 443)).toEqual({ allow: true });
  expect(decideConnect(list, "a.b.githubusercontent.com", 443)).toEqual({ allow: true });
  expect(decideConnect(list, "githubusercontent.com", 443).allow).toBe(false);
  expect(decideConnect(list, "evilgithubusercontent.com", 443).allow).toBe(false);
  expect(decideConnect(list, "api.anthropic.com.evil.com", 443).allow).toBe(false);
});

test("ip literals and malformed hosts are denied even if someone lists them", () => {
  const ips = parseAllowlist(["10.0.0.1", "::1"]);
  expect(ips).toHaveLength(0);
  expect(decideConnect(list, "10.0.0.1", 443).allow).toBe(false);
  expect(decideConnect(list, "", 443).allow).toBe(false);
  expect(decideConnect(list, "a b", 443).allow).toBe(false);
});

test("plain http goes only to the agent api under its prefix", () => {
  const target = parseAgentApiTarget("host.docker.internal:4701");
  expect(target).toEqual({ host: "host.docker.internal", port: 4701, pathPrefix: "/agent/" });
  expect(decideHttp(target, "http://host.docker.internal:4701/agent/board")).toEqual({ allow: true });
  expect(decideHttp(target, "http://host.docker.internal:4701/agent/../sessions").allow).toBe(false);
  expect(decideHttp(target, "http://host.docker.internal:4701/sessions").allow).toBe(false);
  expect(decideHttp(target, "http://host.docker.internal:4700/agent/board").allow).toBe(false);
  expect(decideHttp(target, "http://example.com/agent/board").allow).toBe(false);
  expect(decideHttp(target, "https://host.docker.internal:4701/agent/board").allow).toBe(false);
  expect(decideHttp(target, "/agent/board").allow).toBe(false);
  expect(decideHttp(null, "http://host.docker.internal:4701/agent/board").allow).toBe(false);
  expect(parseAgentApiTarget("nope")).toBeNull();
});

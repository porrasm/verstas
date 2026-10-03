import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

/**
 * Runs the real proxy (via tsx) against local servers: an "agent api" on one
 * port and a TCP echo server standing in for a TLS endpoint on another. The
 * allowlist names the echo server with its port, so CONNECT to it must
 * succeed and CONNECT to anything else must be refused.
 */

const listen = (server: net.Server | http.Server): Promise<number> =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port)));

const waitFor = (child: ChildProcess, needle: string): Promise<void> =>
  new Promise((resolve, reject) => {
    let buf = "";
    child.stdout!.on("data", (d: Buffer) => {
      buf += d.toString();
      if (buf.includes(needle)) resolve();
    });
    child.on("exit", (c) => reject(new Error(`proxy exited ${c}: ${buf}`)));
  });

const rawRequest = (port: number, text: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const s = net.connect(port, "127.0.0.1", () => s.write(text));
    let out = "";
    s.on("data", (d) => (out += d.toString()));
    s.on("end", () => resolve(out));
    s.on("close", () => resolve(out));
    s.on("error", reject);
    setTimeout(() => s.destroy(), 3000);
  });

test("proxy allows CONNECT to listed host:port, forwards agent api under /agent/, denies the rest", async () => {
  test.setTimeout(30_000);
  // Stand-ins.
  const echo = net.createServer((sock) => sock.on("data", (d) => sock.write(d)));
  const echoPort = await listen(echo);
  const api = http.createServer((req, res) => res.end(`api:${req.url}`));
  const apiPort = await listen(api);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "verstas-proxy-"));
  const allowlistFile = path.join(dir, "allowlist.json");
  await fs.writeFile(allowlistFile, JSON.stringify([`localhost:${echoPort}`, "api.anthropic.com"]));

  const proxyPort = 30000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ["--import", "tsx", "src/proxy/proxy.ts"], {
    env: { ...process.env, PORT: String(proxyPort), ALLOWLIST_FILE: allowlistFile, VERSTAS_AGENT_API: `127.0.0.1:${apiPort}` },
    stdio: ["ignore", "pipe", "inherit"],
  });
  try {
    await waitFor(child, '"kind":"listening"');

    // CONNECT to the allowed echo server: 200, then bytes round-trip.
    const tunnel = await new Promise<string>((resolve, reject) => {
      const s = net.connect(proxyPort, "127.0.0.1", () => s.write(`CONNECT localhost:${echoPort} HTTP/1.1\r\nHost: localhost:${echoPort}\r\n\r\n`));
      let out = "";
      let sentPayload = false;
      s.on("data", (d) => {
        out += d.toString();
        if (!sentPayload && out.includes("200 Connection Established")) {
          sentPayload = true;
          s.write("ping-through-tunnel");
        } else if (sentPayload && out.includes("ping-through-tunnel")) {
          s.end();
          resolve(out);
        }
      });
      s.on("error", reject);
    });
    expect(tunnel).toContain("200 Connection Established");
    expect(tunnel).toContain("ping-through-tunnel");

    // CONNECT to a listed host on the wrong port, and to an unlisted host: 403.
    expect(await rawRequest(proxyPort, `CONNECT localhost:${echoPort + 1} HTTP/1.1\r\nHost: x\r\n\r\n`)).toContain("403");
    expect(await rawRequest(proxyPort, "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n")).toContain("403");
    // Listed host, right port, but the proxy cannot resolve it here: that is a 502 or a 403, never a 200.
    expect(await rawRequest(proxyPort, "CONNECT api.anthropic.com:80 HTTP/1.1\r\nHost: api.anthropic.com\r\n\r\n")).toContain("403");

    // A client that resets right after a refusal must not take the proxy down (it did once).
    await new Promise<void>((resolve) => {
      const s = net.connect(proxyPort, "127.0.0.1", () => {
        s.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n");
        s.once("data", () => {
          s.resetAndDestroy();
          resolve();
        });
      });
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(child.exitCode).toBeNull();
    expect(await rawRequest(proxyPort, `CONNECT localhost:${echoPort + 1} HTTP/1.1\r\nHost: x\r\n\r\n`)).toContain("403");

    // Plain HTTP to the agent api under the prefix: forwarded.
    const ok = await rawRequest(proxyPort, `GET http://127.0.0.1:${apiPort}/agent/board HTTP/1.1\r\nHost: 127.0.0.1:${apiPort}\r\nConnection: close\r\n\r\n`);
    expect(ok).toContain("200");
    expect(ok).toContain("api:/agent/board");
    // Outside the prefix, or to another host: 403.
    expect(await rawRequest(proxyPort, `GET http://127.0.0.1:${apiPort}/sessions HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`)).toContain("403");
    expect(await rawRequest(proxyPort, `GET http://127.0.0.1:${apiPort}/agent/../sessions HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`)).toContain("403");
    expect(await rawRequest(proxyPort, "GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n")).toContain("403");

    // Live reload: remove the echo entry, wait past the poll, CONNECT is now refused.
    await fs.writeFile(allowlistFile, JSON.stringify(["api.anthropic.com"]));
    await new Promise((r) => setTimeout(r, 2600));
    expect(await rawRequest(proxyPort, `CONNECT localhost:${echoPort} HTTP/1.1\r\nHost: x\r\n\r\n`)).toContain("403");
  } finally {
    child.kill("SIGTERM");
    echo.close();
    api.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

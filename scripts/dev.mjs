#!/usr/bin/env node
// npm run dev: everything in watch mode, with debug output, in one terminal.
//
//   [build]   tsc --watch          keeps dist/ current (the proxy and worker
//                                  code that containers mount)
//   [server]  tsx watch src/main.ts the host app, restarted on change,
//                                  VERSTAS_DEBUG=1 (docker commands, raw
//                                  worker streams, full tool output)
//   [web]     vite                 the UI with hot reload on :4710
//   [app]     electron --dev       a window on the Vite UI, DevTools open
//
// Closing the window or Ctrl-C stops all four; the host app stops its runs
// and requeues their tickets first.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = (name) => path.join(root, "node_modules", ".bin", process.platform === "win32" ? `${name}.cmd` : name);
const color = { build: 90, server: 36, web: 35, app: 33 };

const procs = [];
let stopping = false;

const run = (label, cmd, args, env = {}) => {
  const p = spawn(cmd, args, { cwd: root, env: { ...process.env, FORCE_COLOR: "1", ...env }, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
  const tag = `\x1b[${color[label]}m[${label}]\x1b[0m `;
  for (const stream of [p.stdout, p.stderr]) {
    let buf = "";
    stream.on("data", (chunk) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) process.stdout.write(tag + line.replace(/\x1bc|\x1b\[2J|\x1b\[3J|\x1b\[H/g, "") + "\n");
    });
  }
  p.on("exit", (code) => {
    if (!stopping) {
      console.log(`${tag}exited (${code ?? "signal"}); stopping the rest`);
      stop(code ?? 0);
    }
  });
  procs.push(p);
  return p;
};

const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  for (const p of procs) if (p.exitCode === null) p.kill("SIGTERM");
  // The host app requeues tickets before it exits; give it time, then go.
  const deadline = setTimeout(() => {
    for (const p of procs) if (p.exitCode === null) p.kill("SIGKILL");
    process.exit(code);
  }, 15_000);
  Promise.all(procs.map((p) => (p.exitCode !== null ? null : new Promise((r) => p.on("exit", r))))).then(() => {
    clearTimeout(deadline);
    process.exit(code);
  });
};

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

run("build", bin("tsc"), ["-p", "tsconfig.json", "--watch", "--preserveWatchOutput"]);
run("server", bin("tsx"), ["watch", "--clear-screen=false", "src/main.ts"], { VERSTAS_DEBUG: "1" });
run("web", bin("vite"), ["--config", "web/vite.config.ts", "--strictPort"]);
run("app", bin("electron"), [".", "--dev"]);

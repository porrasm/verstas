#!/usr/bin/env node
// npm run setup: everything `npm start` needs, from a fresh clone after
// `npm install`. Safe to run again (after a pull, for example): every step
// is either cached or idempotent.
//
//   1. checks the tools: Node 22+, git, a running Docker, the Electron binary
//   2. builds the host app, the proxy and the worker (dist/)
//   3. builds the web UI (web/dist)
//   4. builds the images: the session image (verstas-devbox:local) and the
//      proxy's base image (node:22-alpine). Those are all Verstas runs;
//      per-session snapshots are made later, when you confirm a setup.
//   5. the Claude token: asks for it when none is saved (stored in
//      ~/.verstas/secrets.json, mode 0600)

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = (name) => path.join(root, "node_modules", ".bin", process.platform === "win32" ? `${name}.cmd` : name);
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const STEPS = 5;
const step = (n, s) => console.log(`\n${bold(`[${n}/${STEPS}]`)} ${s}`);
const die = (msg) => {
  console.error(`\n\x1b[31m${msg}\x1b[0m`);
  process.exit(1);
};
const sh = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { cwd: root, stdio: opts.quiet ? "pipe" : "inherit", encoding: "utf8", shell: process.platform === "win32" });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim(), error: r.error };
};

/** Reads one line without echoing it (a token should not end up in the scrollback). */
const askHidden = (question) =>
  new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => {
      if (s.startsWith(question)) rl.output.write(s);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer.trim());
    });
  });

// ---- 1

step(1, "Checking Node, git, Docker and Electron");
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 12)) die(`Node ${process.versions.node} is too old; Verstas needs Node 22.12 or newer.`);
if (!existsSync(bin("tsc")) || !existsSync(bin("electron"))) die("Dependencies are missing. Run `npm install` first.");
const git = sh("git", ["--version"], { quiet: true });
if (!git.ok) die("git was not found. Verstas clones your repositories with it; install git and run `npm run setup` again.");
const docker = sh("docker", ["version", "--format", "{{.Server.Version}}"], { quiet: true });
if (docker.error) die("The docker command was not found. Install Docker Desktop (or a Docker engine), start it, and run `npm run setup` again.");
if (!docker.ok) die(`Docker is installed but not running:\n${docker.out}\n\nStart Docker Desktop and run \`npm run setup\` again.`);
// Electron fetches its binary on first use; do it now rather than on the first `npm start`.
const electron = sh(bin("electron"), ["--version"], { quiet: true });
if (!electron.ok) die(`Electron could not be installed:\n${electron.out}`);
console.log(`Node ${process.versions.node}, ${git.out}, Docker ${docker.out}, Electron ${electron.out.split("\n").pop()}`);

// ---- 2, 3

step(2, "Building the host app, proxy and worker (dist/)");
if (!sh(bin("tsc"), ["-p", "tsconfig.json"]).ok) die("The TypeScript build failed (see above).");

step(3, "Building the web UI (web/dist)");
if (!sh(bin("vite"), ["build", "--config", "web/vite.config.ts", "--logLevel", "warn"]).ok) die("The web build failed (see above).");

// ---- 4

step(4, "Building the images (the first build takes a few minutes)");
const { PROXY_IMAGE } = await import(pathToFileURL(path.join(root, "dist", "src", "sandbox", "docker-args.js")).href);
const { loadConfig, loadSecrets, saveSecrets, verstasHome } = await import(pathToFileURL(path.join(root, "dist", "src", "config.js")).href);
const config = await loadConfig();
const devbox = config.devboxImage;
console.log(`session image ${devbox}`);
if (!sh("docker", ["build", "-f", "images/devbox/Dockerfile", "-t", devbox, "."]).ok) die("The session image build failed (see above). Is Docker running and online?");
console.log(`proxy image ${PROXY_IMAGE}`);
if (!sh("docker", ["pull", "-q", PROXY_IMAGE]).ok) die(`Could not pull ${PROXY_IMAGE} (the proxy's base image).`);

// ---- 5

step(5, "Claude token");
const secrets = await loadSecrets();
if (secrets.claudeToken) {
  console.log(`A token is saved in ${path.join(verstasHome(), "secrets.json")}.`);
} else if (!process.stdin.isTTY) {
  console.log("No token yet. Run `claude setup-token` and paste the result in Verstas, Settings.");
} else {
  const hasClaude = sh("claude", ["--version"], { quiet: true }).ok;
  console.log(
    hasClaude
      ? "Workers run Claude Code with a long-lived token. In another terminal run `claude setup-token`, then paste the token here."
      : "Workers run Claude Code with a long-lived token. Install Claude Code, run `claude setup-token`, then paste the token here.",
  );
  const token = await askHidden("Token (input hidden; Enter to skip): ");
  if (token.length >= 10) {
    await saveSecrets({ ...secrets, claudeToken: token });
    console.log(`Saved to ${path.join(verstasHome(), "secrets.json")} (mode 0600).`);
  } else {
    console.log("Skipped. Paste it later in Verstas, Settings.");
  }
}

console.log(`\nSessions are kept in ${config.sessionsRoot} (change it in Settings).`);
console.log(`\n${bold("Ready.")} Start Verstas with ${bold("npm start")}, or ${bold("npm run dev")} to work on Verstas itself (watch mode, debug logs, DevTools).`);

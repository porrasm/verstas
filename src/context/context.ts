import type { Session } from "../core/types.js";
import type { Config } from "../config.js";
import type { SetupScript } from "../scripts/library.js";
import type { DockerRunner } from "../sandbox/docker.js";

/**
 * "Copy context for an LLM": a Markdown block assembled from live facts, to
 * paste into any assistant so it can write a setup script, a board, or
 * answer a question about the box. No model is called from here. Every
 * sentence about the sandbox comes from the same place VERSTAS.md gets it,
 * so the two cannot drift apart.
 */

export type ImageFacts = {
  image: string;
  os: string;
  node: string;
  npm: string;
  python: string;
  git: string;
  claude: string;
  packages: string[];
  arch: string;
};

const cache = new Map<string, Promise<ImageFacts | null>>();

/** Probes an image once per image id with a throwaway container that has no network. */
export const probeImage = async (docker: DockerRunner, image: string): Promise<ImageFacts | null> => {
  const idR = await docker.run(["image", "inspect", image, "--format", "{{.Id}}"], { allowFailure: true, timeoutMs: 10_000 });
  if (idR.code !== 0) return null;
  const key = idR.stdout.trim();
  let p = cache.get(key);
  if (!p) {
    p = (async () => {
      const script =
        '. /etc/os-release 2>/dev/null; echo "OS=$PRETTY_NAME"; echo "ARCH=$(uname -m)"; echo "NODE=$(node -v 2>/dev/null)"; echo "NPM=$(npm -v 2>/dev/null)"; echo "PY=$(python3 -V 2>&1)"; echo "GIT=$(git --version 2>/dev/null)"; echo "CLAUDE=$(claude --version 2>/dev/null | head -1)"; echo "PKGS=$(dpkg-query -W -f=\'${binary:Package} \' 2>/dev/null)"';
      const r = await docker.run(["run", "--rm", "--network", "none", "--entrypoint", "sh", image, "-c", script], { allowFailure: true, timeoutMs: 90_000 });
      if (r.code !== 0) return null;
      const get = (k: string) => (new RegExp(`^${k}=(.*)$`, "m").exec(r.stdout)?.[1] ?? "").trim();
      return {
        image,
        os: get("OS"),
        arch: get("ARCH"),
        node: get("NODE"),
        npm: get("NPM"),
        python: get("PY"),
        git: get("GIT"),
        claude: get("CLAUDE"),
        packages: get("PKGS").split(/\s+/).filter(Boolean),
      };
    })();
    cache.set(key, p);
  }
  return p;
};

export type ContextTail = "script" | "board" | "free";

export type ContextInput = {
  tail: ContextTail;
  config: Config;
  facts: ImageFacts | null;
  scripts: SetupScript[];
  session?: Session | null;
  /** Repo names available for a board, when no session exists yet. */
  repoNames?: string[];
};

const RULES = [
  "The agent runs as uid 1000 with no sudo; its only writable place that survives is /workspace (plus /tmp, a 1 GB tmpfs). Everything else is read-only to it.",
  "Network: HTTPS only, through a proxy, to an allowlist of hosts. Plain HTTP is refused, so are IP literals, and names outside the list do not resolve. Tools that honour HTTPS_PROXY work (curl, git, npm, pip, Claude Code); tools that do not cannot connect.",
  "Setup scripts run once as root when the session's container is created (bash -e, non-interactive), with their output logged. After that there is no root except commands the user approves one by one.",
  "No systemd and no Docker inside the box. Services (Postgres, Redis, dev servers) run as plain processes started by the agent or by a setup script; they stay up for the whole session.",
  "Repositories arrive as fresh git clones under /workspace/<name> on a run branch; git-ignored files (.env, keys) are not there. Zip attachments are extracted under /workspace/attachments.",
  "The agent commits nothing; the harness commits once per ticket. Work is exported as git bundles.",
];

export const buildContext = (i: ContextInput): string => {
  const out: string[] = [];
  out.push("# Verstas sandbox: context for an assistant", "");
  out.push("Verstas runs coding agents inside a Docker container on the user's machine, one container per session, working through a kanban board of tickets. What follows is true for this installation today.", "");

  out.push("## The box", "");
  if (i.facts) {
    out.push(`- Image \`${i.facts.image}\`: ${i.facts.os || "Debian"}, ${i.facts.arch || "unknown arch"}.`);
    out.push(`- Tools: node ${i.facts.node}, npm ${i.facts.npm}, ${i.facts.python}, ${i.facts.git}${i.facts.claude ? `, Claude Code ${i.facts.claude}` : ""}.`);
  } else {
    out.push(`- Image \`${i.config.devboxImage}\` (Debian bookworm based; node 22, python 3, git, build-essential). Versions not probed: Docker was not reachable.`);
  }
  for (const r of RULES) out.push(`- ${r}`);
  if (i.facts?.packages.length) {
    const pk = i.facts.packages;
    out.push(`- Installed apt packages (${pk.length}): ${pk.slice(0, 400).join(" ")}${pk.length > 400 ? " …" : ""}`);
  }
  out.push("");

  if (i.session) {
    const s = i.session;
    out.push("## This session", "");
    out.push(`- Name: ${s.name}`);
    if (s.goal) out.push(`- Goal: ${s.goal.replace(/\s+/g, " ").slice(0, 2000)}`);
    out.push(`- Repositories: ${s.repos.length ? s.repos.map((r) => `/workspace/${r.name} (branch ${r.branch})`).join(", ") : "none"}`);
    out.push(`- Attachments: ${s.attachments.length ? s.attachments.map((a) => `/workspace/attachments/${a.dir}`).join(", ") : "none"}`);
    out.push(`- Network allowlist: ${s.allowlist.join(", ") || "none"}`);
    out.push(`- Setup scripts chosen: ${s.setupScripts.length ? s.setupScripts.map((x) => x.name).join(", ") : "none"}`);
    out.push(`- Caps per worker: ${s.caps.workerMinutes} min, ${s.caps.workerTurns} turns, ${s.caps.budgetUsd} USD; model ${s.model ?? "token default"}; reviewer ${s.caps.reviewer ? "on" : "off"}.`);
    out.push("");
  }

  if (i.scripts.length) {
    out.push("## Setup script library", "");
    for (const sc of i.scripts) out.push(`- \`${sc.name}\`: ${sc.description || "(no description)"}${sc.hosts.length ? ` · needs ${sc.hosts.join(", ")}` : ""}`);
    out.push("");
  }

  if (i.tail === "script") {
    out.push("## Your task", "");
    out.push("Write a bash setup script for this box that installs: (FILL IN what you need).", "");
    out.push("Requirements:");
    out.push("- Output only the script, nothing else.");
    out.push("- Start with `#!/usr/bin/env bash` and `set -euo pipefail`; it runs as root, non-interactive (`export DEBIAN_FRONTEND=noninteractive`, use `-y`).");
    out.push("- Idempotent: safe to run twice.");
    out.push("- Second line: `# needs-hosts: host1 host2` listing every host the script downloads from; downloads go through an HTTPS proxy to those hosts only. Default-allowed: api.anthropic.com registry.npmjs.org pypi.org files.pythonhosted.org github.com objects.githubusercontent.com deb.debian.org security.debian.org (apt works out of the box, over HTTPS).");
    out.push("- Third line: `# note: ...` one sentence for the agent on how to use what you installed (paths, how to start a service).");
    out.push("- Detect the architecture with `uname -m` (x86_64 or aarch64) when downloading binaries.");
    out.push("- End with a verification command that fails the script if the install did not work.");
  } else if (i.tail === "board") {
    const repos = i.session?.repos.map((r) => r.name) ?? i.repoNames ?? [];
    out.push("## Board format", "");
    out.push("```json");
    out.push(JSON.stringify({ verstas: 1, goal: "…", tickets: [{ id: "T-1", title: "…", kind: "feature", repo: repos[0] ?? "name", size: "S", priority: 10, deps: [], state: "ready", spec: "…", acceptance: ["…"] }] }, null, 2));
    out.push("```");
    out.push("- `kind`: feature | bug | followup | chore. `size`: S (under half a day) | M | L. Lower `priority` runs first. `deps` are ids that must be done first. `state`: backlog or ready.");
    out.push(`- \`repo\` must be one of: ${repos.length ? repos.join(", ") : "(the session's repository names)"}; a ticket with another name is refused.`);
    out.push("- Acceptance criteria must be checkable by a reviewer who did not write the code. Prefer ten small tickets over thirty vague ones. Each ticket is worked by a fresh agent with the spec, the acceptance criteria and the last five reports as its only context, so specs must say where and how.");
    out.push("");
    out.push("## Your task", "");
    out.push("Produce a Verstas board as JSON for: (FILL IN the feature or goal). Output only the JSON.");
  } else {
    out.push("## Your task", "");
    out.push("(Ask your question here.)");
  }
  return out.join("\n") + "\n";
};

import { attachmentLines, type Session } from "../core/types.js";
import type { Config } from "../config.js";
import type { SetupScript } from "../scripts/library.js";
import type { DockerRunner } from "../sandbox/docker.js";
import { DEFAULT_PACKS, NETWORK_PACKS, packHosts } from "../network/packs.js";

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

export type ContextTail = "script" | "board" | "draft" | "free";

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
  "The agent runs as uid 1000 with passwordless sudo (logged). /workspace is the bind mount that survives a container recreate; /tmp is a 2 GB tmpfs.",
  "Network: HTTPS only, through a proxy, to an allowlist of hosts. Plain HTTP is refused, so are IP literals, and names outside the list do not resolve. Tools that honour HTTPS_PROXY work (curl, git, npm, pip, Claude Code); tools that do not cannot connect.",
  "Setup scripts run once as root when the session's container is created (bash -e, non-interactive), with their output logged. The agent can also install with sudo during the session.",
  "No systemd and no Docker inside the box. Services (Postgres, Redis, dev servers) run as plain processes under `svc` (svc start <name> --port N -- <cmd>), which remembers them and restarts them after a container restart.",
  "Repositories arrive as fresh git clones under /workspace/<name> on a run branch; git-ignored files (.env, keys) are not there. Zip attachments are extracted under /workspace/attachments.",
  "One lead works the session's goal and board. It commits its own work (the ticket id in the subject); the harness commits what it leaves when a lead life ends. The person takes the work to GitHub as a pull request and later syncs the clones to the merged result; the agent never pushes or pulls.",
];

export const buildContext = (i: ContextInput): string => {
  const out: string[] = [];
  out.push("# Verstas sandbox: context for an assistant", "");
  out.push("Verstas runs one coding agent, the lead, inside a Docker container on the user's machine, one container per session. The lead works toward the session's goal and its board of tickets; an independent reviewer judges the tickets it finishes. What follows is true for this installation today.", "");

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
    out.push(`- Attachments:${s.attachments.length ? `\n${attachmentLines(s.attachments, "  ")}` : " none"}`);
    out.push(`- Network allowlist: ${s.allowlist.join(", ") || "none"}`);
    out.push(`- Setup scripts chosen: ${s.setupScripts.length ? s.setupScripts.map((x) => x.name).join(", ") : "none"}`);
    out.push(`- One lead works the goal and the board; reviewer ${s.caps.reviewer ? "on" : "off"}; lead caps: ${s.caps.leadMinutes || s.caps.leadTurns ? [s.caps.leadMinutes ? `${s.caps.leadMinutes} min` : "", s.caps.leadTurns ? `${s.caps.leadTurns} turns` : ""].filter(Boolean).join(", ") : "none"}; model ${s.model ?? "token default"}.`);
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
    out.push(`- Second line: \`# needs-hosts: host1 host2\` listing every host the script downloads from; downloads go through an HTTPS proxy to those hosts only. Allowed by default: ${packHosts(i.session?.packs ?? DEFAULT_PACKS).join(" ")} (apt works out of the box, over HTTPS). Named packs the user can tick: ${NETWORK_PACKS.map((p) => `${p.name} (${p.hosts.join(" ")})`).join("; ")}.`);
    out.push("- Third line: `# note: ...` one sentence for the agent on how to use what you installed (paths, how to start a service).");
    out.push("- Detect the architecture with `uname -m` (x86_64 or aarch64) when downloading binaries.");
    out.push("- End with a verification command that fails the script if the install did not work.");
  } else if (i.tail === "board") {
    const repos = i.session?.repos.map((r) => r.name) ?? i.repoNames ?? [];
    out.push(...boardFormat(repos));
    out.push("");
    out.push("## Your task", "");
    out.push("Produce a Verstas board as JSON for: (FILL IN the feature or goal). Output only the JSON.");
  } else if (i.tail === "draft") {
    out.push(...draftGuide(i.repoNames ?? []));
  } else {
    out.push("## Your task", "");
    out.push("(Ask your question here.)");
  }
  return out.join("\n") + "\n";
};

/** The board format and the rules a good board follows; shared by the "board" and "draft" tails. */
const boardFormat = (repos: readonly string[]): string[] => [
  "## Board format",
  "",
  "```json",
  JSON.stringify({ verstas: 1, goal: "…", tickets: [{ id: "T-1", title: "…", kind: "feature", repo: repos[0] ?? "name", priority: 10, deps: [], state: "ready", spec: "…", acceptance: ["…"] }] }, null, 2),
  "```",
  "- `kind`: feature | bug | followup | chore, a label. Lower `priority` first and `deps` are hints the lead reads; the harness orders nothing by them. `state`: backlog (waits for the person) or ready.",
  `- \`repo\` must be one of: ${repos.length ? repos.join(", ") : "(the session's repository names)"}; a ticket with another name is refused.`,
  "- Acceptance criteria must be checkable by a reviewer who did not write the code. The lead reads the whole board and decides how to work it, so a spec should say what and where, not how to proceed.",
  "- `review` (optional, the person's choice): `full` runs the independent reviewer on this ticket, `none` skips it; absent, the session's setting applies.",
  "- The goal is optional: the lead works toward it beside the tickets, so a session can be a goal alone, a board alone, or both.",
];

/** What an assistant needs to prepare a draft session through the draft tools. */
const draftGuide = (repos: readonly string[]): string[] => [
  ...boardFormat(repos),
  "",
  "## Network packs",
  "",
  "Named bundles of download hosts. The Claude API is always on; tick the rest by name. Extra hosts are single names or `*.suffix`, HTTPS only.",
  "",
  ...NETWORK_PACKS.filter((p) => p.name !== "anthropic").map((p) => `- \`${p.name}\`: ${p.title} (${p.hosts.join(", ")})`),
  "",
  "## Drafts",
  "",
  "A draft is a session that does not exist yet: a name, a goal, repositories, network packs, recipes, notes for the person, and a board. You prepare it; a person reviews it in the Verstas app, creates the session and initializes it. You cannot create, start or change a session, and you cannot run anything in the box.",
  "",
  "Work in small steps and read the problems every tool returns:",
  "",
  "1. `draft_create` with a name and the goal. One lead works the goal and the board together; tickets are optional, so add them when the work splits into pieces a reviewer should judge one by one.",
  "2. `draft_set_repositories` with repositories from `list_repositories`. The ticket `repo` field is the directory name (the target name unless you rename it).",
  "3. `draft_set_network` for the toolchains the repositories download from, and `draft_set_recipes` for library recipes that already set up part of the box.",
  "4. `draft_add_tickets` a few at a time, in dependency order. Give each ticket a spec that names files and commands, and acceptance criteria a reviewer can check by running something.",
  "5. `draft_validate` until there are no errors. Put assumptions and open questions in `notes` for the person.",
  "6. Tell the person the draft is ready and give them the review link from the tool results. They create the session; you do not.",
  "",
  "Leave caps, model, memory and attachments out: the person sets them on the session page before initializing.",
];

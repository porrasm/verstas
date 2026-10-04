/**
 * What one in-container driver provides to the generic worker loop
 * (worker.ts): how to spawn the agent for a job, how to turn its output
 * lines into Verstas events, and what to do when it has exited. The loop
 * owns the caps, the signals and the `worker_done` line, so every driver
 * gets the same behaviour there for free.
 *
 * Dependency-free, like everything under src/worker: it ships inside the
 * image.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Translated } from "./translate.js";

export type Job = {
  role: "implementer" | "reviewer" | "planner" | "setup" | "prompt";
  ticket?: string;
  /** Which agent runs this job; absent means Claude Code. */
  driver?: "claude" | "codex" | "cursor";
  /** Path of the user prompt (the ticket, the context). */
  promptFile: string;
  /** Path of the procedure text appended to the system prompt. */
  systemPromptFile: string;
  caps: { minutes: number; turns: number; budgetUsd: number };
  /** The mcp config file the harness wrote; it names this image's board server. */
  mcpConfigFile: string;
  model?: string;
  /** Overrides the agent binary (tests on the host). */
  binary?: string;
  /** Older name of `binary`, kept for the Claude driver. */
  claudeBinary?: string;
  /** Defaults to /workspace; tests on the host point it elsewhere. */
  cwd?: string;
  /** Keep full tool output in events and echo the raw agent stream as `raw` lines. */
  debug?: boolean;
};

export type Spawned = {
  bin: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Written to the child's stdin, then stdin is closed. */
  stdin?: string;
};

/** Per job: `line` translates one output line; `end` gives a result when the stream ended without a terminal line. */
export type Translator = {
  line(line: string): Translated;
  end(): Translated["result"] | undefined;
};

export type DriverImpl = {
  name: "claude" | "codex" | "cursor";
  /** Candidate binary names on PATH, first found wins. */
  binaries: readonly string[];
  prepare(job: Job, prompt: string, system: string, bin: string): Promise<Spawned>;
  translator(job: Job): Translator;
  /** Matched against stderr when the stream gave no result; a hit means a rate limit, not a broken ticket. */
  stderrRateLimit: RegExp;
  /** After the agent exited: clean up, and hand back a refreshed credential when the agent rotated it. */
  finish?(job: Job): Promise<{ credential?: string } | undefined>;
};

/** The first of `names` found on PATH, as an absolute path; undefined when none is installed. */
export const findBinary = async (names: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> => {
  const dirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const name of names) {
    if (name.includes("/")) {
      if (await fs.access(name).then(() => true, () => false)) return name;
      continue;
    }
    for (const dir of dirs) {
      const full = path.join(dir, name);
      try {
        const st = await fs.stat(full);
        if (st.isFile()) return full;
      } catch {
        // not here
      }
    }
  }
  return undefined;
};

/** The rules and the task as one prompt, for agents without a system-prompt flag. */
export const combinedPrompt = (system: string, prompt: string): string => `${system.trim()}\n\n---\n\n${prompt}`;

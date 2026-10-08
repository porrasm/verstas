import { effectivePolicy, matchesAnyGlob, POLICY_FIELDS, type AgentPolicy, type EffectivePolicy, type PolicyProposal, type PolicySource, type RepoPolicyPatch, type RepoSpec, type ReviewMode, type Session, type Ticket } from "../core/types.js";

/**
 * The rules of judging a change that may touch any subset of a session's
 * repositories (docs/BOARD.md, "Judging"). Pure: the harness gathers what
 * changed and runs what these decide.
 */

/** What changed in one repository since the ticket started (or since HEAD, for a sweep). */
export type RepoChange = {
  repo: string;
  added: number;
  removed: number;
  files: number;
  stat: string;
  diff: string;
  paths: string[];
  /** Commits of this ticket's earlier attempts that other work came after; the diff above does not include them. */
  scattered: string[];
};

const RANK: Record<ReviewMode, number> = { none: 0, checks: 1, full: 2 };

/** One check the judge runs: whose, with which policy, and why it runs. */
export type PlannedCheck = { repo: RepoSpec; policy: EffectivePolicy; why: string };

/**
 * The checks for a change: each changed repository's own, plus the checks
 * of every repository a changed one lists in `alsoCheck`, in the session's
 * order, each once. A repository whose policy has no check runs nothing.
 * `override` replaces a repository's check command (a proposal under test).
 */
export const planChecks = (session: Pick<Session, "repos">, changed: readonly string[], override: ReadonlyMap<string, string | null> = new Map()): PlannedCheck[] => {
  const why = new Map<string, string>();
  for (const name of changed) {
    if (!why.has(name)) why.set(name, "changed");
    const r = session.repos.find((x) => x.name === name);
    if (!r) continue;
    for (const other of policyOf(r, override).alsoCheck) if (other !== name && !why.has(other) && session.repos.some((x) => x.name === other)) why.set(other, `${name} changed`);
  }
  for (const name of override.keys()) if (!why.has(name) && session.repos.some((x) => x.name === name)) why.set(name, "the ticket proposes a new check");
  return session.repos.filter((r) => why.has(r.name)).map((r) => ({ repo: r, policy: policyOf(r, override), why: why.get(r.name)! })).filter((c) => c.policy.check.kind !== "none");
};

/** A repository's policy with a proposed check command in place of its own (only where your own check does not apply). */
export const policyOf = (r: RepoSpec, override: ReadonlyMap<string, string | null> = new Map()): EffectivePolicy => {
  const p = effectivePolicy(r);
  if (!override.has(r.name) || p.checkFrom === "you") return p;
  const cmd = override.get(r.name);
  return effectivePolicy({ ...r, agentPolicy: { ...(r.agentPolicy ?? { setBy: {} }), check: cmd ?? null } });
};

/** Changed paths that are part of a check (its script, its config): "app/scripts/check.sh". */
export const guardHits = (session: Pick<Session, "repos">, changes: readonly RepoChange[]): string[] =>
  changes.flatMap((c) => {
    const r = session.repos.find((x) => x.name === c.repo);
    if (!r) return [];
    const globs = effectivePolicy(r).guardPaths;
    return globs.length ? c.paths.filter((p) => matchesAnyGlob(p, globs) || globs.includes(p)).map((p) => `${c.repo}/${p}`) : [];
  });

/**
 * How much judging a ticket's change needs. Your mode on the ticket wins.
 * Otherwise the strictest of the changed repositories (each its own review
 * setting, else the session's); a change to a check's files or a proposed
 * policy change needs the reviewer; nothing changed, the session's.
 */
export const reviewLevel = (
  ticket: Pick<Ticket, "review">,
  caps: { reviewer: boolean },
  session: Pick<Session, "repos">,
  changes: readonly RepoChange[],
  extra: { guarded: readonly string[]; proposals: readonly PolicyProposal[] },
): { mode: ReviewMode; why: string } => {
  if (ticket.review) return { mode: ticket.review, why: "the ticket's own setting" };
  const sessionMode: ReviewMode = caps.reviewer ? "full" : "checks";
  if (extra.guarded.length) return { mode: "full", why: `it changes the check's own files (${extra.guarded.slice(0, 4).join(", ")})` };
  if (extra.proposals.length) return { mode: "full", why: `it proposes a check policy change for ${[...new Set(extra.proposals.map((p) => p.repo))].join(", ")}` };
  if (!changes.length) return { mode: sessionMode, why: "nothing changed; the session's setting" };
  let best: { mode: ReviewMode; repo: string } | undefined;
  for (const c of changes) {
    const r = session.repos.find((x) => x.name === c.repo);
    const mode = (r && effectivePolicy(r).review) ?? sessionMode;
    if (!best || RANK[mode] > RANK[best.mode]) best = { mode, repo: c.repo };
  }
  return { mode: best!.mode, why: changes.length === 1 ? `${best!.repo}'s setting` : `the strictest of ${changes.map((c) => c.repo).join(", ")} (${best!.repo})` };
};

/**
 * This ticket's earlier attempts in one repository's history, newest first
 * (`git log --format=%H%x09%s`). `base` is the oldest of the attempts at the
 * top of the history (the ticket's commits since nothing else was
 * committed), so `git diff <base>^` is the whole ticket; `scattered` are
 * older attempts other commits came after.
 */
export const earlierAttempts = (log: string, ticketId: string): { base?: string; scattered: string[] } => {
  const mine = (subject: string) => subject.startsWith(`${ticketId} (`);
  const rows = log
    .split("\n")
    .map((l) => l.split("\t"))
    .filter((r): r is [string, string] => r.length >= 2 && /^[0-9a-f]{7,64}$/.test(r[0]!));
  let i = 0;
  let base: string | undefined;
  while (i < rows.length && mine(rows[i]![1])) base = rows[i++]![0];
  const scattered = rows.slice(i).filter((r) => mine(r[1])).map((r) => r[0].slice(0, 12));
  return { base, scattered };
};

/** "planned api; touched api, docs" when the ticket's expected repositories and the change differ, else undefined. */
export const plannedVsTouched = (planned: readonly string[], touched: readonly string[]): string | undefined => {
  if (!planned.length) return undefined;
  const same = planned.length === touched.length && planned.every((p) => touched.includes(p));
  if (same) return undefined;
  return `planned ${planned.join(", ")}; touched ${touched.join(", ") || "nothing"}`;
};

/** The repository fields you set, which no agent may change: a check of yours (or none), a review, an also-check list. */
export const lockedFields = (r: RepoSpec): string[] => [...(r.check || r.noCheck ? ["check"] : []), ...(r.review ? ["review"] : []), ...(r.alsoCheck ? ["alsoCheck"] : [])];

/** An agent's patch onto a repository's agent policy: fields you set are refused, the rest recorded with who and why. */
export const mergePolicy = (r: RepoSpec, patch: RepoPolicyPatch, source: PolicySource): { policy: AgentPolicy; changed: string[]; refused: string[] } => {
  const locked = lockedFields(r);
  const policy: AgentPolicy = { ...(r.agentPolicy ?? { setBy: {} }), setBy: { ...(r.agentPolicy?.setBy ?? {}) } };
  const changed: string[] = [];
  const refused: string[] = [];
  for (const f of POLICY_FIELDS) {
    if (patch[f] === undefined) continue;
    if (locked.includes(f)) {
      refused.push(f);
      continue;
    }
    (policy as Record<string, unknown>)[f] = patch[f];
    policy.setBy[f] = source;
    changed.push(`${f} ${JSON.stringify(patch[f])}`);
  }
  return { policy, changed, refused };
};

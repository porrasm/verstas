import { z } from "zod";
import type { WorkTarget } from "../config.js";
import type { SetupScript } from "../scripts/library.js";
import {
  addTickets,
  draftHostSchema,
  draftPackSchema,
  draftRepoSchema,
  DraftError,
  importIntoDraft,
  removeTickets,
  repoDirNames,
  ticketPatchSchema,
  ticketSummary,
  updateTicket,
  validateDraft,
  type Draft,
  type DraftEnv,
} from "./draft.js";
import type { DraftStore } from "./store.js";

/**
 * The tools an assistant gets through the draft MCP server. They read the
 * installation (work targets, recipes, the box) and edit drafts; nothing
 * here creates, starts or touches a session, and no tool runs anything in a
 * container. That is the whole point: a person reviews the draft in the app
 * and creates the session there (docs/DRAFTS.md).
 *
 * Every editing tool answers with the draft's problems, so an assistant can
 * fix them as it goes instead of finding out at the end.
 */

export type DraftTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  call: (args: Record<string, unknown>) => Promise<unknown>;
};

export type DraftToolDeps = {
  store: DraftStore;
  workTargets: () => readonly WorkTarget[];
  recipes: () => Promise<SetupScript[]>;
  branches: (repoPath: string) => Promise<{ current: string; branches: string[] }>;
  detectPacks: (repoPath: string) => Promise<string[]>;
  /** The Markdown from buildContext with the "draft" tail. */
  context: () => Promise<string>;
  /** Where a person reviews the draft, e.g. http://127.0.0.1:4700/#/d/<id>. */
  reviewUrl: (draftId: string) => string;
};

export const DRAFT_SERVER_INSTRUCTIONS =
  "Verstas draft sessions. Prepare a session for a person to review, step by step: a name, a goal, session requirements, repositories, network packs, recipes, notes and a board of tickets. You cannot create, start or run sessions: a person does that in the Verstas app from the review link these tools return. Call verstas_context first; it describes the sandbox, the board format and the workflow.";

const str = (description: string, maxLength = 20_000) => ({ type: "string", description, maxLength });
const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required, additionalProperties: false });
const draftIdProp = str("Draft id, from draft_create or draft_list", 90);
const ticketIdProp = str("Ticket id, e.g. T-3", 20);
const stringList = (description: string, maxItems: number, maxLength = 2000) => ({ type: "array", items: str(description, maxLength), maxItems });

const TICKET_FIELDS = {
  title: str("Short imperative title", 200),
  kind: { type: "string", enum: ["feature", "bug", "followup", "chore"] },
  repo: str("Directory name of one of the draft's repositories", 100),
  size: { type: "string", enum: ["S", "M", "L"], description: "S under half a day, M about a day, L several days (split L tickets when you can)" },
  priority: { type: "integer", minimum: 0, maximum: 1000, description: "Lower runs first" },
  deps: { type: "array", items: ticketIdProp, maxItems: 30, description: "Tickets that must be done first" },
  state: { type: "string", enum: ["ready", "backlog"], description: "ready runs when its deps are done; backlog waits for a person. Default ready" },
  spec: str("What to do, where (files, modules) and how to verify it. The worker sees only this, the acceptance criteria and recent reports", 50_000),
  acceptance: stringList("One criterion a reviewer can check by running or reading something", 30),
  notes: stringList("A note kept with the ticket", 10, 20_000),
  pinned: { type: "boolean", description: "Workers may not reprioritise or re-dep a pinned ticket" },
};

const ticketInputSchema = { ...obj({ id: str("Optional id T-<n> (must be free); leave out to get the next number", 20), ...TICKET_FIELDS }, ["title"]) };

const draftId = z.string().min(1).max(90);

const parseArgs = <T extends z.ZodType>(schema: T, args: unknown): z.infer<T> => {
  const r = schema.safeParse(args);
  if (!r.success) throw new DraftError(`Invalid arguments: ${r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`, "invalid");
  return r.data;
};

export const createDraftTools = (d: DraftToolDeps): DraftTool[] => {
  const env = async (): Promise<DraftEnv> => ({ workTargets: d.workTargets(), recipes: (await d.recipes()).map((r) => r.name) });
  const problemsOf = async (draft: Draft) => validateDraft(draft, await env());

  /** What every editing tool answers: short enough to read after each step. */
  const edited = async (draft: Draft, extra: Record<string, unknown> = {}) => {
    const problems = await problemsOf(draft);
    return { ok: true, id: draft.id, ...extra, tickets: draft.tickets.length, problems, reviewUrl: d.reviewUrl(draft.id) };
  };

  const view = async (draft: Draft, full: boolean) => {
    const { tickets, verstasDraft: _v, ...rest } = draft;
    return {
      ...rest,
      reviewUrl: d.reviewUrl(draft.id),
      tickets: full ? tickets : tickets.map(ticketSummary),
      problems: await problemsOf(draft),
    };
  };

  return [
    {
      name: "verstas_context",
      description: "Read first. The sandbox the session will run in (OS, tools, network rules, services), the recipe library, the board format, network packs, and how to prepare a draft step by step.",
      inputSchema: obj({}, []),
      call: () => d.context(),
    },
    {
      name: "list_repositories",
      description: "Work targets configured in Verstas: the repositories a session can clone, with their branches and the network packs their manifests imply. A draft can only use these; a person adds new ones in Settings.",
      inputSchema: obj({}, []),
      call: async () =>
        Promise.all(
          d.workTargets().map(async (w) => {
            const b = await d.branches(w.path).catch(() => ({ current: "", branches: [] as string[] }));
            return { name: w.name, currentBranch: b.current, branches: b.branches.slice(0, 40), impliedPacks: (await d.detectPacks(w.path).catch(() => [])).filter((p) => p !== "anthropic") };
          }),
        ),
    },
    {
      name: "list_recipes",
      description: "The recipe library: named setup scripts that run once when a session's container is created. A draft picks recipes by name; it cannot add new ones.",
      inputSchema: obj({ includeScripts: { type: "boolean", description: "Also return each script's text" } }, []),
      call: async (a) => {
        const { includeScripts } = parseArgs(z.object({ includeScripts: z.boolean().optional() }), a);
        return (await d.recipes()).map((r) => ({ name: r.name, description: r.description, hosts: r.hosts, note: r.note, runAs: r.runAs, ...(includeScripts ? { script: r.script } : {}) }));
      },
    },
    {
      name: "draft_list",
      description: "List the drafts with their ticket counts and problem counts. Drafts that already became sessions say so and are read-only.",
      inputSchema: obj({}, []),
      call: async () => {
        const e = await env();
        return (await d.store.list()).map((x) => {
          const p = validateDraft(x, e);
          return { id: x.id, name: x.name, tickets: x.tickets.length, errors: p.errors.length, warnings: p.warnings.length, updatedAt: x.updatedAt, promotedTo: x.promotedTo, reviewUrl: d.reviewUrl(x.id) };
        });
      },
    },
    {
      name: "draft_get",
      description: "One draft: every field, the tickets (one line each unless full is true) and its problems.",
      inputSchema: obj({ id: draftIdProp, full: { type: "boolean", description: "Return every ticket in full (spec and acceptance)" } }, ["id"]),
      call: async (a) => {
        const { id, full } = parseArgs(z.object({ id: draftId, full: z.boolean().optional() }), a);
        return view(await d.store.get(id), full ?? false);
      },
    },
    {
      name: "draft_get_ticket",
      description: "One ticket of a draft in full.",
      inputSchema: obj({ id: draftIdProp, ticketId: ticketIdProp }, ["id", "ticketId"]),
      call: async (a) => {
        const { id, ticketId } = parseArgs(z.object({ id: draftId, ticketId: z.string() }), a);
        const t = (await d.store.get(id)).tickets.find((x) => x.id === ticketId);
        if (!t) throw new DraftError(`No ticket ${ticketId} in draft ${id}`, "not_found");
        return t;
      },
    },
    {
      name: "draft_create",
      description: "Start a new draft session with a name and, ideally, the goal. Returns its id and the link where a person reviews it.",
      inputSchema: obj({ name: str("Short name, e.g. \"Nuppi MVP\"", 200), goal: str("What the session should achieve and what done looks like; workers read it on every ticket") }, ["name"]),
      call: async (a) => {
        const { name, goal } = parseArgs(z.object({ name: z.string().trim().min(1).max(200), goal: z.string().max(20_000).optional() }), a);
        const draft = await d.store.create({ name, goal, createdBy: "agent" });
        return edited(draft);
      },
    },
    {
      name: "draft_update",
      description: "Change a draft's name, goal, session requirements or notes. Fields left out stay as they are. Requirements: one verifiable line per need; a setup worker makes the box meet them before tickets run. Notes are for the person who reviews the draft.",
      inputSchema: obj(
        {
          id: draftIdProp,
          name: str("Name", 200),
          goal: str("Goal"),
          requirements: str("Session requirements, one per line, e.g. \"Chromium for Playwright launches\""),
          notes: str("For the reviewer: assumptions, open questions, what you left out"),
        },
        ["id"],
      ),
      call: async (a) => {
        const { id, ...patch } = parseArgs(
          z.object({ id: draftId, name: z.string().trim().min(1).max(200).optional(), goal: z.string().max(20_000).optional(), requirements: z.string().max(20_000).optional(), notes: z.string().max(20_000).optional() }),
          a,
        );
        const { draft } = await d.store.mutate(id, (x) => ({ draft: { ...x, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } }));
        return edited(draft);
      },
    },
    {
      name: "draft_set_repositories",
      description: "Set the repositories the session clones (replaces the list). Each is a work target from list_repositories, optionally a branch and a directory name. Tickets name a repository by its directory name. Answers with the packs these repositories imply; apply them with draft_set_network.",
      inputSchema: obj(
        {
          id: draftIdProp,
          repos: {
            type: "array",
            maxItems: 20,
            items: obj({ target: str("Work target name", 64), branch: str("Branch to clone; the checked-out one when left out", 200), name: str("Directory under /workspace; the target name when left out", 64) }, ["target"]),
          },
        },
        ["id", "repos"],
      ),
      call: async (a) => {
        const { id, repos } = parseArgs(z.object({ id: draftId, repos: z.array(draftRepoSchema).max(20) }), a);
        const targets = d.workTargets();
        const implied = new Set<string>();
        for (const r of repos) {
          const t = targets.find((w) => w.name === r.target);
          if (!t) throw new DraftError(`"${r.target}" is not a work target. Known: ${targets.map((w) => w.name).join(", ") || "none (a person adds them in Settings)"}`, "invalid");
          if (r.branch) {
            const b = await d.branches(t.path).catch(() => ({ current: "", branches: [] as string[] }));
            if (!b.branches.includes(r.branch)) throw new DraftError(`${r.target} has no branch "${r.branch}". Branches: ${b.branches.slice(0, 20).join(", ")}`, "invalid");
          }
          for (const p of await d.detectPacks(t.path).catch(() => [])) if (p !== "anthropic") implied.add(p);
        }
        const { draft } = await d.store.mutate(id, (x) => ({ draft: { ...x, repos } }));
        const missing = [...implied].filter((p) => !(draft.packs as string[]).includes(p));
        return edited(draft, { directories: repoDirNames(draft), impliedPacks: [...implied], ...(missing.length ? { hint: `The repositories imply packs not in the draft yet: ${missing.join(", ")}` } : {}) });
      },
    },
    {
      name: "draft_set_network",
      description: "Set the network packs (replaces the list) and extra hosts the session may reach over HTTPS. The Claude API is always on; do not list it. Pack names are in verstas_context.",
      inputSchema: obj({ id: draftIdProp, packs: { type: "array", items: str("Pack name", 40), maxItems: 20 }, extraHosts: stringList("hostname or *.suffix", 100, 260) }, ["id", "packs"]),
      call: async (a) => {
        const { id, packs, extraHosts } = parseArgs(z.object({ id: draftId, packs: z.array(draftPackSchema).max(20), extraHosts: z.array(draftHostSchema).max(100).optional() }), a);
        const { draft } = await d.store.mutate(id, (x) => ({ draft: { ...x, packs: [...new Set(packs)], extraHosts: extraHosts ? [...new Set(extraHosts)] : x.extraHosts } }));
        return edited(draft);
      },
    },
    {
      name: "draft_set_recipes",
      description: "Set the library recipes the session's container runs at creation, in order (replaces the list). Names from list_recipes.",
      inputSchema: obj({ id: draftIdProp, recipes: stringList("Recipe name", 30, 64) }, ["id", "recipes"]),
      call: async (a) => {
        const { id, recipes } = parseArgs(z.object({ id: draftId, recipes: z.array(z.string()).max(30) }), a);
        const known = (await d.recipes()).map((r) => r.name);
        const unknown = recipes.filter((r) => !known.includes(r));
        if (unknown.length) throw new DraftError(`Not in the library: ${unknown.join(", ")}. Known: ${known.join(", ") || "none"}`, "invalid");
        const { draft } = await d.store.mutate(id, (x) => ({ draft: { ...x, recipes } }));
        return edited(draft);
      },
    },
    {
      name: "draft_add_tickets",
      description: "Append up to 20 tickets. Give ids to reference tickets of the same batch in deps, or leave ids out to get the next numbers. A dependency on a ticket you add later is allowed and shows as a problem until it exists.",
      inputSchema: obj({ id: draftIdProp, tickets: { type: "array", items: ticketInputSchema, minItems: 1, maxItems: 20 } }, ["id", "tickets"]),
      call: async (a) => {
        const { id, tickets } = parseArgs(z.object({ id: draftId, tickets: z.array(z.record(z.string(), z.unknown())).min(1).max(20) }), a);
        const { draft, result } = await d.store.mutate(id, (x) => {
          const r = addTickets(x, tickets as never);
          return { draft: r.draft, result: r.ids };
        });
        return edited(draft, { added: result });
      },
    },
    {
      name: "draft_update_ticket",
      description: "Change fields of one ticket; fields left out stay as they are. Arrays (deps, acceptance, notes) are replaced, not appended.",
      inputSchema: obj({ id: draftIdProp, ticketId: ticketIdProp, ...TICKET_FIELDS }, ["id", "ticketId"]),
      call: async (a) => {
        const { id, ticketId, ...patch } = parseArgs(ticketPatchSchema.extend({ id: draftId, ticketId: z.string() }), a);
        const { draft } = await d.store.mutate(id, (x) => ({ draft: updateTicket(x, ticketId, patch) }));
        return edited(draft, { updated: ticketId });
      },
    },
    {
      name: "draft_remove_tickets",
      description: "Remove tickets. Other tickets that depended on them lose that dependency; the answer lists which.",
      inputSchema: obj({ id: draftIdProp, ticketIds: { type: "array", items: ticketIdProp, minItems: 1, maxItems: 100 } }, ["id", "ticketIds"]),
      call: async (a) => {
        const { id, ticketIds } = parseArgs(z.object({ id: draftId, ticketIds: z.array(z.string()).min(1).max(100) }), a);
        const { draft, result } = await d.store.mutate(id, (x) => {
          const r = removeTickets(x, ticketIds);
          return { draft: r.draft, result: r };
        });
        return edited(draft, { removed: result.removed, depsDropped: result.depsDropped });
      },
    },
    {
      name: "draft_import_board",
      description: "Bring in a whole board at once: JSON (the board format) or the markdown form. mode \"merge\" updates tickets whose id exists and appends the rest; \"replace\" clears the tickets first. A goal in the board replaces the draft's goal. Prefer draft_add_tickets for building a board step by step.",
      inputSchema: obj({ id: draftIdProp, board: str("The board as JSON or markdown", 2_000_000), mode: { type: "string", enum: ["merge", "replace"] } }, ["id", "board", "mode"]),
      call: async (a) => {
        const { id, board, mode } = parseArgs(z.object({ id: draftId, board: z.string().min(1).max(2_000_000), mode: z.enum(["merge", "replace"]) }), a);
        const { draft, result } = await d.store.mutate(id, (x) => {
          const r = importIntoDraft(x, board, mode);
          return { draft: r.draft, result: { created: r.created, updated: r.updated } };
        });
        return edited(draft, result);
      },
    },
    {
      name: "draft_validate",
      description: "Check a draft the way creating the session would: errors block creation, warnings point at weak tickets. ready is true when there are no errors.",
      inputSchema: obj({ id: draftIdProp }, ["id"]),
      call: async (a) => {
        const { id } = parseArgs(z.object({ id: draftId }), a);
        const draft = await d.store.get(id);
        const problems = await problemsOf(draft);
        return { id, ready: problems.errors.length === 0, ...problems, reviewUrl: d.reviewUrl(id), ...(draft.promotedTo ? { promotedTo: draft.promotedTo } : {}) };
      },
    },
  ];
};

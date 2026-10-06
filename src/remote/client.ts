import { promises as fs } from "node:fs";
import path from "node:path";
import type { Config } from "../config.js";
import { isInitialized, type Run, type VerstasEvent } from "../core/types.js";
import type { SessionHub } from "../sessions/hub.js";
import { allRuns, runTotals } from "../sessions/runs.js";
import { remoteCommandSchema, toApiCall, type ApiCall } from "./commands.js";
import { HttpError, requestJson } from "./http.js";
import { flattenEvent, REMOTE_EVENTS, REMOTE_PROTOCOL, remoteSession, type RemoteEvent } from "./view.js";

/**
 * The remote dashboard's connection, from this side. While it is turned on
 * and has a URL and a token, it:
 *   - pushes the sessions you shared (and only those) a second after any
 *     change, and every 15 s so the relay knows we are alive;
 *   - long-polls the relay for your actions, checks each one, carries it out
 *     through the local UI API, and posts the result back;
 *   - tells the relay when it stops, so the dashboard shows "not running"
 *     at once instead of a minute later.
 * Everything goes out through one outbound HTTPS connection; nothing on
 * this machine listens for the relay. See docs/REMOTE.md.
 */

export const HOST_API = "/api/verstas/host";
const PUSH_DEBOUNCE_MS = 1_000;
const HEARTBEAT_MS = 15_000;
const POLL_WAIT_S = 25;
const BACKOFF_MS = [2_000, 5_000, 15_000, 30_000, 60_000];

export type RemoteStatus = {
  state: "off" | "unconfigured" | "connecting" | "connected" | "error";
  error?: string;
  lastPushAt?: string;
  lastCommandAt?: string;
  shared: number;
};

export type RemoteClientDeps = {
  hub: SessionHub;
  runs: { status(sessionId: string): Run | undefined };
  listSessionIds: () => Promise<string[]>;
  getConfig: () => Config;
  getToken: () => Promise<string | undefined>;
  /** Calls the local UI API (path relative to /api) and returns its status and JSON body. */
  localApi: (call: ApiCall) => Promise<{ status: number; body: unknown }>;
  version: string;
  log?: (msg: string) => void;
};

type Ring = { runId: number | null; seeded: boolean; events: RemoteEvent[] };

export class RemoteClient {
  private running = false;
  private generation = 0;
  private abort: AbortController | null = null;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private pushing: Promise<void> | null = null;
  private pushAgain = false;
  private rings = new Map<string, Ring>();
  /** Sessions in the last push: unsharing one must push once more so it disappears. */
  private pushed = new Set<string>();
  /** Where we are connected, kept so stopping says goodbye to the right relay after the settings changed. */
  private target: { baseUrl: string; token: string } | null = null;
  private st: RemoteStatus = { state: "off", shared: 0 };
  private readonly onChange = (c: { sessionId: string }) => this.onSessionActivity(c.sessionId);
  private readonly onEvent = (e: { sessionId: string; runId: number; event: VerstasEvent }) => this.onRunEvent(e);

  constructor(private readonly d: RemoteClientDeps) {}

  status(): RemoteStatus {
    return { ...this.st };
  }

  /** (Re)reads the settings and starts or stops accordingly. Safe to call any time. */
  async apply(): Promise<void> {
    await this.stop();
    const cfg = this.d.getConfig().remote;
    if (!cfg.enabled) {
      this.st = { state: "off", shared: 0 };
      return;
    }
    const token = await this.d.getToken();
    if (!cfg.baseUrl || !token) {
      this.st = { state: "unconfigured", shared: 0, error: !cfg.baseUrl ? "No base URL" : "No token" };
      return;
    }
    this.running = true;
    this.target = { baseUrl: cfg.baseUrl, token };
    const gen = ++this.generation;
    this.abort = new AbortController();
    this.st = { state: "connecting", shared: 0 };
    this.d.hub.on("change", this.onChange);
    this.d.hub.on("event", this.onEvent);
    this.heartbeat = setInterval(() => this.schedulePush(0), HEARTBEAT_MS);
    this.schedulePush(0);
    void this.pollLoop(gen, cfg.baseUrl, token);
  }

  /** Stops pushing and polling; with `leave` (the default), tells the relay this host is gone. */
  async stop(opts: { leave: boolean } = { leave: true }): Promise<void> {
    const was = this.running;
    this.running = false;
    this.generation++;
    this.abort?.abort();
    this.abort = null;
    if (this.pushTimer) clearTimeout(this.pushTimer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.pushTimer = null;
    this.heartbeat = null;
    this.d.hub.off("change", this.onChange);
    this.d.hub.off("event", this.onEvent);
    await this.pushing?.catch(() => undefined);
    const target = this.target;
    this.target = null;
    this.pushed.clear();
    if (was && opts.leave && target) await requestJson(this.url(target.baseUrl, "/state"), { method: "DELETE", token: target.token, timeoutMs: 3_000 }).catch(() => undefined);
    this.st = { state: "off", shared: 0 };
  }

  /** One-off check for the settings page: does this URL and token reach a relay that knows us? */
  static async test(baseUrl: string, token: string): Promise<{ ok: boolean; name?: string; error?: string }> {
    try {
      const r = await requestJson(new URL(`${HOST_API}/hello`, baseUrl).toString(), { token, timeoutMs: 10_000 });
      if (r.status === 404) return { ok: false, error: "The dashboard does not know this token (or the URL is not a Verstas dashboard)" };
      if (r.status !== 200) return { ok: false, error: `HTTP ${r.status}` };
      const body = r.body as { name?: string; protocol?: number };
      if (body.protocol !== REMOTE_PROTOCOL) return { ok: false, error: `The dashboard speaks protocol ${body.protocol}; this Verstas speaks ${REMOTE_PROTOCOL}` };
      return { ok: true, name: body.name };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  // ---- state

  private url(base: string, p: string): string {
    return new URL(`${HOST_API}${p}`, base).toString();
  }

  private onSessionActivity(sessionId: string) {
    if (this.pushed.has(sessionId)) return this.schedulePush(PUSH_DEBOUNCE_MS);
    void this.isShared(sessionId).then((shared) => shared && this.schedulePush(PUSH_DEBOUNCE_MS));
  }

  private onRunEvent(e: { sessionId: string; runId: number; event: VerstasEvent }) {
    const ring = this.rings.get(e.sessionId);
    if (ring?.seeded) {
      if (ring.runId !== e.runId) {
        ring.runId = e.runId;
        ring.events = [];
      }
      const f = flattenEvent(e.event);
      if (f) {
        ring.events.push(f);
        if (ring.events.length > REMOTE_EVENTS) ring.events.splice(0, ring.events.length - REMOTE_EVENTS);
      }
    }
    if (e.event.kind !== "tool_result" && e.event.kind !== "cost") this.onSessionActivity(e.sessionId);
  }

  private async isShared(sessionId: string): Promise<boolean> {
    try {
      const s = (await this.d.hub.get(sessionId)).session;
      return s.remote && isInitialized(s);
    } catch {
      return false;
    }
  }

  /** The last run's events, read once per session; live events are appended after that. */
  private async events(sessionId: string, runsDir: string, live: Run | undefined, last: Run | undefined): Promise<RemoteEvent[]> {
    let ring = this.rings.get(sessionId);
    if (!ring) {
      ring = { runId: null, seeded: false, events: [] };
      this.rings.set(sessionId, ring);
    }
    if (!ring.seeded) {
      const runId = live?.id ?? last?.id ?? null;
      ring.runId = runId;
      ring.seeded = true;
      if (runId) {
        const raw = await fs.readFile(path.join(runsDir, String(runId), "events.jsonl"), "utf8").catch(() => "");
        const lines = raw.split("\n").filter(Boolean).slice(-2000);
        const flat: RemoteEvent[] = [];
        for (const l of lines) {
          try {
            const f = flattenEvent(JSON.parse(l) as VerstasEvent);
            if (f) flat.push(f);
          } catch {
            continue;
          }
        }
        ring.events = [...flat.slice(-REMOTE_EVENTS), ...ring.events];
      }
    }
    return ring.events;
  }

  /** Every shared session, as the dashboard shows it. Exported for tests through build(). */
  async build() {
    const sessions = [];
    for (const id of await this.d.listSessionIds()) {
      let h;
      try {
        h = await this.d.hub.get(id);
      } catch {
        continue;
      }
      // A plan is not sent: there is nothing to run or watch until it is initialized.
      if (!h.session.remote || !isInitialized(h.session)) {
        this.rings.delete(id);
        continue;
      }
      const runs = await allRuns(h.paths.runs);
      const live = this.d.runs.status(id);
      const all = live ? [...runs.filter((r) => r.id !== live.id), live] : runs;
      const run = live ?? runs[runs.length - 1];
      const docs = h.snapshot();
      sessions.push(
        remoteSession({
          ...docs,
          run,
          active: Boolean(live),
          totals: runTotals(all, h.session.createdAt),
          events: await this.events(id, h.paths.runs, live, runs[runs.length - 1]),
        }),
      );
    }
    return { protocol: REMOTE_PROTOCOL, host: { version: this.d.version, sentAt: new Date().toISOString() }, sessions };
  }

  private schedulePush(delayMs: number) {
    if (!this.running) return;
    if (this.pushTimer) {
      if (delayMs > 0) return; // one is coming
      clearTimeout(this.pushTimer);
    }
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      void this.push();
    }, delayMs);
  }

  private async push(): Promise<void> {
    if (this.pushing) {
      this.pushAgain = true;
      return;
    }
    const gen = this.generation;
    this.pushing = (async () => {
      try {
        const target = this.target;
        if (!target) return;
        const state = await this.build();
        if (gen !== this.generation) return;
        const r = await requestJson(this.url(target.baseUrl, "/state"), { method: "POST", token: target.token, body: state, timeoutMs: 20_000 });
        if (gen !== this.generation) return;
        if (r.status !== 200) throw new HttpError(r.status, describe(r));
        this.pushed = new Set(state.sessions.map((x) => x.id));
        this.st = { ...this.st, state: "connected", error: undefined, lastPushAt: new Date().toISOString(), shared: state.sessions.length };
      } catch (e) {
        if (gen === this.generation) this.fail(e as Error);
      }
    })();
    await this.pushing;
    this.pushing = null;
    if (this.pushAgain && this.running) {
      this.pushAgain = false;
      this.schedulePush(0);
    }
  }

  private async pushNow(): Promise<void> {
    if (this.pushTimer) {
      clearTimeout(this.pushTimer);
      this.pushTimer = null;
    }
    while (this.pushing) await this.pushing.catch(() => undefined);
    await this.push();
  }

  private fail(e: Error) {
    const msg = e instanceof HttpError && e.status === 404 ? "The dashboard does not know this token" : e.message;
    if (this.st.error !== msg) this.d.log?.(`[remote] ${msg}`);
    this.st = { ...this.st, state: "error", error: msg };
  }

  // ---- commands

  private async pollLoop(gen: number, baseUrl: string, token: string) {
    let failures = 0;
    while (this.running && gen === this.generation) {
      try {
        const r = await requestJson(this.url(baseUrl, `/commands?wait=${POLL_WAIT_S}`), { token, timeoutMs: (POLL_WAIT_S + 10) * 1000, signal: this.abort?.signal });
        if (gen !== this.generation) return;
        if (r.status !== 200) throw new HttpError(r.status, describe(r));
        failures = 0;
        const body = r.body as { commands?: { id: string; kind: string; payload: unknown }[]; needState?: boolean };
        if (body.needState) this.schedulePush(0);
        for (const c of body.commands ?? []) {
          const result = await this.execute(c);
          this.st = { ...this.st, lastCommandAt: new Date().toISOString() };
          // Push the new state before answering, so the dashboard that
          // refetches on the answer already sees what the command changed.
          if (result.ok) await this.pushNow();
          await requestJson(this.url(baseUrl, `/commands/${encodeURIComponent(c.id)}`), { method: "POST", token, body: result, timeoutMs: 15_000 }).catch((e: Error) => this.fail(e));
        }
      } catch (e) {
        if (gen !== this.generation) return;
        this.fail(e as Error);
        const wait = BACKOFF_MS[Math.min(failures++, BACKOFF_MS.length - 1)];
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }

  /** Checks one command and carries it out through the local UI API. */
  async execute(raw: { kind: string; payload: unknown }): Promise<{ ok: boolean; status?: number; error?: string; result?: unknown }> {
    const parsed = remoteCommandSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, status: 400, error: `Verstas does not accept that command: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ").slice(0, 500)}` };
    const cmd = parsed.data;
    if (!(await this.isShared(cmd.payload.sessionId))) return { ok: false, status: 403, error: "That session is not shared with the remote dashboard" };
    const call = toApiCall(cmd);
    try {
      const r = await this.d.localApi(call);
      this.d.log?.(`[remote] ${cmd.kind} ${cmd.payload.sessionId}: ${r.status}`);
      const body = r.body as { error?: string } | null;
      if (r.status >= 300) return { ok: false, status: r.status, error: body?.error ?? `HTTP ${r.status}` };
      return { ok: true, status: r.status };
    } catch (e) {
      return { ok: false, status: 500, error: (e as Error).message };
    }
  }
}

const describe = (r: { status: number; body: unknown }): string => {
  const b = r.body as { error?: string } | string | null;
  const msg = typeof b === "string" ? b.slice(0, 200) : b?.error;
  return `HTTP ${r.status}${msg ? `: ${msg}` : ""}`;
};

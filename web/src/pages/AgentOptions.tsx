import { useEffect, useState } from "react";
import { agentFor, api, type AgentSpec, type DriverInfo, type DriverName, type SessionAgents, type Status } from "../api";

/**
 * "Agent options": which coding agent runs the worker, which runs the
 * reviewer, and their models. Used on the New Session form and on the
 * Session page (where a change applies to the next worker that starts).
 * Claude Code is the default; a driver without a credential or without its
 * CLI in the image is still selectable, with a warning, so the choice is
 * never blocked by a half-configured machine.
 */

/** Drivers as /status lists them; empty until loaded, Claude-only on failure so the form still works. */
export const useDrivers = (): DriverInfo[] => {
  const [drivers, setDrivers] = useState<DriverInfo[]>([]);
  useEffect(() => {
    api<Status>("GET", "/status")
      .then((s) => setDrivers(s.drivers ?? []))
      .catch(() => setDrivers([{ name: "claude", title: "Claude Code", models: [], hint: "", reportsCost: true, configured: true }]));
  }, []);
  return drivers;
};

const title = (drivers: DriverInfo[], d: DriverName) => drivers.find((x) => x.name === d)?.title ?? d;

/** One line for the summary: "Claude Code · claude-sonnet-5-5 · reviewer: Codex (gpt-5.1-codex)". */
export const describeAgents = (s: { model?: string; agents?: SessionAgents }, drivers: DriverInfo[], reviewerOn = true): string => {
  const w = agentFor(s, "implementer");
  const r = agentFor(s, "reviewer");
  const one = (a: AgentSpec) => `${title(drivers, a.driver)}${a.model ? ` · ${a.model}` : ""}`;
  const same = r.driver === w.driver && (r.model ?? "") === (w.model ?? "");
  if (!reviewerOn) return `${one(w)} · no reviewer`;
  return same ? `${one(w)} · reviewer: same` : `${one(w)} · reviewer: ${one(r)}`;
};

const AgentRow = ({ id, label, value, drivers, onChange }: { id: string; label: string; value: AgentSpec; drivers: DriverInfo[]; onChange: (a: AgentSpec) => void }) => {
  const info = drivers.find((d) => d.name === value.driver);
  return (
    <div className="two">
      <label>
        {label}
        <select id={`${id}-driver`} value={value.driver} onChange={(e) => onChange({ driver: e.target.value as DriverName, model: undefined })}>
          {drivers.map((d) => (
            <option key={d.name} value={d.name}>
              {d.title}
              {d.configured ? "" : " (no credential)"}
            </option>
          ))}
        </select>
      </label>
      <label>
        Model <span className="help">Any id the CLI accepts; empty uses the account's default</span>
        <input id={`${id}-model`} className="mono" list={`${id}-models`} value={value.model ?? ""} onChange={(e) => onChange({ ...value, model: e.target.value || undefined })} placeholder="account default" />
        <datalist id={`${id}-models`}>{(info?.models ?? []).map((m) => <option key={m} value={m} />)}</datalist>
      </label>
    </div>
  );
};

const Warnings = ({ agents, drivers, reviewerOn }: { agents: SessionAgents; drivers: DriverInfo[]; reviewerOn: boolean }) => {
  const used = [agentFor({ agents }, "implementer").driver, ...(reviewerOn ? [agentFor({ agents }, "reviewer").driver] : [])];
  const infos = [...new Set(used)].map((d) => drivers.find((x) => x.name === d)).filter((x): x is DriverInfo => Boolean(x));
  const missing = infos.filter((d) => !d.configured);
  const noCost = infos.filter((d) => !d.reportsCost);
  if (!missing.length && !noCost.length) return null;
  return (
    <div className="small" style={{ display: "grid", gap: 6 }}>
      {missing.map((d) => (
        <div key={d.name} className="banner warn" style={{ margin: 0 }}>
          <span>
            <strong>{d.title}</strong> has no credential yet, so a worker on it fails to start. {d.hint} <a href="#/settings">Open Settings</a>.
          </span>
        </div>
      ))}
      {noCost.length > 0 && (
        <div className="muted">
          {noCost.map((d) => d.title).join(" and ")} {noCost.length > 1 ? "report" : "reports"} no price, so the budget cap per worker does not apply there; the time and turn caps still do. The hard stop is your subscription's limit with any extra usage turned off in the vendor's account settings.
        </div>
      )}
    </div>
  );
};

export const AgentOptionsDialog = ({ agents, reviewerOn = true, onSave, onClose }: { agents: SessionAgents; reviewerOn?: boolean; onSave: (a: SessionAgents) => void; onClose: () => void }) => {
  const drivers = useDrivers();
  const [worker, setWorker] = useState<AgentSpec>(agentFor({ agents }, "implementer"));
  const [reviewer, setReviewer] = useState<AgentSpec | null>(agents.reviewer ?? null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [onClose]);
  const draft: SessionAgents = { worker, ...(reviewer ? { reviewer } : {}) };
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()} role="dialog" aria-modal="true" aria-labelledby="agent-options-title">
      <div className="dialog">
        <h3 id="agent-options-title">Agent options</h3>
        <p className="lead" style={{ margin: 0 }}>
          The worker runs the planner, the setup pass, prompts and every implementer. The reviewer judges each ticket's diff; a different agent there gives a second opinion. Every agent uses the same board tools and rules.
        </p>
        <AgentRow id="worker" label="Worker" value={worker} drivers={drivers} onChange={setWorker} />
        {reviewerOn && (
          <>
            <label className="chk">
              <input type="checkbox" checked={reviewer === null} onChange={(e) => setReviewer(e.target.checked ? null : { ...worker })} /> Reviewer uses the same agent as the worker
            </label>
            {reviewer && <AgentRow id="reviewer" label="Reviewer" value={reviewer} drivers={drivers} onChange={setReviewer} />}
          </>
        )}
        <Warnings agents={draft} drivers={drivers} reviewerOn={reviewerOn} />
        <div className="actions">
          <button className="quiet" onClick={onClose}>Cancel</button>
          <button className="pri" onClick={() => onSave(draft)}>Save</button>
        </div>
      </div>
    </div>
  );
};

/** The summary line plus the button that opens the dialog; `legacyModel` keeps old sessions' model visible. */
export const AgentOptionsButton = ({ agents, legacyModel, reviewerOn = true, onChange, compact = false, title: tip }: { agents: SessionAgents; legacyModel?: string; reviewerOn?: boolean; onChange: (a: SessionAgents) => void; compact?: boolean; title?: string }) => {
  const [open, setOpen] = useState(false);
  const drivers = useDrivers();
  const text = describeAgents({ agents, model: legacyModel }, drivers, reviewerOn);
  return (
    <>
      {compact ? (
        <span title={tip}>
          agents <b>{text}</b> <button className="quiet sm" onClick={() => setOpen(true)}>Agent options…</button>
        </span>
      ) : (
        <label>
          Agents <span className="help">Which coding agent does the work and which reviews it</span>
          <div className="row">
            <span className="mono small grow">{text}</span>
            <button id="agent-options" type="button" onClick={() => setOpen(true)}>Agent options…</button>
          </div>
        </label>
      )}
      {open && (
        <AgentOptionsDialog
          agents={legacyModel && !agents.worker ? { ...agents, worker: { driver: "claude", model: legacyModel } } : agents}
          reviewerOn={reviewerOn}
          onClose={() => setOpen(false)}
          onSave={(a) => {
            onChange(a);
            setOpen(false);
          }}
        />
      )}
    </>
  );
};

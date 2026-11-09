import { useEffect, useState } from "react";
import { api, fmtAgo, type GoalTemplate } from "../api";

const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9 ._&+-]{0,62}[A-Za-z0-9._&+-])?$/;
const LAST_PICK = "verstas.goalTemplate";

/** The template picked last in a New work dialog, so the next one starts there. */
export const lastTemplatePick = (): string | null => {
  try {
    return localStorage.getItem(LAST_PICK);
  } catch {
    return null;
  }
};
export const rememberTemplatePick = (name: string | null): void => {
  try {
    if (name) localStorage.setItem(LAST_PICK, name);
    else localStorage.removeItem(LAST_PICK);
  } catch {
    // Storage is a convenience; without it the dialog starts at "none".
  }
};

/** The library, loaded once per mount; `reload` after a change. */
export const useGoalTemplates = (): { templates: GoalTemplate[] | null; reload: () => Promise<void> } => {
  const [templates, setTemplates] = useState<GoalTemplate[] | null>(null);
  const reload = () => api<GoalTemplate[]>("GET", "/templates").then(setTemplates).catch(() => setTemplates([]));
  useEffect(() => {
    void reload();
  }, []);
  return { templates, reload };
};

/**
 * The dropdown that picks a session's goal template. A name the library no
 * longer has stays in the list, marked, so a deleted template is visible
 * instead of silently none.
 */
export const TemplateSelect = ({ value, templates, onChange, disabled, id }: { value: string | null; templates: GoalTemplate[] | null; onChange: (name: string | null) => void; disabled?: boolean; id?: string }) => {
  const missing = value && templates && !templates.some((t) => t.name === value);
  return (
    <select id={id} value={value ?? ""} onChange={(e) => onChange(e.target.value || null)} disabled={disabled || templates === null}>
      <option value="">No template</option>
      {(templates ?? []).map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
      {missing && <option value={value}>{value} (no longer exists)</option>}
    </select>
  );
};

/**
 * Settings, Goal templates: text you write once and pick per session, saying
 * how the work should be done, so a goal says only what to do. Sessions
 * store the name and read the text at every lead life and review; the editor
 * says which sessions an edit reaches before you save it.
 */
export const GoalTemplates = ({ ok, fail }: { ok: (text: string) => void; fail: (e: unknown) => void }) => {
  const { templates, reload } = useGoalTemplates();
  const [editing, setEditing] = useState<{ name: string; text: string; existing: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const current = editing?.existing ? templates?.find((t) => t.name === editing.name) : undefined;
  const usedBy = current?.usedBy ?? [];
  const nameTaken = Boolean(editing && !editing.existing && templates?.some((t) => t.name.toLowerCase() === editing.name.trim().toLowerCase()));
  const nameBad = Boolean(editing && !editing.existing && editing.name.trim() && !NAME.test(editing.name.trim()));
  const dirty = Boolean(editing && (!editing.existing || editing.text.trim() !== (current?.text ?? "").trim()));

  const save = async () => {
    if (!editing) return;
    setBusy(true);
    try {
      const name = editing.name.trim();
      await api("PUT", `/templates/${encodeURIComponent(name)}`, { text: editing.text });
      await reload();
      setEditing({ name, text: editing.text, existing: true });
      const running = usedBy.filter((s) => s.running).length;
      ok(`Saved "${name}".${usedBy.length ? ` ${usedBy.length} session${usedBy.length === 1 ? " reads" : "s read"} the new text at the next lead life${running ? ` (${running} running now)` : ""}.` : ""}`);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (name: string) => {
    setBusy(true);
    try {
      await api("DELETE", `/templates/${encodeURIComponent(name)}`);
      await reload();
      if (editing?.name === name) setEditing(null);
      setConfirmDelete(null);
      ok(`Deleted "${name}".`);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <div className="row">
        <h3>Goal templates</h3>
        <button className="sm end" onClick={() => setEditing({ name: "", text: "", existing: false })} disabled={busy}>New template</button>
      </div>
      <p className="lead">
        How to work, written once: “research first, no time limit, then plan, then implement”, or “a prototype: rough code and known bugs are fine”. Pick one per session beside the goal. The lead reads it after the goal at every life, and the reviewer reads it as the standard the work was done under. Sessions store the name, so an edit here reaches every session that uses the template.
      </p>
      {templates === null && <div className="muted small">Loading…</div>}
      {templates?.length === 0 && !editing && <div className="muted small">No templates yet.</div>}
      {templates && templates.length > 0 && (
        <div className="template-list">
          {templates.map((t) => (
            <div key={t.name} className={`template-row ${editing?.existing && editing.name === t.name ? "on" : ""}`}>
              <button className="quiet name" onClick={() => setEditing({ name: t.name, text: t.text, existing: true })} title="Edit">
                <strong>{t.name}</strong>
                <span className="muted small">{t.text.split("\n")[0]!.slice(0, 110)}</span>
              </button>
              <span className="muted small use">
                {t.usedBy.length ? `${t.usedBy.length} session${t.usedBy.length === 1 ? "" : "s"}${t.usedBy.some((s) => s.running) ? ", running" : ""}` : "not in use"}
                {t.updatedAt ? ` · ${fmtAgo(t.updatedAt)}` : ""}
              </span>
            </div>
          ))}
        </div>
      )}
      {editing && (
        <div className="stack" style={{ gap: 8, marginTop: 12 }}>
          {editing.existing ? (
            <div className="row"><strong>{editing.name}</strong><span className="muted small">The name is how sessions refer to it; to rename, save the text under a new name and delete this one.</span></div>
          ) : (
            <label>
              Name <span className="help">Shown in the dropdown: letters, digits, spaces and . _ &amp; + -</span>
              <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} maxLength={64} placeholder="Research" autoFocus />
            </label>
          )}
          {nameTaken && <div className="banner warn small"><span>A template with this name exists; saving would replace it. Open it from the list instead.</span></div>}
          {nameBad && <div className="banner warn small"><span>Use letters, digits, spaces and . _ &amp; + - only, starting with a letter or digit.</span></div>}
          <label>
            Text <span className="help">Written to the lead, in your words. It applies to the goal and to every ticket</span>
            <textarea value={editing.text} onChange={(e) => setEditing({ ...editing, text: e.target.value })} style={{ minHeight: 180 }} maxLength={20_000} placeholder={"This is a research task. Be thorough; there is no time limit.\nResearch first and write what you find to notes/. Then write a plan. Only then implement."} />
          </label>
          {usedBy.length > 0 && (
            <div className={`banner small ${dirty ? "warn" : "info"}`}>
              <span>
                In use by {usedBy.map((s, i) => (
                  <span key={s.id}>{i ? ", " : ""}<a href={`#/s/${encodeURIComponent(s.id)}`}>{s.name}</a>{s.running ? " (running)" : ""}</span>
                ))}
                . {dirty ? "Saving changes what these sessions are told: a running lead hears the new text at its next life, and reviews use it from the next ticket." : "They read this text at every lead life and review."}
              </span>
            </div>
          )}
          <div className="row">
            <button className="pri" onClick={() => void save()} disabled={busy || !dirty || !editing.name.trim() || !editing.text.trim() || nameBad || nameTaken}>{editing.existing ? "Save" : "Create template"}</button>
            <button className="quiet" onClick={() => setEditing(null)} disabled={busy}>Close</button>
            {editing.existing &&
              (confirmDelete === editing.name ? (
                <span className="row end" style={{ gap: 6 }}>
                  <span className="small">{usedBy.length ? `${usedBy.length} session${usedBy.length === 1 ? " uses" : "s use"} it and will work without a template.` : "Delete this template?"}</span>
                  <button className="warn sm" onClick={() => void remove(editing.name)} disabled={busy}>Delete</button>
                  <button className="quiet sm" onClick={() => setConfirmDelete(null)}>Keep</button>
                </span>
              ) : (
                <button className="quiet end" onClick={() => setConfirmDelete(editing.name)} disabled={busy}>Delete…</button>
              ))}
          </div>
        </div>
      )}
    </section>
  );
};

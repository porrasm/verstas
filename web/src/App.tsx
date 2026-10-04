import { useEffect, useState } from "react";
import { api, type Status } from "./api";
import { SessionsPage } from "./pages/Sessions";
import { NewSessionPage } from "./pages/NewSession";
import { SessionPage } from "./pages/Session";
import { SettingsPage } from "./pages/Settings";
import { ScriptsPage } from "./pages/Scripts";
import { DraftPage } from "./pages/Draft";

/** Hash routing: #/ sessions, #/new (?draft=<id>), #/s/<id>, #/s/<id>/t/<ticket>, #/d/<draft>, #/scripts, #/settings. */
const useRoute = (): string => {
  const [hash, setHash] = useState(location.hash || "#/");
  useEffect(() => {
    const on = () => setHash(location.hash || "#/");
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return hash;
};

export const App = () => {
  const route = useRoute();
  const [status, setStatus] = useState<Status | null>(null);
  useEffect(() => {
    const load = () => api<Status>("GET", "/status").then(setStatus).catch(() => setStatus(null));
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [route]);

  let page: JSX.Element;
  const m = /^#\/s\/([^/]+)(?:\/t\/([^/]+))?/.exec(route);
  if (m) page = <SessionPage id={decodeURIComponent(m[1]!)} ticketId={m[2] ? decodeURIComponent(m[2]) : null} />;
  else if (/^#\/d\/[^/?]+/.test(route)) page = <DraftPage id={decodeURIComponent(/^#\/d\/([^/?]+)/.exec(route)![1]!)} />;
  else if (route.startsWith("#/new")) page = <NewSessionPage key={route} draftId={new URLSearchParams(route.split("?")[1] ?? "").get("draft")} />;
  else if (route.startsWith("#/scripts")) page = <ScriptsPage />;
  else if (route.startsWith("#/settings")) page = <SettingsPage status={status} />;
  else page = <SessionsPage status={status} />;

  const onSessions = route === "#/" || route.startsWith("#/s/") || route.startsWith("#/d/");
  return (
    <>
      <header className="top">
        <a className="brand" href="#/">Verstas</a>
        <nav>
          <a href="#/" className={onSessions ? "on" : ""}>Sessions</a>
          <a href="#/new" className={route.startsWith("#/new") ? "on" : ""}>New session</a>
          <a href="#/scripts" className={route.startsWith("#/scripts") ? "on" : ""}>Recipes</a>
          <a href="#/settings" className={route.startsWith("#/settings") ? "on" : ""}>Settings</a>
        </nav>
        <div className="right">
          {status ? (
            <>
              <Health ok={status.docker.ok} label={status.docker.ok ? `Docker ${status.docker.detail}` : "Docker unavailable"} title={status.docker.ok ? "Docker daemon reachable" : "Sessions can be edited but not run until Docker is up"} />
              <Health ok={status.image} label={status.image ? "image ready" : "image missing"} title={status.image ? `${status.imageName} is built` : `Build ${status.imageName} with npm run image:build`} />
              <Health ok={status.hasClaudeToken} label={status.hasClaudeToken ? "token set" : "no token"} title={status.hasClaudeToken ? "A Claude token is configured" : "Paste a token in Settings"} href="#/settings" />
              <span className="health mono" title="Verstas version">v{status.version}</span>
            </>
          ) : (
            <span className="health bad">host app unreachable</span>
          )}
        </div>
      </header>
      <main className="page">{page}</main>
    </>
  );
};

const Health = ({ ok, label, title, href }: { ok: boolean; label: string; title: string; href?: string }) => {
  const body = (
    <>
      <span className={`dot ${ok ? "good" : "bad"}`} />
      {label}
    </>
  );
  if (!ok && href) return <a className="health bad" href={href} title={title}>{body}</a>;
  return <span className={`health ${ok ? "" : "bad"}`} title={title}>{body}</span>;
};

import { useEffect, useState } from "react";
import { api, type Status } from "./api";
import { SessionsPage } from "./pages/Sessions";
import { NewSessionPage } from "./pages/NewSession";
import { SessionPage } from "./pages/Session";
import { SettingsPage } from "./pages/Settings";

/** Hash routing: #/ sessions, #/new, #/s/<id>, #/settings. */
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
  const m = /^#\/s\/([^/]+)/.exec(route);
  if (m) page = <SessionPage id={decodeURIComponent(m[1]!)} />;
  else if (route.startsWith("#/new")) page = <NewSessionPage />;
  else if (route.startsWith("#/settings")) page = <SettingsPage status={status} />;
  else page = <SessionsPage status={status} />;

  return (
    <>
      <header className="top">
        <span className="brand">Verstas</span>
        <nav>
          <a href="#/" className={route === "#/" || route.startsWith("#/s/") ? "on" : ""}>Sessions</a>
          <a href="#/new" className={route.startsWith("#/new") ? "on" : ""}>New session</a>
          <a href="#/settings" className={route.startsWith("#/settings") ? "on" : ""}>Settings</a>
        </nav>
        <div className="right">
          {status ? (
            <>
              <span><span className={`dot ${status.docker.ok ? "good" : "bad"}`} />docker {status.docker.ok ? status.docker.detail : "unavailable"}</span>
              <span><span className={`dot ${status.image ? "good" : "bad"}`} />image {status.image ? "ready" : "missing"}</span>
              <span><span className={`dot ${status.hasClaudeToken ? "good" : "bad"}`} />token</span>
              <span className="mono">v{status.version}</span>
            </>
          ) : (
            <span className="err">host app unreachable</span>
          )}
        </div>
      </header>
      <main className="page">{page}</main>
    </>
  );
};

// Verstas as a desktop app: one window on the host app.
//
//   npm start      the host app runs inside this process (built code in
//                  dist/ and web/dist from `npm run setup`); the window
//                  shows it. Closing the window quits: runs stop and requeue
//                  their tickets, session containers stop.
//   npm run dev    scripts/dev.mjs runs the host app (tsx watch, debug logs)
//                  and the UI (Vite, hot reload) as their own processes;
//                  this window only shows the Vite UI, with DevTools.
//
// The host app's boundaries are unchanged: the UI stays on 127.0.0.1 and
// the window is a browser on it. See docs/SANDBOX.md.

import { app, BrowserWindow, Menu, dialog, shell } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dev = process.argv.includes("--dev");
const devUrl = process.env.VERSTAS_DEV_URL ?? "http://127.0.0.1:4710";

app.setName("Verstas");

// The hammer in the Dock under `npm start` too (the launcher bundle carries it as its .icns).
const dockIcon = path.join(root, "electron", "icon.png");
if (process.platform === "darwin" && app.dock && existsSync(dockIcon)) app.whenReady().then(() => app.dock.setIcon(dockIcon));

// A desktop launch gets a short PATH; Verstas shells out to docker and git.
if (process.platform === "darwin") {
  const extra = ["/usr/local/bin", "/opt/homebrew/bin", "/Applications/Docker.app/Contents/Resources/bin"];
  const have = (process.env.PATH ?? "").split(":");
  process.env.PATH = [...have, ...extra.filter((p) => !have.includes(p))].join(":");
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let win = null;
  let url = null;
  let verstas = null;

  const createWindow = () => {
    win = new BrowserWindow({
      width: 1440,
      height: 960,
      minWidth: 720,
      minHeight: 480,
      title: dev ? "Verstas (dev)" : "Verstas",
      backgroundColor: "#111413",
      show: false,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    win.once("ready-to-show", () => win?.show());
    win.on("closed", () => (win = null));
    // Links that leave the app open in your browser, not in this window.
    win.webContents.setWindowOpenHandler(({ url: target }) => {
      if (/^https?:/.test(target)) void shell.openExternal(target);
      return { action: "deny" };
    });
    win.webContents.on("will-navigate", (e, target) => {
      if (url && !target.startsWith(url)) {
        e.preventDefault();
        if (/^https?:/.test(target)) void shell.openExternal(target);
      }
    });
    void win.loadURL(url);
    if (dev) win.webContents.openDevTools({ mode: "detach" });
  };

  const fail = async (title, detail) => {
    await dialog.showMessageBox({ type: "error", title: "Verstas", message: title, detail });
    app.exit(1);
  };

  /** Dev: the UI and the host app are separate processes; wait until both answer. */
  const waitFor = async (target, ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try {
        const r = await fetch(target);
        if (r.status < 500) return true;
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    return false;
  };

  app.on("second-instance", () => {
    if (!win) return createWindow();
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(async () => {
    if (process.platform !== "darwin") Menu.setApplicationMenu(null);
    if (dev) {
      url = devUrl;
      if (!(await waitFor(`${devUrl}/api/status`, 120_000))) {
        return fail("The dev servers did not come up", `Nothing answered at ${devUrl}/api/status within two minutes. Check the [server] and [web] lines in the terminal.`);
      }
    } else {
      const entry = path.join(root, "dist", "src", "server.js");
      if (!existsSync(entry) || !existsSync(path.join(root, "web", "dist", "index.html"))) {
        return fail("Verstas is not built yet", "Run `npm run setup` in the verstas directory, then `npm start` again.");
      }
      try {
        const { startVerstas } = await import(pathToFileURL(entry).href);
        verstas = await startVerstas();
        url = verstas.url;
      } catch (e) {
        const taken = e && e.code === "EADDRINUSE";
        return fail(
          taken ? "Verstas is already running" : "Verstas could not start",
          taken ? `${e.message}\n\nAnother Verstas (a terminal \`npm run serve\`/\`npm run dev\`, or another window) holds the port. Stop it and start again.` : String(e?.stack ?? e),
        );
      }
    }
    createWindow();
  });

  // Closing the window quits, on every platform: runs stop and requeue their
  // tickets, session containers stop, then the process ends (before-quit below).
  // Nothing of Verstas keeps running out of sight.
  app.on("window-all-closed", () => app.quit());
  app.on("activate", () => {
    if (!win && url) createWindow();
  });

  // Quitting stops active runs (tickets go back to ready) before the process exits.
  let quitting = false;
  app.on("before-quit", (e) => {
    if (!verstas || quitting) return;
    e.preventDefault();
    quitting = true;
    void verstas
      .stop()
      .catch((err) => console.error(err))
      .finally(() => app.exit(0));
  });
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => app.quit());
}

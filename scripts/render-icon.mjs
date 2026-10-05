// Renders electron/icon.svg to electron/icon.png (1024 px) and
// electron/icon.icns, with the project's own Electron (no other tools):
//
//   npx electron scripts/render-icon.mjs
//
// Run it after editing the SVG. scripts/macos-app.sh puts the .icns in the
// launcher; electron/main.mjs shows the PNG in the Dock under `npm start`.
import { app, BrowserWindow } from "electron";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "electron");

app.dock?.hide();
app.whenReady().then(async () => {
  const svg = readFileSync(path.join(dir, "icon.svg"), "utf8");
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, useContentSize: true, webPreferences: { offscreen: true } });
  win.webContents.setZoomFactor(1);
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><body style="margin:0;background:transparent">${svg}</body></html>`)}`);
  await new Promise((r) => setTimeout(r, 300));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  const png = image.resize({ width: 1024, height: 1024, quality: "best" }).toPNG();
  writeFileSync(path.join(dir, "icon.png"), png);

  // The sizes macOS wants in an .iconset, then iconutil packs them.
  const tmp = mkdtempSync(path.join(os.tmpdir(), "verstas-icon-"));
  const set = path.join(tmp, "icon.iconset");
  execFileSync("mkdir", ["-p", set]);
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const px = size * scale;
      const name = `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`;
      writeFileSync(path.join(set, name), image.resize({ width: px, height: px, quality: "best" }).toPNG());
    }
  }
  execFileSync("iconutil", ["-c", "icns", set, "-o", path.join(dir, "icon.icns")]);
  rmSync(tmp, { recursive: true, force: true });
  console.log("wrote electron/icon.png and electron/icon.icns");
  app.quit();
});

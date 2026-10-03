import { startVerstas } from "./server.js";

/**
 * The host app from a terminal, without a window: `npm run serve` (built)
 * or `npm run dev:server` (tsx watch). The desktop app is electron/main.mjs.
 */

const verstas = await startVerstas().catch((e: Error & { code?: string }) => {
  console.error(e.code === "EADDRINUSE" ? `Port in use: ${e.message}. Is Verstas already running (in a terminal or the desktop app)?` : e);
  process.exit(1);
});

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (stopping) process.exit(1); // a second Ctrl-C does not wait
    stopping = true;
    console.log("(Ctrl-C again to force)");
    void verstas.stop().finally(() => process.exit(0));
  });
}

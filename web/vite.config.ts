import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: `npm run web:dev` serves the UI on 4710 and proxies /api and /ws to
// the host app on 4700. Build: `npm run web:build` writes web/dist, which
// the host app serves itself.
export default defineConfig({
  root: __dirname,
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 4710,
    proxy: {
      "/api": "http://127.0.0.1:4700",
      "/ws": { target: "ws://127.0.0.1:4700", ws: true },
    },
  },
});

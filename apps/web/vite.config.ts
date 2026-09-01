import { createLogger, defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";

// The SPA-shell prerender during `vite build` fetches /api/* with no control
// server running, so Vite's proxy logs an ECONNREFUSED/ENOTFOUND "error" per
// call. The shell renders fine without it — mute just that line so the
// installer's build output doesn't look broken.
const logger = createLogger();
const baseError = logger.error;
logger.error = (msg, opts) => {
  if (typeof msg === "string" && msg.includes("http proxy error: /api")) return;
  baseError(msg, opts);
};

export default defineConfig({
  // The dashboard is an internal admin SPA: no SSR server, all data is fetched
  // client-side from /api. `spa` emits a static shell + client bundle that Caddy
  // serves directly — no sproutboat-web service.
  customLogger: logger,
  plugins: [tanstackStart({ spa: { enabled: true } }), react()],
  server: {
    port: Number(process.env.PORT) || 5173,
    proxy: {
      "/api": { target: "https://control.sproutboat.localhost", changeOrigin: true, secure: false },
    },
  },
});

import { fileURLToPath } from "node:url";
import { createLogger, defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The SPA-shell prerender during `vite build` fetches /api/* with no control
// server running, so Vite's proxy logs an ECONNREFUSED/ENOTFOUND "error" per
// call. The shell renders fine without it — mute just that line so the
// installer's build output doesn't look broken.
const logger = createLogger();
const baseError = logger.error;
logger.error = (msg, opts) => {
  if (msg.includes("http proxy error: /api")) return; // Vite types `msg` as string
  baseError(msg, opts);
};

export default defineConfig({
  // The dashboard is an internal admin SPA: no SSR server, all data is fetched
  // client-side from /api. `spa` emits a static shell + client bundle that Caddy
  // serves directly — no sproutboat-web service.
  customLogger: logger,
  plugins: [tailwindcss(), tanstackStart({ spa: { enabled: true } }), react()],
  // shadcn generates components that import from "@/components/ui/*".
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    port: Number(process.env.PORT) || 5173,
    proxy: {
      // SPROUTBOAT_CONTROL_URL lets the dev server reach a control plane that
      // isn't on :443 — which is what you get when the portless proxy could not
      // take the privileged port (no sudo) and fell back to :1355.
      "/api": {
        target: process.env.SPROUTBOAT_CONTROL_URL || "https://control.sproutboat.localhost",
        changeOrigin: true,
        secure: false,
      },
    },
  },
});

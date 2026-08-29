import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // The dashboard is an internal admin SPA: no SSR server, all data is fetched
  // client-side from /api. `spa` emits a static shell + client bundle that Caddy
  // serves directly — no sproutboat-web service.
  plugins: [tanstackStart({ spa: { enabled: true } }), react()],
  server: {
    port: Number(process.env.PORT) || 5173,
    proxy: {
      "/api": { target: "https://control.sproutboat.localhost", changeOrigin: true, secure: false },
    },
  },
});

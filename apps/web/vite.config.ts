import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [tanstackStart(), react()],
  server: {
    port: Number(process.env.PORT) || 5173,
    proxy: {
      // `secure: false` — the local portless cert is self-signed.
      "/api": { target: "https://control.sproutboat.localhost", changeOrigin: true, secure: false },
    },
  },
});

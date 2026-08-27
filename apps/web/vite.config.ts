import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [tanstackStart(), react()],
  server: { port: Number(process.env.PORT) || 5173, proxy: { "/api": "https://control.porffer.localhost", "/v1": "https://control.porffer.localhost" } },
});

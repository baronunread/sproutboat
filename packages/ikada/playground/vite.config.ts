import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [tailwindcss(), react()],
  server: { host: "0.0.0.0", port: Number(process.env.PORT) || 5180, strictPort: false, allowedHosts: true },
});

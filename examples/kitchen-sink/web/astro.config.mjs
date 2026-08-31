import { defineConfig } from "astro/config";

// Static build. The Sproutboat worker (src/index.js) + its broker are the
// backend; this just produces the files served through env.ASSETS.
export default defineConfig({
  outDir: "./dist",
  build: { format: "file" }, // dist/index.html, not dist/index/index.html
  devToolbar: { enabled: false },
  compressHTML: false, // keep whitespace between inline elements in the prose
});

/**
 * Applies the Sproutboat patches to the pinned Porffor (`github:CanadaHonk/porffor#alpha-3`).
 * The tag ships no package.json, so `bun patch` can't manage it — this runs from `postinstall`.
 * Idempotent: skips a file that already contains the patch marker.
 *
 * Patch: compiler/render.js — honour $PORT at runtime in the native-fetch server.
 * The missing-polyfill gaps (URLSearchParams / Response.json) are handled in our
 * own prelude instead (sproutboat/runtime/prelude), not by patching Porffor.
 */
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const porffor = resolve(root, "node_modules/porffor");

// compiler/render.js — honour $PORT at runtime in the native-fetch server.
const file = resolve(porffor, "compiler/render.js");
const patch = resolve(root, "patches/porffor-render.patch");
const marker = 'getenv("PORT")';

if (!(await Bun.file(file).exists())) {
  console.log(`patch-porffor: ${file} not found (porffor not installed?) — skipping`);
} else if ((await Bun.file(file).text()).includes(marker)) {
  console.log("patch-porffor: already patched");
} else {
  const child = Bun.spawn(["patch", "-s", "-p1", "-d", porffor, "-i", patch], { stdout: "pipe", stderr: "pipe" });
  const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (code !== 0) {
    console.error(`patch-porffor: failed to apply ${patch}\n${err}`);
    process.exit(1);
  }
  console.log("patch-porffor: applied 1 patch");
}

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createBroker } from "./broker";
import { walkAssets, type AssetManifest } from "./assets";

/** A temp project dir with `assets/` + a sibling `assets.json`, returned resolved. */
function fixture(files: Record<string, string>, notFound: AssetManifest["notFound"] = "none") {
  const root = mkdtempSync(join(tmpdir(), "sb-broker-assets-"));
  const dir = join(root, "assets");
  mkdirSync(dir);
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  const manifest: AssetManifest = { notFound, runSproutFirst: false, files: walkAssets(dir) };
  writeFileSync(join(root, "assets.json"), JSON.stringify(manifest));
  return { root, dir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("assets.get resolves like a static host: exact, directory, extensionless", async () => {
  const fx = fixture({
    "index.html": "<h1>home</h1>",
    "cloud.html": "<h1>cloud</h1>",
    "blog/index.html": "<h1>blog</h1>",
    "app.js": "console.log(1)",
  });
  const broker = createBroker({ assetsDir: fx.dir, bindings: { assets: "ASSETS" } });
  try {
    const get = (path: string) => broker.dispatch({ op: "assets.get", path });

    expect(await get("/")).toMatchObject({ found: true, status: 200, body: "<h1>home</h1>" });
    expect(await get("/app.js")).toMatchObject({ found: true, body: "console.log(1)" });
    expect(await get("/cloud.html")).toMatchObject({ found: true, body: "<h1>cloud</h1>" });

    // the point of this change: no `.html`, no trailing slash
    expect(await get("/cloud")).toMatchObject({ found: true, status: 200, body: "<h1>cloud</h1>" });
    expect(await get("/blog")).toMatchObject({ found: true, body: "<h1>blog</h1>" });
    expect(await get("/blog/")).toMatchObject({ found: true, body: "<h1>blog</h1>" });

    // genuine miss with notFound:"none" -> 404, not a wrong file
    expect(await get("/missing")).toMatchObject({ found: false, status: 404 });
    expect(await get("/app.css")).toMatchObject({ found: false, status: 404 });
  } finally {
    broker.close();
    fx.cleanup();
  }
});

test("assets.get: SPA fallback still applies only after resolution misses", async () => {
  const fx = fixture({ "index.html": "<h1>shell</h1>", "about.html": "<h1>about</h1>" }, "single-page-application");
  const broker = createBroker({ assetsDir: fx.dir, bindings: { assets: "ASSETS" } });
  try {
    const get = (path: string) => broker.dispatch({ op: "assets.get", path });
    // resolves to the real file, not the shell
    expect(await get("/about")).toMatchObject({ found: true, body: "<h1>about</h1>" });
    // unknown deep route -> shell
    expect(await get("/some/client/route")).toMatchObject({ found: true, status: 200, body: "<h1>shell</h1>" });
  } finally {
    broker.close();
    fx.cleanup();
  }
});

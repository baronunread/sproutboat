import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createBroker, type Frame } from "@sproutboat/wire";
import { walkAssets, type AssetManifest } from "@sproutboat/assets";

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

test("list ops honour a bound LIMIT (do.storage.list, ae.query, r2.list)", async () => {
  const broker = createBroker({
    bindings: { assets: "", do: [{ binding: "OBJ", className: "C" }], analytics: ["M"], r2: ["B"] },
  });
  try {
    const d = (msg: Frame) => broker.dispatch(msg);
    for (let i = 0; i < 12; i++) {
      await d({ op: "do.storage.put", cls: "C", id: "1", key: `k${String(i).padStart(2, "0")}`, value: "v" });
      await d({ op: "ae.write", dataset: "M", indexes: [`i${i}`], blobs: [], doubles: [i] });
      await d({ op: "r2.put", bucket: "B", key: `o${String(i).padStart(2, "0")}`, body: "x" });
    }

    const doList = await d({ op: "do.storage.list", cls: "C", id: "1", prefix: "k", limit: 5 });
    expect(doList.entries).toHaveLength(5);

    const ae = await d({ op: "ae.query", dataset: "M", limit: 4 });
    expect(ae.rows).toHaveLength(4);

    const r2 = await d({ op: "r2.list", bucket: "B", limit: 3 });
    expect(r2.objects).toHaveLength(3);
    expect(r2.truncated).toBe(true);
  } finally {
    broker.close();
  }
});

// v0.11.0 — Durable Object storage.sql (`do.sql`, wire 0.19, compat 2026-10-29) with the
// layout the supervisor gives a broker: the project's Durable Object store at
// `resources/<doStoreId>.sqlite`, so each object's database lands in
// `resources/<doStoreId>.do-sql/CLASS/<64-hex id>.sqlite`, where backups and restores
// already walk. The platform spawns one dedicated broker per deployment (no SQL pool), so
// at most 64 of these databases stay open per broker; more objects than that must keep
// their rows across the least-recently-used close and a redeploy.
test("do.sql under the platform layout: per-object files in resources/, past the open cap, across a redeploy", async () => {
  const root = mkdtempSync(join(tmpdir(), "sb-broker-do-sql-"));
  try {
    const resourceDir = join(root, "resources");
    for (const dir of [resourceDir, join(root, "brokers", "a"), join(root, "brokers", "b")])
      mkdirSync(dir, { recursive: true });
    const doDb = join(resourceDir, "do_0123456789abcdef01234567.sqlite");
    const bindings = { do: [{ binding: "ROOM", className: "Room" }] };
    const open = (dep: string) =>
      createBroker({ db: join(root, "brokers", dep, "state.sqlite"), resourceDir, doDb, bindings });
    const id = (i: number) => i.toString(16).padStart(64, "0");
    const sql = (b: ReturnType<typeof open>, i: number, text: string, params: number[] = []) =>
      b.dispatch({ op: "do.sql", cls: "Room", file: id(i), sql: text, params });

    const first = open("a");
    for (let i = 0; i < 80; i++) {
      await sql(first, i, "CREATE TABLE t (v)");
      await sql(first, i, "INSERT INTO t VALUES (?)", [i]);
    }
    // Object 0 was closed to make room; it reopens with its row.
    expect((await sql(first, 0, "SELECT v FROM t")).rows).toEqual([[0]]);
    first.close();
    expect(existsSync(join(resourceDir, "do_0123456789abcdef01234567.do-sql", "Room", `${id(79)}.sqlite`))).toBe(true);

    const second = open("b");
    try {
      expect((await sql(second, 79, "SELECT v FROM t")).rows).toEqual([[79]]);
    } finally {
      second.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

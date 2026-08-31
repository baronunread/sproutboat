#!/usr/bin/env bun
/**
 * End-to-end check for the kitchen-sink example: compiles the worker for the
 * host, stands up an in-process broker (KV / D1 / R2 / queue / DO / analytics /
 * cron) plus a stub upstream, then drives every binding over HTTP.
 *
 *   bun examples/kitchen-sink/harness.ts
 *
 * This is the local stand-in for the platform: the real supervisor spawns the
 * same broker per deployment and passes SB_BROKER_PORT / SB_BROKER_TOKEN /
 * SB_WORKER_URL to the worker exactly as this script does.
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWebUi } from "./build-web";
import { wrapNativeFetchHandler, type Bindings } from "../../tools/compile";
import { parseConfig } from "../../packages/config/src/config";
import { createBroker, listen } from "../../services/broker/src/broker";
import { walkAssets, type AssetManifest } from "../../tools/assets";

const HERE = import.meta.dir;
const ROOT = join(HERE, "../..");
const PORF = join(ROOT, "node_modules/porffor/runtime/index.js");

const workdir = mkdtempSync(join(tmpdir(), "sb-kitchen-"));
const cleanup: Array<() => void> = [() => rmSync(workdir, { recursive: true, force: true })];
const die = (m: string) => { console.error("FAIL:", m); for (const c of cleanup.reverse()) try { c(); } catch {} process.exit(1); };

let passed = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { passed++; console.log("  ok  " + name); }
  else die(`${name}${detail === undefined ? "" : " — " + JSON.stringify(detail)}`);
}

// --- config -> bindings --------------------------------------------------
const cfg = parseConfig(readFileSync(join(HERE, "sproutboat.jsonc"), "utf8"));
if (!cfg.ok) die("bad example config: " + cfg.errors.join("; "));
const c = cfg.ok ? cfg.value : null!;

// --- stub upstream for env.QUOTE_URL -----------------------------------
const QUOTES = [
  { content: "Simplicity is prerequisite for reliability.", author: "Edsger Dijkstra" },
  { content: "Make it work, make it right, make it fast.", author: "Kent Beck" },
  { content: "Programs must be written for people to read.", author: "Harold Abelson" },
];
const upstream = Bun.serve({ port: 0, fetch: () => Response.json(QUOTES[Math.floor(Date.now() / 4000) % QUOTES.length]) });
cleanup.push(() => upstream.stop(true));
const upstreamHost = `127.0.0.1:${upstream.port}`;

const bindings: Bindings = {
  kv: c.kv_namespaces ?? [],
  secrets: c.secrets ?? [],
  outbound: [upstreamHost], // override the example's placeholder host
  d1: c.d1_databases ?? [],
  r2: c.r2_buckets ?? [],
  queues: c.queues ?? [],
  analytics: c.analytics_engine_datasets ?? [],
  do: Object.entries(c.durable_objects ?? {}).map(([binding, className]) => ({ binding, className })),
  crons: c.triggers?.crons ?? [],
  assets: c.assets?.binding ?? "",
};
const vars = { ...c.vars, QUOTE_URL: `http://${upstreamHost}/random` };

// build the Astro UI, then publish the assets dir + manifest exactly as
// `sproutboat build` would
buildWebUi();
const assetsDir = join(workdir, "assets");
const assetSrc = join(HERE, c.assets!.directory);
if (!existsSync(assetSrc)) die(`assets dir not found: ${assetSrc}`);
cpSync(assetSrc, assetsDir, { recursive: true });
const assetManifest: AssetManifest = {
  notFound: c.assets?.not_found_handling ?? "none",
  runSproutFirst: c.assets?.run_sprout_first ?? false,
  files: walkAssets(assetsDir),
};
writeFileSync(join(workdir, "assets.json"), JSON.stringify(assetManifest, null, 2));

// --- compile the worker for the host ----------------------------------
const prelude = readFileSync(join(ROOT, "tools/native-fetch-prelude.js"), "utf8");
const gen = join(workdir, "worker.generated.js");
const bin = join(workdir, "worker.bin");
writeFileSync(gen, wrapNativeFetchHandler(readFileSync(join(HERE, "src/index.js"), "utf8"), prelude, vars, bindings));

console.log("compiling worker (host native)…");
const compile = Bun.spawnSync(["node", PORF, "native", gen, "-o", bin], {
  env: { ...process.env, PATH: `${join(ROOT, "node_modules/.bin")}:${process.env.PATH}` },
  stdout: "pipe", stderr: "pipe",
});
if (compile.exitCode !== 0) die("porffor compile failed:\n" + compile.stderr.toString() + compile.stdout.toString());

// --- broker (in-process) --------------------------------------------
const TOKEN = "harness-token";
const workerPort = 8000 + Math.floor(Math.random() * 900);
const broker = createBroker({
  db: join(workdir, "state.sqlite"),
  dataDir: join(workdir, "d1"),
  token: TOKEN,
  bindings,
  secrets: { ADMIN_TOKEN: "s3cr3t-admin" },
  workerUrl: `http://127.0.0.1:${workerPort}/`,
  assetsDir,
});
const brokerServer = listen(broker, "127.0.0.1", 0);
cleanup.push(() => { brokerServer.stop(); broker.close(); });

// --- worker process -----------------------------------------------
const worker = Bun.spawn([bin], {
  env: { ...process.env, PORT: String(workerPort), SB_BROKER_PORT: String(brokerServer.port), SB_BROKER_TOKEN: TOKEN },
  stdout: "inherit", stderr: "inherit",
});
cleanup.push(() => worker.kill(9));

const base = `http://127.0.0.1:${workerPort}`;
async function up() {
  for (let i = 0; i < 100; i++) {
    try { await fetch(base + "/"); return; } catch { await Bun.sleep(50); }
  }
  die("worker never listened");
}
await up();

// --- drive every binding ------------------------------------------
const jget = async (p: string, init?: RequestInit) => {
  const r = await fetch(base + p, init);
  const t = await r.text();
  try { return { status: r.status, body: JSON.parse(t) as Record<string, unknown> }; }
  catch { return { status: r.status, body: t as unknown as Record<string, unknown> }; }
};

console.log("\nbindings:");

// vars
check("vars: GET / uses env.SITE_NAME", String((await jget("/")).body).includes("Sproutboat Notes"));

// static assets: env.ASSETS.fetch serves index.html; SPA fallback for unknown GET
const home = await fetch(base + "/");
check("assets: GET / serves index.html with html content-type",
  home.status === 200 && (home.headers.get("content-type") || "").includes("text/html") && (await home.text()).includes("<h1>Sproutboat Notes"));
const spa = await fetch(base + "/some/client/route");
check("assets: unknown GET falls back to the SPA shell (200)", spa.status === 200 && (await spa.text()).includes("<h1>Sproutboat Notes"));

// KV (login -> whoami)
const login = await jget("/login", { method: "POST" });
const token = String(login.body.token);
check("KV: login issues a token", token.length > 10, login.body);
const who = await jget("/whoami", { headers: { authorization: "Bearer " + token } });
check("KV: whoami resolves the session", who.status === 200 && who.body.user === "demo", who.body);

// D1 (create + list + get)
const created = await jget("/notes", { method: "POST", body: JSON.stringify({ title: "hello", body: "world" }) });
check("D1: POST /notes inserts", created.status === 201 && typeof created.body.id === "number", created.body);
const noteId = created.body.id as number;
const list = await jget("/notes");
check("D1: GET /notes lists it", Array.isArray(list.body) && (list.body as unknown[]).length >= 1, list.body);

// Durable Object (view counter increments atomically)
const v1 = await jget(`/notes/${noteId}`);
const v2 = await jget(`/notes/${noteId}`);
check("DO: view count increments across requests", (v2.body.views as number) === (v1.body.views as number) + 1, { v1: v1.body.views, v2: v2.body.views });

// R2 (attach + fetch back + list)
const att = await jget(`/notes/${noteId}/attach`, { method: "POST", body: "the file contents" });
check("R2: attach stores a key", typeof att.body.key === "string", att.body);
const file = await fetch(base + `/attach/${encodeURIComponent(String(att.body.key))}`);
check("R2: GET /attach returns the body + etag", (await file.text()) === "the file contents" && !!file.headers.get("etag"));
const atts = await jget("/attachments");
check("R2: GET /attachments lists the object", Array.isArray(atts.body) && (atts.body as Array<{ key: string }>).some((o) => o.key === att.body.key), atts.body);

// outbound fetch (allowlisted)
const quote = await jget("/quote");
check("fetch: /quote proxies the allowlisted upstream", quote.status === 200 && typeof quote.body.content === "string" && String(quote.body.author).length > 0, quote.body);

// secret gate
const denied = await jget("/admin/stats", { headers: { "x-admin-token": "wrong" } });
check("secret: /admin/stats rejects a bad ADMIN_TOKEN", denied.status === 403);
const allowed = await jget("/admin/stats", { headers: { "x-admin-token": "s3cr3t-admin" } });
check("secret: /admin/stats accepts the real ADMIN_TOKEN", allowed.status === 200 && allowed.body.site === "Sproutboat Notes", allowed.body);

// analytics engine — env.METRICS.query() feeds the dashboard
check("analytics: METRICS.query reports data points", Number((allowed.body as Record<string, number>).analytics_points) > 0
  && Array.isArray((allowed.body as { analytics_recent?: unknown[] }).analytics_recent), allowed.body);

// queue: POST /notes enqueued an EMAILS job; the broker consumer delivers it
let emailLogged = 0;
for (let i = 0; i < 20; i++) {
  const stats = await jget("/admin/stats", { headers: { "x-admin-token": "s3cr3t-admin" } });
  emailLogged = Number((stats.body as Record<string, number>).queue_emails_processed || 0);
  if (emailLogged > 0) break;
  await Bun.sleep(300);
}
check("queue: EMAILS job consumed -> email_log row", emailLogged > 0, { emailLogged });

// cron: fire the scheduled trigger the way the broker would
const sched = await fetch(base + "/", {
  method: "POST",
  headers: { "x-sb-trigger": "scheduled", "x-sb-token": TOKEN, "content-type": "application/json" },
  body: JSON.stringify({ cron: "*/1 * * * *", scheduledTime: Date.now() }),
});
check("cron: scheduled() runs (204)", sched.status === 204, sched.status);
const afterCron = await jget("/admin/stats", { headers: { "x-admin-token": "s3cr3t-admin" } });
check("cron: heartbeat row written by scheduled()", Number((afterCron.body as Record<string, number>).cron_heartbeats) > 0, afterCron.body);

console.log(`\n${passed} checks passed — every binding exercised end to end.`);
for (const c2 of cleanup.reverse()) try { c2(); } catch {}
process.exit(0);

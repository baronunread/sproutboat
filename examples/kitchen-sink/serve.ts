#!/usr/bin/env bun
/**
 * Like harness.ts but it stays up: compile the worker for the host, start the
 * broker + a stub upstream, boot the worker, print the URLs, and wait.
 *
 *   bun examples/kitchen-sink/serve.ts
 *
 * Ctrl-C to stop. This is a dev convenience, not the platform path.
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wrapNativeFetchHandler, type Bindings } from "../../tools/compile";
import { parseConfig } from "../../packages/config/src/config";
import { createBroker, listen } from "../../services/broker/src/broker";
import { walkAssets, type AssetManifest } from "../../tools/assets";
import { buildWebUi } from "./build-web";

const HERE = import.meta.dir;
const ROOT = join(HERE, "../..");
const PORF = join(ROOT, "node_modules/porffor/runtime/index.js");
const workdir = mkdtempSync(join(tmpdir(), "sb-kitchen-serve-"));

const cfg = parseConfig(readFileSync(join(HERE, "sproutboat.jsonc"), "utf8"));
if (!cfg.ok) { console.error(cfg.errors.join("; ")); process.exit(1); }
const c = cfg.value;

const QUOTES = [
  { content: "Simplicity is prerequisite for reliability.", author: "Edsger Dijkstra" },
  { content: "Make it work, make it right, make it fast.", author: "Kent Beck" },
  { content: "Programs must be written for people to read.", author: "Harold Abelson" },
  { content: "The cheapest, fastest, most reliable components are those that aren't there.", author: "Gordon Bell" },
];
const upstream = Bun.serve({ port: 0, fetch: () => Response.json(QUOTES[Math.floor(Date.now() / 4000) % QUOTES.length]) });
const upstreamHost = `127.0.0.1:${upstream.port}`;

const bindings: Bindings = {
  kv: c.kv_namespaces ?? [], secrets: c.secrets ?? [], outbound: [upstreamHost],
  d1: c.d1_databases ?? [], r2: c.r2_buckets ?? [], queues: c.queues ?? [],
  analytics: c.analytics_engine_datasets ?? [],
  do: Object.entries(c.durable_objects ?? {}).map(([binding, className]) => ({ binding, className })),
  crons: c.triggers?.crons ?? [],
  assets: c.assets?.binding ?? "",
};
const vars = { ...c.vars, QUOTE_URL: `http://${upstreamHost}/random` };

const assetsDir = join(workdir, "assets");
if (c.assets) {
  buildWebUi();
  const assetSrc = join(HERE, c.assets.directory);
  if (!existsSync(assetSrc)) { console.error(`assets dir not found: ${assetSrc}`); process.exit(1); }
  cpSync(assetSrc, assetsDir, { recursive: true });
  const assetManifest: AssetManifest = {
    notFound: c.assets.not_found_handling ?? "none",
    runSproutFirst: c.assets.run_sprout_first ?? false,
    files: walkAssets(assetsDir),
  };
  writeFileSync(join(workdir, "assets.json"), JSON.stringify(assetManifest, null, 2));
}

const prelude = readFileSync(join(ROOT, "tools/native-fetch-prelude.js"), "utf8");
const gen = join(workdir, "worker.generated.js");
const bin = join(workdir, "worker.bin");
writeFileSync(gen, wrapNativeFetchHandler(readFileSync(join(HERE, "src/index.js"), "utf8"), prelude, vars, bindings));

console.log("compiling worker (host native)…");
const compile = Bun.spawnSync(["node", PORF, "native", gen, "-o", bin], {
  env: { ...process.env, PATH: `${join(ROOT, "node_modules/.bin")}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe",
});
if (compile.exitCode !== 0) { console.error(compile.stderr.toString() + compile.stdout.toString()); process.exit(1); }

const TOKEN = "dev-token";
const workerPort = Number(process.env.PORT) || 8787;
const broker = createBroker({
  db: join(workdir, "state.sqlite"), dataDir: join(workdir, "d1"), token: TOKEN, bindings,
  secrets: { ADMIN_TOKEN: "s3cr3t-admin" }, workerUrl: `http://127.0.0.1:${workerPort}/`,
  assetsDir: c.assets ? assetsDir : undefined,
});
const brokerServer = listen(broker, "127.0.0.1", 0);
const worker = Bun.spawn([bin], {
  env: { ...process.env, PORT: String(workerPort), SB_BROKER_PORT: String(brokerServer.port), SB_BROKER_TOKEN: TOKEN },
  stdout: "inherit", stderr: "inherit",
});

const stop = () => { worker.kill(9); brokerServer.stop(); broker.close(); upstream.stop(true); rmSync(workdir, { recursive: true, force: true }); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

const base = `http://127.0.0.1:${workerPort}`;
for (let i = 0; i < 100; i++) { try { await fetch(base + "/"); break; } catch { await Bun.sleep(50); } }
console.log(`\n  worker   ${base}`);
console.log(`  broker   127.0.0.1:${brokerServer.port}  (state: ${workdir})`);
console.log(`\n  open ${base}/ in a browser for the UI, or:`);
console.log(`    curl ${base}/`);
console.log(`    TOKEN=$(curl -s -XPOST ${base}/login | bun -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).token))')`);
console.log(`    curl -H "authorization: Bearer $TOKEN" ${base}/whoami`);
console.log(`    curl -XPOST ${base}/notes -d '{"title":"hi","body":"there"}'`);
console.log(`    curl ${base}/notes`);
console.log(`    curl ${base}/notes/1        # DO view counter, run twice`);
console.log(`    curl ${base}/quote`);
console.log(`    curl -H "x-admin-token: s3cr3t-admin" ${base}/admin/stats`);
console.log(`\n  Ctrl-C to stop.`);
await worker.exited;

// Runs the app on workerd through Miniflare (what `wrangler dev --local` runs): the D1 binding is
// workerd's cloudflare-internal:d1-api client, backed by Miniflare's D1 Durable Object (SQLite storage).
// usage: node mf.mjs PORT PERSIST_DIR APP.js
import { Miniflare, Log, LogLevel } from "miniflare";
import { readFileSync } from "node:fs";
const [port, persist, app] = process.argv.slice(2);
const mf = new Miniflare({
  log: new Log(LogLevel.WARN),
  modules: true,
  script: readFileSync(app, "utf8"),
  scriptPath: app,
  compatibilityDate: process.env.COMPAT || "2026-09-27",
  host: "0.0.0.0",
  port: Number(port),
  cf: false,
  durableObjects: { DBDO: { className: "Db", useSQLite: true } },
  durableObjectsPersist: persist,
  bindings: { JWT_SECRET: "twelve-dollar-challenge" },
});
await mf.ready;
console.log(JSON.stringify({ ready: true, port: Number(port), pid: process.pid }));
process.on("SIGTERM", async () => {
  await mf.dispose();
  process.exit(0);
});

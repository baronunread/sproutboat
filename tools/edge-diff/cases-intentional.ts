/**
 * Behaviour the Rust edge deliberately changes. Bun's result is printed for reference; the Rust run is
 * asserted against the new expectation. These never fail the exit code unless the assertion fails.
 */
import { gzipSync } from "node:zlib";
import type { Json } from "./lib";
import type { Case } from "./runner";
import { asRecord } from "./json";
import { FILES } from "./cases-assets";
import { supCase, get, supRoute } from "./helpers";

const G = "intentional";
const text = (obs: { body: Uint8Array }) => Buffer.from(obs.body).toString("utf8");
const PATHY = /\/(Users|tmp|private|var|home|srv)\/|\.(ts|rs)\b|<html|<!doctype/i;

/** The `rawUrl` field of the fake app's JSON answer, or undefined when the body is not such an object. */
function rawUrlOf(body: string): Json | undefined {
  try {
    const parsed: Json = JSON.parse(body);
    return asRecord(parsed)?.rawUrl;
  } catch {
    return undefined;
  }
}

export const intentionalCases: Case[] = [
  {
    id: "intentional-pool-loopback-only",
    group: G,
    intentional: {
      reason:
        "/__sb/pool answers only for Host localhost / 127.0.0.1 / [::1]; a deployment host must not expose pool stats",
      assertRust: (run, h) => {
        const out: string[] = [];
        for (const label of ["Host localhost", "Host 127.0.0.1", "Host [::1]"]) {
          const o = h.http(run, label);
          if (!o || o.status !== 200 || !text(o).includes('"live"'))
            out.push(`${label}: expected pool stats, got ${o?.status} ${o ? text(o).slice(0, 60) : ""}`);
        }
        for (const label of ["Host of a deployment", "Host unknown"]) {
          const o = h.http(run, label);
          if (!o || text(o).includes('"live"') || text(o).includes('"portPoolSize"'))
            out.push(`${label}: pool stats leaked`);
        }
        return out;
      },
    },
    run: async (ctx) => {
      await get(ctx, "Host localhost", "/__sb/pool", { host: "localhost:8080" });
      await get(ctx, "Host 127.0.0.1", "/__sb/pool", { host: "127.0.0.1:8080" });
      await get(ctx, "Host [::1]", "/__sb/pool", { host: "[::1]:8080" });
      await get(ctx, "Host of a deployment", "/__sb/pool", { host: "app.test" });
      await get(ctx, "Host unknown", "/__sb/pool", { host: "nope.test" });
    },
  },
  {
    id: "intentional-no-html-error-page",
    group: G,
    setup: async (fx) => [
      await supRoute(fx, "app.test", "app", {
        assets: {
          files: { "index.html": "x" },
          rawManifest: JSON.stringify({
            notFound: "none",
            runSproutFirst: false,
            files: {
              "/index.html": { hash: "h", size: 1, type: "text/html" },
              "/ghost.html": { hash: "g", size: 5, type: "text/html" },
            },
          }),
        },
      }),
    ],
    intentional: {
      reason:
        "Bun answers these with its 50 KB HTML dev error page; Rust sends a small plain-text 400/500 with no paths or source, and logs the request",
      assertRust: (run, h) => {
        const out: string[] = [];
        for (const label of [
          "HTTP/1.0 without Host",
          "empty Host",
          "malformed percent path",
          "asset missing on disk",
        ]) {
          const o = h.http(run, label);
          if (!o) {
            out.push(`${label}: no observation`);
            continue;
          }
          const ct = o.headers.find(([n]) => n === "content-type")?.[1] ?? "";
          if (![400, 404, 500].includes(o.status)) out.push(`${label}: status ${o.status}`);
          if (!ct.startsWith("text/plain")) out.push(`${label}: content-type ${JSON.stringify(ct)}`);
          if (o.body.length > 512 || PATHY.test(text(o)))
            out.push(`${label}: body is large or leaks paths/source: ${JSON.stringify(text(o).slice(0, 80))}`);
        }
        if (h.events(run).length < 4) out.push(`expected a log line per request, got ${h.events(run).length}`);
        return out;
      },
    },
    run: async (ctx) => {
      await ctx.req("HTTP/1.0 without Host", { path: "/x", host: null, httpVersion: "1.0", loose: { body: true } });
      await ctx.req("empty Host", { path: "/x", host: "", loose: { body: true } });
      await get(ctx, "malformed percent path", "/%E0%A4%A", { loose: { body: true } });
      await get(ctx, "asset missing on disk", "/ghost.html", { loose: { body: true } });
    },
  },
  ...supCase("intentional-gzip-passthrough", G, () => ({
    intentional: {
      reason:
        "an upstream gzip body and its content-encoding are forwarded unchanged (Bun's fetch decodes the body but leaves the header)",
      assertRust: (run, h) => {
        const o = h.http(run, "gzip");
        if (!o) return ["no response"];
        const out: string[] = [];
        const expected = gzipSync(Buffer.from("hello gzip ".repeat(200)));
        if (o.headers.find(([n]) => n === "content-encoding")?.[1] !== "gzip")
          out.push("content-encoding: gzip missing");
        if (Buffer.compare(Buffer.from(o.body), expected) !== 0)
          out.push(`body is not the upstream bytes (${o.body.length} vs ${expected.length})`);
        return out;
      },
    },
    run: async (ctx) => {
      await get(ctx, "gzip", "/gzip", { headers: { "accept-encoding": "gzip" } });
      await get(ctx, "gzip without accept-encoding", "/gzip");
    },
  })),
  ...supCase("intentional-deadline-covers-headers-only", G, () => ({
    env: { SPROUTBOAT_REQUEST_TIMEOUT_MS: "1000" },
    timeoutMs: 40_000,
    intentional: {
      reason:
        "the request deadline applies to the response headers only: a stream that outlives it completes, and an idle WebSocket stays open",
      assertRust: (run, h) => {
        const out: string[] = [];
        const sse = h.http(run, "SSE for 2.5 s");
        if (!sse || sse.status !== 200 || !sse.complete || !text(sse).includes("data: done"))
          out.push(`SSE did not complete: ${sse?.status} complete=${sse?.complete} ${sse?.error ?? ""}`);
        const ws = h.note(run, "idle websocket after 6 s");
        if (JSON.stringify(ws) !== JSON.stringify({ open: true, echo: "echo:still here" }))
          out.push(`idle websocket: ${JSON.stringify(ws)}`);
        return out;
      },
    },
    run: async (ctx) => {
      await get(ctx, "SSE for 2.5 s", "/sse?ms=2500", { timeoutMs: 10_000 });
      const c = await ctx.ws("/pinger");
      await ctx.sleep(6000);
      c.send("still here");
      const echo = await c.next(3000);
      ctx.note("idle websocket after 6 s", { open: c.opened, echo });
      c.close();
    },
  })),
  {
    id: "intentional-sighup-invalid-routes",
    group: G,
    logs: "off",
    setup: async (fx) => [await supRoute(fx, "app.test", "a")],
    intentional: {
      reason:
        "SIGHUP with an invalid routes.json keeps the process alive and the old routes (Bun dies of an unhandled rejection); the error goes to stderr",
      assertRust: (run, h) => {
        const out: string[] = [];
        const alive = h.note(run, "after SIGHUP");
        if (JSON.stringify(alive) !== JSON.stringify([200, "a"])) out.push(`after SIGHUP: ${JSON.stringify(alive)}`);
        if (h.note(run, "process alive") !== true) out.push("process died");
        if (!run.stderr.trim()) out.push("stderr is empty");
        return out;
      },
    },
    run: async (ctx) => {
      await get(ctx, "before", "/who");
      ctx.writeRoutes("{{{ nope");
      ctx.hup();
      await ctx.sleep(500);
      const res = await ctx.quiet({ path: "/who", timeoutMs: 3000 });
      let app = "?";
      try {
        const parsed: Json = JSON.parse(Buffer.from(res.body).toString());
        const record = asRecord(parsed);
        if (record !== null) app = String(record.app);
      } catch {
        // not json
      }
      ctx.note("after SIGHUP", [res.status, app]);
      ctx.note("process alive", ctx.edge.proc.exitCode === null);
    },
  },
  {
    id: "intentional-more-events-logged",
    group: G,
    env: { SPROUTBOAT_EDGE_MAX_BODY_BYTES: "1024" },
    intentional: {
      reason:
        "Rust also logs: apex redirect 302, 413 on the body cap, client hang-up 499, a mid-body upstream error, 'direct transfers unavailable' 503 and a WebSocket close",
      assertRust: (run, h) => {
        const events = h.events(run);
        const out: string[] = [];
        const has = (name: string, pred: (e: Record<string, Json>) => boolean) => {
          if (!events.some(pred)) out.push(`no log line for ${name}`);
        };
        has("apex redirect 302", (e) => e.status === 302 && e.hostname === "sproutboat.test");
        has("413 on the body cap, with its path", (e) => e.status === 413 && e.path === "/upload");
        has("client hang-up 499", (e) => e.status === 499);
        has("mid-body upstream error", (e) => e.path === "/dropmid");
        has("direct transfers unavailable 503", (e) => e.status === 503);
        const echoes = events.filter((e) => e.path === "/echo");
        if (echoes.length < 2 || echoes[0]?.status !== 101)
          out.push("no log line for the WebSocket close (expected a second /echo event after the 101)");
        else if (echoes[1]?.closedBy !== "client" || echoes[1]?.closeCode !== 1000 || echoes[1]?.reqBytes !== 1)
          out.push(`WebSocket close line lacks closedBy/closeCode/reqBytes: ${JSON.stringify(echoes[1])}`);
        const transfer = h.http(run, "direct transfer");
        if (transfer && (transfer.status !== 503 || !text(transfer).includes("direct transfers unavailable")))
          out.push(`direct transfer answered ${transfer.status} ${text(transfer)}`);
        return out;
      },
    },
    run: async (ctx) => {
      await get(ctx, "apex redirect", "/", { host: "sproutboat.test" });
      await ctx.req("body over the cap", { method: "POST", path: "/upload", body: new Uint8Array(4000) });
      await get(ctx, "warm the sprout", "/hello");
      await get(ctx, "hang-up", "/hang", { hangUpAfterMs: 200 });
      await ctx.sleep(200);
      await get(ctx, "mid-body upstream error", "/dropmid", { loose: { body: true } });
      await get(ctx, "direct transfer", "/__sb/r2/transfer/BUCKET/" + "a".repeat(24));
      const c = await ctx.ws("/echo");
      c.send("x");
      await c.next();
      c.close(1000, "bye");
      await Promise.race([c.closed, ctx.sleep(2000)]);
      await ctx.sleep(300);
    },
  },
  {
    id: "intentional-asset-range-206",
    group: G,
    setup: async (fx) => [await supRoute(fx, "app.test", "app", { assets: { files: FILES } })],
    intentional: {
      reason: "a Range request on an asset is answered 206 with the slice and Content-Range, and the log records 206",
      assertRust: (run, h) => {
        const o = h.http(run, "Range 0-9");
        if (!o) return ["no response"];
        const out: string[] = [];
        if (o.status !== 206) out.push(`status ${o.status}`);
        if (o.body.length !== 10) out.push(`body is ${o.body.length} bytes`);
        const cr = o.headers.find(([n]) => n === "content-range")?.[1];
        if (cr !== `bytes 0-9/${300 * 1024}`) out.push(`content-range ${cr}`);
        const e = h.events(run).find((x) => x.path === "/big.bin");
        if (!e || e.status !== 206) out.push(`log event: ${JSON.stringify(e)}`);
        else if (e.resBytes !== 10 && e.resBytes !== 300 * 1024)
          out.push(`resBytes ${JSON.stringify(e.resBytes)} is neither the slice nor the file size`);
        return out;
      },
    },
    run: async (ctx) => {
      await get(ctx, "Range 0-9", "/big.bin", { headers: { range: "bytes=0-9" } });
    },
  },
  {
    id: "intentional-services-change-restarts-sprout",
    group: G,
    setup: async (fx) => [{ ...(await supRoute(fx, "app.test", "app")), services: { BIND: "other.test" } }],
    intentional: {
      reason:
        "changing a route's `services` on reload disposes and restarts the sprout and purges its cache (Bun compares only sproutPath, secrets hash and r2)",
      assertRust: (run, h) => {
        const out: string[] = [];
        const events = h.events(run).filter((e) => e.path === "/gen");
        const last = events.at(-1);
        if (events.length < 3 || last?.coldStart !== true)
          out.push(`the request after the change should be a cold start: ${JSON.stringify(last)}`);
        const second = h.http(run, "after services change");
        if (!second || second.headers.find(([n]) => n === "sb-cache")?.[1] !== "MISS")
          out.push("cache entry survived the change");
        return out;
      },
    },
    run: async (ctx) => {
      const q = "/gen?cc=public%2C%20max-age%3D60";
      await get(ctx, "before", q);
      await get(ctx, "hit", q);
      ctx.writeRoutes([
        { hostname: "app.test", sproutPath: ctx.fx.sprouts.get("app")!, services: { BIND: "changed.test" } },
      ]);
      await ctx.sleep(400);
      await get(ctx, "after services change", q);
    },
  },
  ...supCase("intentional-leading-double-slash-path", G, () => ({
    intentional: {
      reason:
        "a request path that starts with // is forwarded and logged as received (Bun drops the first slash upstream: //seen//x arrives as /seen//x)",
      assertRust: (run, h) => {
        const o = h.http(run, "double slash");
        const out: string[] = [];
        const seen = o ? rawUrlOf(text(o)) : undefined;
        if (seen !== "//seen//x") out.push(`upstream saw ${JSON.stringify(seen)}`);
        if (!h.events(run).some((e) => e.path === "//seen//x")) out.push("log path is not the received path");
        return out;
      },
    },
    run: async (ctx) => {
      await get(ctx, "double slash", "//seen//x");
    },
  })),
];

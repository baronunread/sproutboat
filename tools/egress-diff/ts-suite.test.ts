/**
 * The service tests of @sproutboat/wire's egress.test.ts, run against the Rust binary
 * instead of `createEgressHandler` (the last test there, `vettedFetch` with an injected
 * `fetchImpl`, is a TS library seam; its Rust counterpart is
 * `falls_through_only_when_an_address_cannot_be_connected` in services/egress-rs/tests).
 *
 *   SB_EGRESS_RS_BIN=services/egress-rs/target/release/sproutboat-egress bun test tools/egress-diff/ts-suite.test.ts
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { createBroker } from "@sproutboat/wire/broker";
import { EGRESS_ERROR_HEADER, EGRESS_TOKEN_HEADER, EGRESS_URL_HEADER } from "@sproutboat/wire/egress";

const BIN =
  process.env.SB_EGRESS_RS_BIN ?? resolve(import.meta.dir, "../../services/egress-rs/target/release/sproutboat-egress");
const TOKEN = "egress-test-token";
const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

function upstream() {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/gzip")
        return new Response(gzipSync("compressed hello"), { headers: { "content-encoding": "gzip" } });
      if (path === "/redirect") return new Response(null, { status: 302, headers: { location: "http://127.0.0.2/" } });
      return Response.json(
        { method: request.method, body: await request.text(), host: request.headers.get("host") },
        { status: 201, headers: { "x-upstream": "1" } },
      );
    },
  });
  stops.push(() => server.stop(true));
  return server;
}

let proc: Bun.Subprocess<"ignore", "pipe", "inherit">;
let serviceUrl = new URL("http://127.0.0.1:0/");
beforeAll(async () => {
  proc = Bun.spawn([BIN, "--host", "127.0.0.1", "--port", "0", "--tcp-port", "0"], {
    env: { ...process.env, SB_EGRESS_TOKEN: TOKEN, SB_EGRESS_ALLOW: "127.0.0.1" },
    stdout: "pipe",
    stderr: "inherit",
  });
  const reader = proc.stdout.getReader();
  let out = "";
  while (!/listening on http:\/\/127\.0\.0\.1:(\d+)\//.test(out)) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`egress did not start: ${out}`);
    out += new TextDecoder().decode(value);
  }
  const port = /listening on http:\/\/127\.0\.0\.1:(\d+)\//.exec(out)?.[1] ?? "0";
  serviceUrl = new URL(`http://127.0.0.1:${port}/`);
  void (async () => {
    while (!(await reader.read()).done);
  })();
});
afterAll(() => proc.kill("SIGTERM"));

const call = (target: string, init: RequestInit = {}, token = TOKEN) =>
  fetch(serviceUrl, {
    ...init,
    headers: {
      ...Object.fromEntries(new Headers(init.headers)),
      [EGRESS_URL_HEADER]: target,
      [EGRESS_TOKEN_HEADER]: token,
    },
  });

test("#252: the service relays a request and its response, Host set to the target's name", async () => {
  const up = upstream();
  const res = await call(`http://localhost:${up.port}/x`, { method: "POST", body: "payload" });
  expect(res.status).toBe(201);
  expect(res.headers.get("x-upstream")).toBe("1");
  expect(await res.json()).toEqual({ method: "POST", body: "payload", host: `localhost:${up.port}` });
});

test("#252: compressed bodies and redirects pass through as a direct fetch would see them", async () => {
  const up = upstream();
  const gz = await call(`http://127.0.0.1:${up.port}/gzip`);
  expect([gz.headers.get("content-encoding"), await gz.text()]).toEqual(["gzip", "compressed hello"]);
  const hop = await call(`http://127.0.0.1:${up.port}/redirect`, { redirect: "manual" });
  expect([hop.status, hop.headers.get("location")]).toEqual([302, "http://127.0.0.2/"]);
});

test("#252: without the token the service does nothing", async () => {
  const up = upstream();
  const res = await call(`http://127.0.0.1:${up.port}/`, {}, "wrong-token-of-same-size");
  expect(res.status).toBe(401);
});

test("#252: the service refuses private addresses with the #174 message", async () => {
  const res = await call("http://169.254.169.254/latest/meta-data/");
  expect(res.headers.get(EGRESS_ERROR_HEADER)).toBe("1");
  expect(await res.json()).toEqual({
    error:
      "fetch() refused: 169.254.169.254 resolves to 169.254.169.254, a private or reserved address (169.254.0.0/16). An operator can allow it with SB_EGRESS_ALLOW=169.254.169.254",
  });
});

test("#252: a broker given SB_EGRESS_URL fetches through the service, refusals included", async () => {
  const up = upstream();
  const broker = createBroker({
    egressUrl: serviceUrl.href,
    egressToken: TOKEN,
    egressAllow: [],
    resolveImpl: async () => [{ address: "127.0.0.1" }],
  });
  stops.push(() => broker.close());
  const ok = await broker.dispatch({ op: "fetch", url: `http://127.0.0.1:${up.port}/gzip` });
  expect(ok).toMatchObject({ ok: true, status: 200, body: "compressed hello" });
  await expect(broker.dispatch({ op: "fetch", url: "http://10.0.0.1/" })).rejects.toThrow(
    "fetch() refused: 10.0.0.1 resolves to 10.0.0.1",
  );
  const stranger = createBroker({ egressUrl: serviceUrl.href, egressToken: "not-the-token" });
  stops.push(() => stranger.close());
  await expect(stranger.dispatch({ op: "fetch", url: `http://127.0.0.1:${up.port}/` })).rejects.toThrow(
    "rejected this broker's token",
  );
});

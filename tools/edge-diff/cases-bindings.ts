/**
 * Service-binding calls (#48): a caller's broker sends `x-sb-edge-secret` to the edge with the callee's
 * Host. The edge vouches for the call to the callee (`x-sb-binding-call`, the callee's own
 * `x-sb-edge-token`, the caller's `x-sb-url`) only when the credential is one the supervisor registered
 * for a broker AND the Host is in that broker's `services` map (#339). Anything else is an ordinary
 * public request whose internal headers are stripped.
 *
 * The harness registers known credentials in both edges (credentials-sync.ts), because the real ones
 * are random per process. Some cases call the edge directly as a broker would; the `chain` cases run
 * a real chain: client -> app A (cold) -> edge (A's credential) -> app B (cold).
 */
import type { Fixture, Json } from "./lib";
import type { Case, Ctx } from "./runner";
import { asRecord, isString } from "./json";
import { get, hdrs, json, supRoute } from "./helpers";

const G = "bindings";

// Deterministic stand-ins for a broker's 192-bit random credential.
const CRED_A = "a1".repeat(24);
const CRED_C = "c3".repeat(24);
const SECRET = "x-sb-edge-secret";

/** What a callee saw of the vouching headers (the token is random per sprout, so only its presence counts). */
function vouch(body: Json): Json {
  const seen = asRecord(body);
  const headers = asRecord(seen?.headers ?? null) ?? {};
  const view: Record<string, Json> = {};
  for (const key of Object.keys(headers).filter((k) => k.startsWith("x-sb-")))
    view[key] = key === "x-sb-edge-token" ? (headers[key] ? "<token>" : "<empty>") : (headers[key] ?? null);
  return { app: seen?.app ?? null, vouch: view, body: seen?.body ?? null };
}

const routes = async (fx: Fixture): Promise<Json[]> => [
  { ...(await supRoute(fx, "a.test", "a")), services: { B: "b.test" } },
  await supRoute(fx, "b.test", "b"),
  { ...(await supRoute(fx, "c.test", "c")), services: { B: "b.test", C: "c.test" } },
];

const asBroker = (credential: string, extra: Record<string, string> = {}) => ({ [SECRET]: credential, ...extra });

async function seen(ctx: Ctx, label: string, host: string, headers: Record<string, string>) {
  // The callee's answer carries its random edge token: the note below is the comparison.
  const obs = await ctx.req(label, { path: "/seen", host, headers, loose: { body: true } });
  ctx.note(`${label}: callee saw`, vouch(json(obs)));
  return obs;
}

const credentials = { [CRED_A]: ["b.test"], [CRED_C]: ["b.test", "c.test"] };
const callerEnv = { EDGE_DIFF_CRED_A: CRED_A, EDGE_DIFF_CRED_C: CRED_C, EDGE_DIFF_CRED_BAD: "00".repeat(24) };

export const bindingCases: Case[] = [
  {
    id: "binding-allowed",
    group: G,
    credentials,
    setup: routes,
    run: async (ctx) => {
      // The first call also cold-starts the callee: the vouch must wait for its token.
      await seen(
        ctx,
        "A's credential to B (cold callee)",
        "b.test",
        asBroker(CRED_A, { "x-sb-url": "https://a.example/x" }),
      );
      await seen(ctx, "again (warm)", "b.test", asBroker(CRED_A));
      await seen(ctx, "C's credential to B", "b.test", asBroker(CRED_C, { "x-sb-url": "https://c.example/" }));
      await seen(ctx, "C's credential to C", "c.test", asBroker(CRED_C));
      await seen(ctx, "upper-case host with port", "B.TEST:8080", asBroker(CRED_A));
      const echo = await ctx.req("POST body through a binding call", {
        method: "POST",
        path: "/echo",
        host: "b.test",
        body: "payload",
        headers: asBroker(CRED_A),
      });
      ctx.note("echo", Buffer.from(echo.body).toString());
      // The credential never reaches the callee, whatever the outcome.
      await seen(ctx, "no x-sb-url", "b.test", asBroker(CRED_A));
      const twiceUrl = await ctx.req("x-sb-url sent twice", {
        path: "/seen",
        loose: { body: true },
        host: "b.test",
        headers: hdrs([SECRET, CRED_A], ["x-sb-url", "https://a.example/1"], ["x-sb-url", "https://a.example/2"]),
      });
      ctx.note("x-sb-url twice: callee saw", vouch(json(twiceUrl)));
    },
  },
  {
    id: "binding-host-not-in-services",
    group: G,
    credentials,
    setup: routes,
    run: async (ctx) => {
      await seen(
        ctx,
        "A's credential to C (not in A's services)",
        "c.test",
        asBroker(CRED_A, { "x-sb-url": "https://a.example/" }),
      );
      await seen(ctx, "A's credential to A itself", "a.test", asBroker(CRED_A));
      await seen(ctx, "A's credential to an unknown host", "nope.test", asBroker(CRED_A));
      await seen(ctx, "trailing dot is another host", "b.test.", asBroker(CRED_A));
      await seen(ctx, "subdomain of an allowed host", "x.b.test", asBroker(CRED_A));
      await seen(ctx, "allowed host still works", "b.test", asBroker(CRED_A));
      // A refused call is an ordinary request: the callee's uncaught marker is hidden from it.
      await ctx.req("refused call to a throwing handler", {
        path: "/marker",
        host: "c.test",
        headers: asBroker(CRED_A),
      });
      await ctx.req("allowed call to a throwing handler", {
        path: "/marker",
        host: "b.test",
        headers: asBroker(CRED_A),
      });
    },
  },
  {
    id: "binding-wrong-credential",
    group: G,
    credentials,
    setup: routes,
    run: async (ctx) => {
      await seen(ctx, "valid", "b.test", asBroker(CRED_A));
      await seen(ctx, "all zeros", "b.test", asBroker("00".repeat(24)));
      await seen(ctx, "one character short", "b.test", asBroker(CRED_A.slice(0, -1)));
      await seen(ctx, "one character long", "b.test", asBroker(`${CRED_A}0`));
      await seen(ctx, "upper case", "b.test", asBroker(CRED_A.toUpperCase()));
      await seen(ctx, "padded with spaces", "b.test", asBroker(` ${CRED_A} `));
      await seen(ctx, "empty", "b.test", asBroker(""));
      await seen(ctx, "another host's name", "b.test", asBroker("b.test"));
      const twice = await ctx.req("the header sent twice, valid one first", {
        path: "/seen",
        host: "b.test",
        headers: hdrs([SECRET, CRED_A], [SECRET, CRED_A]),
      });
      ctx.note("twice: callee saw", vouch(json(twice)));
      const mixed = await ctx.req("the header sent twice, wrong one first", {
        path: "/seen",
        host: "b.test",
        headers: hdrs([SECRET, "00".repeat(24)], [SECRET, CRED_A]),
      });
      ctx.note("mixed: callee saw", vouch(json(mixed)));
    },
  },
  {
    id: "binding-credential-expired",
    group: G,
    credentials,
    setup: routes,
    run: async (ctx) => {
      await seen(ctx, "live", "b.test", asBroker(CRED_A));
      await ctx.setCredentials({ [CRED_C]: ["b.test", "c.test"] }); // A's broker exited
      await seen(ctx, "after A's broker exited", "b.test", asBroker(CRED_A));
      await seen(ctx, "C's still works", "b.test", asBroker(CRED_C));
      await ctx.setCredentials({}); // the last one exited
      await seen(ctx, "after every broker exited", "b.test", asBroker(CRED_C));
      await ctx.setCredentials({ [CRED_A]: ["c.test"] }); // A restarted with another services map
      await seen(ctx, "restarted with a different map: old host", "b.test", asBroker(CRED_A));
      await seen(ctx, "restarted with a different map: new host", "c.test", asBroker(CRED_A));
    },
  },
  {
    id: "binding-chain-allowed",
    group: G,
    credentials,
    env: callerEnv,
    setup: routes,
    run: async (ctx) => {
      const first = await get(ctx, "client -> A -> B, both cold", "/call?cred=A&to=b.test&path=/seen", {
        host: "a.test",
        loose: { body: true },
      });
      ctx.note("callee saw", vouch(json(first)));
      ctx.note("callee status", first.headers.find(([k]) => k === "x-callee-status")?.[1] ?? null);
      const warm = await get(ctx, "again, both warm", "/call?cred=A&to=b.test&path=/seen", {
        host: "a.test",
        loose: { body: true },
      });
      ctx.note("warm: callee saw", vouch(json(warm)));
      const post = await ctx.req("POST body through the chain", {
        method: "POST",
        path: "/call?cred=A&to=b.test&path=/echo",
        host: "a.test",
        body: "chain payload",
      });
      ctx.note("post", Buffer.from(post.body).toString());
    },
  },
  {
    id: "binding-chain-refused",
    group: G,
    credentials,
    env: callerEnv,
    setup: routes,
    run: async (ctx) => {
      for (const [label, cred, to] of [
        ["A calls C (not in A's services)", "A", "c.test"],
        ["A calls an unknown host", "A", "nope.test"],
        ["wrong credential", "BAD", "b.test"],
        ["no credential", "NONE", "b.test"],
      ] as const) {
        const obs = await get(ctx, label, `/call?cred=${cred}&to=${to}&path=/seen`, {
          host: "a.test",
          loose: { body: true },
        });
        ctx.note(`${label}: callee status`, obs.headers.find(([k]) => k === "x-callee-status")?.[1] ?? null);
        ctx.note(`${label}: callee saw`, vouch(json(obs)));
      }
    },
  },
  {
    id: "binding-chain-expired",
    group: G,
    credentials,
    env: callerEnv,
    setup: routes,
    run: async (ctx) => {
      const call = async (label: string) => {
        const obs = await get(ctx, label, "/call?cred=A&to=b.test&path=/seen", {
          host: "a.test",
          loose: { body: true },
        });
        ctx.note(`${label}: callee saw`, vouch(json(obs)));
      };
      await call("while A's broker lives");
      await ctx.setCredentials({});
      await call("after A's broker exited");
      await ctx.setCredentials(credentials);
      await call("after it came back");
    },
  },
  {
    id: "binding-chain-stream",
    group: G,
    credentials,
    env: callerEnv,
    setup: routes,
    run: async (ctx) => {
      const big = await get(
        ctx,
        "300 KB chunked stream through the chain",
        "/call?cred=A&to=b.test&path=%2Fstream%3Fn%3D300000%26chunk%3D1000",
        {
          host: "a.test",
        },
      );
      ctx.note("streamed bytes", big.body.length);
      await get(ctx, "stall mid-body", "/call?cred=A&to=b.test&path=%2Fstall%3Fms%3D300", { host: "a.test" });
      await get(ctx, "sse", "/call?cred=A&to=b.test&path=%2Fsse%3Fms%3D600", { host: "a.test" });
      await get(ctx, "content-length body (200 KB)", "/call?cred=A&to=b.test&path=%2Fbig%3Fn%3D200000", {
        host: "a.test",
      });
    },
  },
  {
    id: "binding-stream-request-body",
    group: G,
    credentials,
    setup: routes,
    run: async (ctx) => {
      const chunked = await ctx.req("chunked request body to B", {
        method: "POST",
        path: "/echo",
        host: "b.test",
        chunks: ["one-", "two-", "three"],
        chunkDelayMs: 20,
        headers: asBroker(CRED_A),
      });
      ctx.note("echo", Buffer.from(chunked.body).toString());
      await ctx.req("upload 1 MiB", {
        method: "POST",
        path: "/upload",
        host: "b.test",
        body: new Uint8Array(1024 * 1024).fill(0x62),
        headers: asBroker(CRED_A),
      });
      await ctx.req("streamed response", {
        path: "/stream?n=100000&chunk=500",
        host: "b.test",
        headers: asBroker(CRED_A),
      });
    },
  },
  {
    id: "binding-target-5xx",
    group: G,
    credentials,
    setup: routes,
    run: async (ctx) => {
      const as = asBroker(CRED_A);
      // The edge forwards a callee's 5xx and, for a binding call only, keeps the uncaught marker.
      for (const [label, path] of [
        ["500", "/status/500"],
        ["502", "/status/502"],
        ["503 busy", "/busy"],
        ["504", "/status/504"],
        ["deliberate 500 with a body", "/deliberate"],
        ["bare 500 from a throwing handler", "/uncaught"],
        ["500 with a marker, no content-length", "/uncaught-nolen"],
        ["500 with an uncaught marker", "/marker"],
        ["200 carrying a marker", "/uncaught-200"],
        ["connection reset", "/crash"],
      ] as const) {
        await ctx.req(label, {
          path,
          host: "b.test",
          headers: as,
          loose: label === "connection reset" ? { body: true } : undefined,
        });
      }
      await ctx.req("marker, not a binding call", { path: "/marker", host: "b.test" });
      await ctx.req("bare 500, not a binding call", { path: "/uncaught", host: "b.test" });
    },
  },
  {
    id: "binding-chain-target-5xx",
    group: G,
    credentials,
    env: callerEnv,
    setup: routes,
    run: async (ctx) => {
      for (const [label, path] of [
        ["503 busy", "/busy"],
        ["500", "/status/500"],
        ["bare 500 from a throwing handler", "/uncaught"],
        ["500 with an uncaught marker", "/marker"],
        ["200 carrying a marker", "/uncaught-200"],
      ] as const) {
        const obs = await get(ctx, `B answers ${label}`, `/call?cred=A&to=b.test&path=${encodeURIComponent(path)}`, {
          host: "a.test",
        });
        ctx.note(`${label}: callee status`, obs.headers.find(([k]) => k === "x-callee-status")?.[1] ?? null);
        ctx.note(`${label}: marker seen by A`, obs.headers.find(([k]) => k === "x-callee-uncaught")?.[1] ?? null);
      }
    },
  },
  {
    id: "binding-callee-down",
    group: G,
    credentials,
    env: callerEnv,
    setup: async (fx) => [
      { ...(await supRoute(fx, "a.test", "a")), services: { B: "b.test" } },
      await supRoute(fx, "b.test", "b", { script: "#!/bin/sh\nexit 1\n" }),
    ],
    run: async (ctx) => {
      await ctx.req("direct call to a callee that cannot start", {
        path: "/seen",
        host: "b.test",
        headers: asBroker(CRED_A),
      });
      const via = await get(ctx, "through the chain", "/call?cred=A&to=b.test&path=/seen", {
        host: "a.test",
        loose: { body: true },
      });
      ctx.note("callee status", via.headers.find(([k]) => k === "x-callee-status")?.[1] ?? null);
    },
  },
  {
    id: "binding-websocket",
    group: G,
    credentials,
    setup: routes,
    run: async (ctx) => {
      for (const [label, host, credential] of [
        ["allowed credential", "b.test", CRED_A],
        ["host not in services", "c.test", CRED_A],
        ["wrong credential", "b.test", "00".repeat(24)],
      ] as const) {
        const ws = await ctx.ws("/headers", {
          host,
          headers: { [SECRET]: credential, "x-sb-url": "https://a.example/" },
        });
        const frame = ws.opened ? await ws.next() : "<not opened>";
        const view = asRecord(isString(frame) ? safeParse(frame) : null) ?? {};
        ctx.note(
          label,
          Object.fromEntries(
            Object.entries(view)
              .filter(([k]) => k.startsWith("x-sb-"))
              .map(([k, v]) => [k, k === "x-sb-edge-token" ? "<token>" : v]),
          ),
        );
        ws.close();
      }
    },
  },
];

function safeParse(text: string): Json {
  try {
    const parsed: Json = JSON.parse(text);
    return parsed;
  } catch {
    return text;
  }
}

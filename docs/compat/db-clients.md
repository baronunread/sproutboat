# Database clients that need only fetch or WebSocket

2026-10-30, re-run 2026-10-31 on the released build. Question: do the HTTP and WebSocket database clients run unmodified on a Sproutboat standalone binary, with workerd (`wrangler dev`) as the reference?

Short answer: with the published CLI, two of five compile and one of those runs. With the packages change (sproutboat-packages #224, released as runtime 0.39.0 and toolchain 0.21.3, CLI 0.48.0), all five compile and run, and the comparisons with workerd that do not match are the wording of a network error. The first run (96 of 98) was on runtime 0.36.0; the re-run on the rebased build, with the Supabase and Upstash default-entry variants, matches 113 of 117 (neon 24/24, libsql 19/19, planetscale 18/18, supabase 17/18, upstash `/cloudflare` 18/19, upstash default 17/19).

## Setup

- Mac arm64 (Darwin 24.3). CLI `sproutboat` 0.44.0, re-checked against 0.45.0, published 2026-10-29T17:27Z. `0.44.0..0.45.0` touches only `tail` (`src/tail.ts`, `src/main.ts`), nothing in bundling, validation, toolchain or runtime, so every published-CLI result holds for both. The packages in both are `@sproutboat/runtime` 0.36.0 and `@sproutboat/toolchain` 0.21.0.
- Build: `sproutboat build --standalone --target host`, run with `PORT=... SB_EGRESS_ALLOW=127.0.0.1` (loopback is refused by default, see [Test artifacts](#test-artifacts)).
- Reference: `wrangler` 4.155.0, workerd 1.20261023.1, `--local`, compatibility date 2026-10-01 (the newest workerd accepts is earlier than the dates below).
- Servers, all in Docker (OrbStack): `libsql-server` (sqld), `ghcr.io/timowilhelm/local-neon-http-proxy` in front of Postgres 16 (HTTP and WebSocket), `ghcr.io/mattrobenolt/ps-http-sim` in front of MySQL 8, PostgREST with a JWT secret in front of Postgres 16, and `hiett/serverless-redis-http` (SRH) in front of Redis 7. `compose.yml`, the five Workers and the runner are in [`db-clients/`](db-clients/).
- Method: each Worker lists named cases. The runner sends `/case?c=NAME` to workerd and to the binary in order, then compares the two answers as text (the table prefix, `wd_` or `sb_`, is normalised away). A case that does not answer in 15 s is a timeout and the binary is restarted. Cases per Worker: connect, simple query, parameterized query, types, a transaction or batch where the client has one, several error cases, and 10 to 20 concurrent operations inside one request. After the cases the runner restarts the binary, sends 200 sequential and 20 parallel requests to `/q` (all returned 200 for every client), then times 40 sequential queries.
- Compatibility dates: 2026-10-22 for clients that need nothing else, 2026-11-15 for clients that need the proposed changes below. WebSocket needs 2026-11-01 or later at any rate (existing gate).

## Results

"Published" is 0.44.0 and 0.45.0 as shipped. "With PR" is the same CLI run from source on the [packages PR](#changes-in-the-packages-pr), compatibility date 2026-11-15 unless noted.

| Client (version)                                     | Compiles, published | Compiles, with PR | Build s | Binary MiB | Pass/total, published   | Pass/total, with PR           | Idle RSS MiB | After 220 requests MiB | After 40 queries MiB | Mean per query, binary vs workerd                 |
| ---------------------------------------------------- | ------------------- | ----------------- | ------: | ---------: | ----------------------- | ----------------------------- | -----------: | ---------------------: | -------------------: | ------------------------------------------------- |
| `@libsql/client/web` 0.18.0                          | yes                 | yes               |   27-34 |       6.23 | 0/19 (every case hangs) | 19/19                         |         4.92 |                   7.84 |                10.14 | 0.9 ms vs 1.0 ms                                  |
| `@neondatabase/serverless` 1.2.0, HTTP and WebSocket | no                  | yes               |   40-44 |       9.25 | not built               | 24/24 (13 HTTP, 11 WebSocket) |         6.91 |                   9.03 |                10.66 | HTTP 114 ms vs 118 ms, WebSocket 2.0 ms vs 1.8 ms |
| `@planetscale/database` 2.0.0 + `sql-escaper` 1.5.2  | no                  | yes               |      26 |       7.09 | not built               | 18/18                         |         5.34 |                   7.59 |                 9.72 | 0.6 ms vs 0.5 ms                                  |
| `@supabase/supabase-js` 2.118.0 (PostgREST)          | no                  | yes               |   37-40 |       8.72 | not built               | 17/18                         |         5.92 |                   9.42 |                11.17 | 0.8 ms vs 0.8 ms                                  |
| `@upstash/redis` 1.40.0, `/cloudflare` entry         | yes                 | yes               |   31-34 |       7.06 | 18/19                   | 18/19                         |         4.53 |                   7.73 |                 9.23 | 0.6 ms vs 0.8 ms                                  |
| `@upstash/redis` 1.40.0, default entry               | no                  | yes               |      31 |       7.13 | not built               | 17/19                         |         4.56 |                   7.78 |                 9.42 | not measured                                      |

Notes on the columns.

- Build seconds exclude the wait for `/tmp/sproutd-mac-build.lock`, which was 10 to 25 minutes because other jobs held it.
- RSS is the binary's resident set. workerd's is not given: its process is shared with wrangler's tooling, so the number would not compare.
- Per-query time is the mean of 40 sequential queries on loopback with `Date.now()`, so it has 1 ms resolution. It measures the client and the server, not the platform. The Neon HTTP figure is the local proxy opening a Postgres connection for every query. Treat 1 ms as "faster than the clock".
- Neon in stages (13/24, then 21/24, then 24/24) shows what each change buys: the validator change alone leaves the WebSocket path returning garbage rows; the typed array fix gets 21; `Error.captureStackTrace` gets the last three, all WebSocket error cases.
- PlanetScale published: the driver itself runs on the published CLI (the 9 cases that need no parameters matched workerd when run without `sql-escaper`). Version 2 no longer interpolates parameters, so a real app needs an escaper, and the one the PlanetScale README names does not pass the build check.
- Not tested: Supabase Realtime (needs a Realtime server, WebSocket client path only), GoTrue calls beyond `auth.getSession()` offline (no auth server in the stack), Storage and Functions. `createClient()` constructs all of them without error.

### The remaining two mismatches

Both are the same thing. A fetch to a closed port rejects with `Error: Network connection lost.` in workerd and `Error: sproutboat fetch: could not connect to 127.0.0.1` here. Upstash (both entries) and Supabase print it in `error-network`. Clients that branch on the message text, rather than on the rejection, are the only ones affected. Cosmetic.

## Failures and gaps

Every failure from the staged runs, classified. "Clients" counts the five tested clients it stops from running, before the fix.

| #   | Failure                                                                                                                                                                                       | Class                                           |                                                                   Clients | Fixed here                    |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------: | ----------------------------- |
| 1   | The build check refuses a bundle that only mentions `Buffer.`, `process.` or `Deno.` behind a `typeof` test, in a string, in a comment, or as a bundled `buffer` polyfill's own `Buffer`      | Bundler/CLI issue                               | 4 (Neon, Supabase, PlanetScale with `sql-escaper`, Upstash default entry) | yes, gated                    |
| 2   | `fetch()` returns a `Response`, not a promise, on the standalone host at 2026-10-22 and later, so `fetch(url).then(...)` throws `TypeError` and a refused request throws instead of rejecting | Web API gap (`fetch` return type)               |                                    1 (libsql: hrana-client calls `.then`) | yes                           |
| 3   | `fetch()` of a 204, 205 or 304 response throws `Response with null body status cannot have body`                                                                                              | Web API gap (`Response` for null-body statuses) |                                      1 (Supabase: every PostgREST delete) | yes                           |
| 4   | A `Uint8Array` subclass that redefines `toString(encoding)` gets the builtin `toString`: `Buffer` polyfills return `"84,0,0,..."`                                                             | Porffor bug                                     |       1 (Neon WebSocket; `pg` and `postgres` hit it too in the TCP spike) | yes, patch from the TCP spike |
| 5   | `Error.captureStackTrace` is undefined; `pg`'s promise-returning `query()` calls it in a `.catch` and the resulting `TypeError` hides the database error                                      | Web API gap (V8 API present in workerd)         |                                            1 (Neon WebSocket error cases) | yes, gated                    |
| 6   | The standalone host runs `fetch()` to completion before returning, so concurrent HTTP queries do not overlap: 20 concurrent Neon HTTP queries take 2304 ms against 562 ms in workerd          | Platform limit (performance, not correctness)   |             0 break, all 5 slow down by the latency times the concurrency | no                            |
| 7   | A network failure's message differs from workerd's                                                                                                                                            | Web API gap (message text only)                 |                                                                   0 break | no                            |
| 8   | `new WebSocket()` needs compatibility date 2026-11-01                                                                                                                                         | Existing gate, config                           |                                                        1 (Neon WebSocket) | n/a                           |
| 9   | Loopback is refused by `fetch()` unless `SB_EGRESS_ALLOW` is set                                                                                                                              | Test artifact (working as designed)             |                                              all 5 against a local server | n/a                           |
| 10  | workerd allows 50 subrequests per request locally; the first benchmark asked for 100                                                                                                          | Test artifact                                   |                                                                       n/a | n/a                           |
| 11  | `ps-http-sim` leaks one MySQL connection per request for its idle timeout, so the 151 default connection limit ran out after about 200 requests                                               | Test artifact                                   |                                                                       n/a | n/a                           |
| 12  | SRH ran `set` and `get` of one auto-pipeline in parallel: the first answers were `null` in workerd and in Bun alike                                                                           | Test artifact                                   |                                                                       n/a | n/a                           |
| 13  | `Redis.fromEnv(env)` takes its argument only in the `/cloudflare` entry; the default entry reads `process.env`                                                                                | Test artifact (client API)                      |                                                                       n/a | n/a                           |
| 14  | `@planetscale/database` 2.0.0 refuses a parameters array: `execute(query, options)` only                                                                                                      | Client change                                   |                                                                       n/a | n/a                           |

### Minimal reproductions

Each compiled with the published CLI (0.45.0) at compatibility date 2026-10-22, then with the PR at 2026-11-15. Source: [`db-clients/repro`](db-clients/repro/src/index.js), which runs each probe on request (`/?k=taShadow` and so on). The probes are:

```js
// 2: promise
const p = fetch("http://127.0.0.1:18080/health");
typeof p.then; // published: "undefined", with PR: "function"

// 3: null body status
await fetch("http://127.0.0.1:13000/wd_items?id=lt.0", { method: "DELETE" });
// published: TypeError: Response with null body status cannot have body; with PR: status 204

// 4: typed array subclass (Porffor bug)
class Buf extends Uint8Array {
  toString(enc) {
    return enc === "hex" ? "01ff" : "other";
  }
}
const b = new Buf(2);
b[0] = 1;
b[1] = 255;
b.toString("hex"); // published: "1,255", with PR: "01ff"

// 5
typeof Error.captureStackTrace; // published: "undefined", with PR: "function"
```

Number 4 is not filed upstream; another agent is drafting the Porffor issues.

## Changes in the packages PR

Merged as `baronunread/sproutboat-packages` #224. The CLI needs only a dependency bump to reach it (`sproutboat` 0.48.0).

| Change                                                                                                         | Where                                                                                | Gate                                                                                       |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `fetch()` returns a resolved or rejected promise when the host has no async HTTP                               | `__sbUpstream` in `native-fetch-prelude.js`                                          | compatibility date 2026-10-22, the date already documented as "promises from"              |
| `Response` for 204, 205 and 304 built with a null body                                                         | `__sbRawBodyResponse`                                                                | none: it turns a thrown `TypeError` into a response                                        |
| Node/Bun/Deno global check skips a `typeof`-tested use, a global the bundle declares, and strings and comments | `validateHttpSyncSource` in `source.ts`, with `source.test.ts`                       | proposed 2026-11-15                                                                        |
| `Error.captureStackTrace(target)` sets `stack` to the first line, as `Error.stack` already is                  | `__sbSetCompat`                                                                      | proposed 2026-11-15                                                                        |
| A typed array with an underlying object shadows builtin methods                                                | `patchTypedArrayShadow` in `toolchain/src/patch.ts`, taken from the TCP spike (#214) | none possible: it is a compile-time Porffor patch, and only affects typed array subclasses |

Compatibility date: **2026-11-15** (chosen 2026-10-30) for both gated changes. They share one date because an app that needs one needs the other (Neon and Supabase both need the validator change and Neon needs `captureStackTrace`). Two things to decide:

- The typed array patch cannot be date-gated. It only changes behaviour for a typed array that has its own or subclass methods of a builtin name, where the old result was wrong.
- The TCP spike (#214) also gates `Error.captureStackTrace` and allows `Buffer`/`process` in bundles, at 2026-11-02. If it lands first, drop those two hunks from this PR and the proposed date becomes unnecessary for Neon.

The validator change is a heuristic over the bundled text: a use passes when the same global was tested with `typeof` in the 600 characters before it, when any `typeof x === "..."` comparison is in the 200 before it, or when the bundle declares that name itself. An unguarded `process.env` near an unrelated `typeof` test would pass and fail at run time instead of build time. A real fix would parse the bundle.

## Ranking of remaining gaps

By clients stopped, before the PR:

1. Build check on feature-tested Node globals: 4 of 5 clients (fixed, gated).
2. Everything else costs one client each: `fetch()` promise (libsql), null-body responses (Supabase), typed array dispatch (Neon WebSocket), `Error.captureStackTrace` (Neon WebSocket).
3. Not fixed, affects all five as latency: the standalone host blocks on `fetch()`. A page that makes `n` HTTP queries in parallel pays `n` times the latency. Proposed fix: sproutboat-packages #232, from compatibility date 2026-11-16 (`http:concurrent-20` for Neon: 2.2 s blocking, 0.6 s with it, workerd 0.6 s).
4. Cosmetic: network error text.

After the PR nothing stops a client; what is left is items 3 and 4, and the untested parts (Supabase Realtime and auth).

## Test artifacts

- Loopback and private addresses are refused by `fetch()`. Set `SB_EGRESS_ALLOW=127.0.0.1` to test against a local server. A real deployment points at a public host.
- Before 2026-10-22 `fetch()` answers at once, by design, so every client that chains `.then` needs 2026-10-22 or later. The first runs used 2026-10-01 and hung for that reason, which is how gap 2 was first misread; a probe at 2026-10-22 showed the promise is still missing on the standalone host.

## Reproducing

```sh
cd docs/compat/db-clients
docker compose up -d
# per client: install, build, run the runner against workerd and the binary
bun install --cwd libsql
sproutboat build --standalone --target host libsql
bun run.ts libsql dbc-libsql
```

`run.ts` expects `wrangler` in `/tmp/dbc/wr/node_modules/.bin`, the binary in `<app>/dist/<name>`, and ports 19001 and 19002 free. Create the Supabase tables first: `wd_items` and `sb_items` as `(id serial primary key, name text unique, score float8, meta jsonb)`, plus `create function add_numbers(a int, b int) returns int language sql as 'select a+b'`, then `notify pgrst, 'reload schema'`. Stop with `docker compose down -v`.

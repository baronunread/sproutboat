# 01. TCP sockets (`cloudflare:sockets`) and a Hyperdrive binding

Status: design, not implemented. Paths are relative to the repo named in the prefix (`pkgs` = sproutboat-packages at wt-pkgs-main 9fa3a2d; `cli` = wt-cli-release 6733145; `sd` = sproutd at wt-sproutd-cur b4abbef).

## Summary

- `connect()` does not exist on any transport, and the build rejects it. Bindings (KV, D1, R2, Queues, DO, services) have no Hyperdrive or TCP equivalent.
- Recommendation: build one socket primitive in three transport flavours, using the pattern outbound WebSockets already use, then a Node-compat shim for exactly what `pg`, `postgres` and `mysql2` import, then a Hyperdrive binding backed by a protocol-aware pooler that lives outside the apps (broker on the platform, a sibling unit on sproutd).
- Ship Hyperdrive for Postgres first. Raw `connect()` follows because the pooler needs the same plumbing. MySQL second.

## Current state

| Claim                                                                                                                                                                                                                                         | Evidence                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| No `cloudflare:sockets`, `startTls`, `Hyperdrive` anywhere in runtime, toolchain, wire, config. `rg` finds only unrelated uWebSockets text.                                                                                                   | `pkgs/packages/**`                                                                 |
| Only `cloudflare:workers` survives bundling as an external; any other specifier fails the bundle.                                                                                                                                             | `cli/src/bundle.ts:84`                                                             |
| After bundling, `require(`, `Buffer.`, `process.`, `new Buffer(` and any `"node:` string are build errors.                                                                                                                                    | `pkgs/packages/runtime/src/source.ts:12,23,27`                                     |
| `nodejs_compat` is "refused at build"; target P2.                                                                                                                                                                                             | `sd/PARITY.md:27`                                                                  |
| Bun's browser-target polyfills supply most `node:*`; only `node:path`, `node:querystring`, `node:url` are overridden.                                                                                                                         | `cli/src/bundle.ts:38-41`, `cli/src/node-shims.ts:374-377`                         |
| Web Streams (web-streams-polyfill 4.3.0), `structuredClone`, `crypto.subtle` (SHA-2, HMAC only) are in the prelude. No Buffer global, no MD5, no PBKDF2.                                                                                      | `pkgs/packages/runtime/src/gen-streams.ts:25`, `native-fetch-prelude.js:3911,3977` |
| Binding kinds in config: kv, secrets, d1, r2, queues, AE, DO, services.                                                                                                                                                                       | `pkgs/packages/config/src/config.ts:106-123`                                       |
| Broker op switch (`secret.get`, `fetch`, `service.fetch`, `d1.*`): request/reply frames over one loopback connection, one I/O thread for async.                                                                                               | `pkgs/packages/wire/src/broker.ts:1586-1600`, `transport-broker.js:19,664`         |
| The broker already has a bounded pool pattern (D1 lanes, queue limit, per-owner limit).                                                                                                                                                       | `pkgs/packages/wire/src/d1-pool.ts:12-37`                                          |
| Outbound policy: resolve, vet every address, connect to the vetted IP, `SB_EGRESS_ALLOW`. Egress can run as a separate unit outside the sandbox cgroup.                                                                                       | `pkgs/packages/wire/src/egress.ts:2-16,37-60`                                      |
| sproutd: apps cannot create sockets (seccomp) or connect (Landlock). Frontend resolves, vets, connects and hands the open fd to the app, which does TLS itself. Max 8 threads, 32 MiB per app.                                                | `sd/README.md:63-74`                                                               |
| Precedent for a long-lived outbound stream: outbound WebSocket = a thread per connection through the egress policy (embedded transport) or the frontend's egress socket (sproutd), loop woken by the async pipe. Not on the broker transport. | `sd/docs/websockets.md:142-153`, `native-fetch-prelude.js:4362-4364`               |
| `fetch` is a blocking call made async with up to 8 worker threads; requests per app capped at 8.                                                                                                                                              | `sd/ASYNC-IO.md:15-35`                                                             |
| BearSSL is linked in standalone but not in deployed sprouts.                                                                                                                                                                                  | `native-fetch-prelude.js:4368-4370`                                                |

Per transport today: standalone, broker and sproutd all lack `connect()`. What works as plumbing: egress vetting, fd hand-off (sproutd), async wake pipe, ReadableStream/WritableStream. What is missing: everything socket-shaped (`startTls`, half-close, backpressure are all unimplemented, not partial).

## Design

### 1. Socket primitive

Semantics per Cloudflare docs (fetched today): `connect(addr, {secureTransport: "off"|"on"|"starttls", allowHalfOpen})`; `readable`/`writable` carry `Uint8Array` only; `opened`, `closed`, `close()`; `startTls()` returns a new socket and kills the old one's streams; ports 25 and private/Cloudflare-range targets refused; must be created inside a handler. The docs page does not document `upgraded`; I will not implement it until the user wants it.

Runtime: `cloudflare:sockets` is inlined like `cloudflare:workers` (add to `bundle.ts:84` external list, handle in `wrap.ts` `inlineWorkersImports`). A native hook `sb_tcp_hook(op, id, ...)` modelled on `sb_wsc_hook`: ops open, read, write, shutdown-write, close, starttls.

- Backpressure, write: `WritableStream.write()` resolves only when the native send queue is below a high-water mark (256 KiB); otherwise the promise parks on the wake pipe.
- Backpressure, read: `ReadableStream.pull()` issues one native read of up to 64 KiB. Unpulled data stays in the kernel buffer, so TCP flow control does the work. No unbounded queue.
- Half-close: `writable.close()` does `shutdown(SHUT_WR)`. With `allowHalfOpen:false`, EOF on read closes the writer. `close()` destroys both.
- Limits: 6 sockets per request and 16 per app (Cloudflare gives no number; we choose), within the 8-thread cap, so reads use one poll thread per app, not one per socket.

| Transport  | open/vet                                                                                                                                | TLS (`on`, `startTls`)                                                                              | Notes                                                                                   |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| standalone | in-process thread, same egress table as `fetch`                                                                                         | BearSSL in the binary (already linked)                                                              | Add a BearSSL client-over-fd wrapper; `sb_http_request` has the handshake code to reuse |
| sproutd    | frontend vets and passes the fd (as for `fetch`)                                                                                        | in-app BearSSL, certificates checked in the app (as HTTPS today)                                    | Needs a new frontend request type; sandbox unchanged                                    |
| broker     | broker opens it after the same vet; app opens a second loopback connection with the broker token and speaks raw bytes after a handshake | TLS terminates in the broker (Bun `tls`); the broker sees plaintext, as it already does for `fetch` | Avoids multiplexing frames on the one RPC connection                                    |

Compat gate: a new compatibility date, as outbound WebSockets did (`source.ts:31`).

### 2. Node surface for unmodified drivers

What each driver imports (from memory of their sources, not verified in this checkout; step 1 of the milestone is to bundle each driver and list the actual specifiers): `pg` uses `net`, `tls`, `events`, `stream`, `crypto` (md5, SCRAM needs HMAC, PBKDF2, random), `dns`, `util`, `Buffer`, `process.nextTick`; `postgres` uses `net`, `tls`, `crypto`, `stream`, `os`, `fs` (passfile only), `Buffer`; `mysql2` uses `net`, `tls`, `crypto` (sha1, sha256), `Buffer`, `events`, `stream`, `zlib` (optional) and, in its default code path, `eval`-style generated parsers (Cloudflare needs `disableEval: true`; we need the same since Porffor has no `eval`).

Shims (new `node-shims.ts` entries, bundled into the app only when imported):

- `node:net` Socket/`connect` as a Duplex over `cloudflare:sockets`; `node:tls` `connect({socket})` as `startTls()`. Prefer the drivers' own Workers entry points (`pg-cloudflare`, `postgres/cf`) when present: they already use `cloudflare:sockets` and need no `net` shim. Unverified which versions ship them.
- `Buffer` as a global subclass of `Uint8Array`, replacing the `Buffer.` and `new Buffer(` bans only under the compat flag. `process` stays banned except `process.nextTick` and `process.env` (empty) as a minimal stub.
- `node:crypto`: add MD5, SHA-1, PBKDF2, `randomBytes` to the C SHA-2/HMAC block (`native-fetch-prelude.js:4368+`).
- `events`, `stream`, `util`, `string_decoder`: Bun's polyfills, to be tested under Porffor; Porffor compile failures are the main unknown.
- Cost: every polyfill adds heap to a ~1.5 MiB app. Not measured; budget it per import, not globally.

### 3. Hyperdrive binding

Config: `hyperdrive: [{ binding, id }]` beside `config.ts:108-123`; CLI `sproutboat hyperdrive create --connection-string ... [--max-age --swr --caching-disabled]`. The app sees Cloudflare's shape: `env.HD.connectionString`, `host`, `port`, `user`, `password`, `database`, plus `connect()`-free use with `pg`/`mysql2` unchanged.

What the app is given is a lie by design: `host` is a virtual name (`<id>.hyperdrive.sb`), `user/password` are a per-app scoped credential, `database` is the origin name. `connect()` recognises the virtual host and bypasses egress vetting and TLS: it reaches the pooler directly. Origin credentials never enter app memory; they live in the pooler's config, like `secrets` at `broker.ts:1586-1591`.

Pooler (one Bun module in `pkgs/packages/wire`, next to `d1-pool.ts`):

- Speaks the Postgres wire protocol to the app (answers `SSLRequest` with `N`, authenticates the scoped credential), and a real client to the origin (TLS to origin via Bun, origin verified by default).
- Transaction-mode pooling per config: an origin connection is borrowed at `BEGIN`/first statement and returned at idle-in-transaction end. Cap `max_origin` (default 20, hard 100, matching Cloudflare's Free/Paid ~20/~100). Waiters queue with a 10 s timeout (D1 pool uses 10 s too, `d1-pool.ts:12-37`).
- Session state (`SET`, `LISTEN`, advisory locks, named prepared statements): the pooler tracks named statements per client and re-prepares on the borrowed connection; `LISTEN`/session `SET` are refused with a clear error. Whether Cloudflare's own behaviour matches is unverified.
- Query cache: parse `Query`/`Parse`+`Bind`+`Execute`; classify read-only with a conservative SQL scanner (SELECT/WITH without writes, no `NOW()`, `RANDOM()`, `CURRENT_*`, `nextval`, even inside comments, as Cloudflare). Key = hash(config id, SQL, bound params, format codes). Defaults match Cloudflare: `max_age` 60 s (max 1 h), `swr` 15 s, response cap 50 MB, writes do not invalidate. Stored in memory with an LRU byte budget per config (default 64 MiB), not on disk.
- Limits borrowed from Cloudflare: statement 60 s, connect 15 s, idle origin 10 min, username/database 63 bytes. Per-app: 8 concurrent client connections, 1,000 queries/s soft limit (our choice).

Mapping to transports: standalone has one process, so it connects straight to the origin with `localConnectionString`-style config (no pooler, no cache), which is also `wrangler dev` behaviour. Broker: the pooler runs inside the broker process; the app's loopback socket carries the wire bytes. sproutd: pooler is a separate unit like `egress.ts:12`; the frontend passes an fd to it, naming the app from the private socket (`sd/README.md:71`), so no token is exchanged. The pool is shared across all 1,000 apps of one config; 1,000 idle apps hold zero origin connections.

## Candidate engine: PGX / pgrust as per-app Postgres

Facts below come from the READMEs only (fetched 2026-10-28); no code was cloned or run. PGX: https://github.com/pgrundev/pgx. pgrust: https://github.com/malisper/pgrust.

- What it is: PGX is a Postgres-wire server on pgrust that mints databases on connect from sealed templates, with CoW branches (ZFS block cloning; full copy elsewhere), TTL expiry, a janitor and per-database memory and connection limits. That is the same shape as sproutd: many tenants in one process, forked from a sealed base.
- Licence (not legal advice; flag for counsel): both repos are AGPL-3.0, with PostgreSQL-derived parts under the PostgreSQL License (see each `NOTICE`). The AGPL network clause (section 13) obliges whoever runs a modified version to offer corresponding source to users who interact with it over a network. Unmodified use as a separate process shields our own code from copyleft in the usual reading, but linking or embedding it into the broker or sproutd would not. Counsel must decide whether Postgres-wire access by customer apps counts as user interaction, and whether any patch of ours triggers the offer. Customers' apps are not derivative works, but that is also a legal call.
- Crash safety: README says "Not crash-safe", `fsync = off`, one process is one crash domain, "for disposable databases", "not a system of record". This rules out production data.
- Maturity: PGX v0.1.2, 260 commits; pgrust v0.4-beta, "we don't recommend running pgrust in production (yet)". PGX reports 219 of 231 Postgres regression files byte-exact (the other 12 differ in EXPLAIN text only, one suite, one platform) and 36/36 framework runs (Rails, Django, Prisma 6, SQLAlchemy 2, node-postgres). Not stated: auth methods (md5, SCRAM, trust), `postgres` (porsager) support. Not verified: commit recency, the pgrust "3 commits" count (probably squashed history), any driver run by us. No C extensions, only built-ins and pgvector.
- Memory (README, unverified by us): about 70 KB per untouched database, 128 KB once queried; 128-155 MB for 1,000 untouched, about 213 MB after all are used; one idle PG 18 is 16.6 MB.
- Fit with this doc: the pooler already speaks plain Postgres wire, so PGX is just another origin (`<id>.hyperdrive.sb` mapping to a PGX database), needing no new binding. Preview per deploy: a sealed template holds the schema and seed data; each deploy branches it (sub-second on ZFS; copy on other filesystems, so the host needs ZFS for the claim), with a TTL tied to the preview lifetime. Production binds to real Postgres.

Recommendation: do not adopt for production or as a platform dependency now. Treat it as an optional, off-by-default preview/dev origin, revisit at a stable release, after counsel signs off on AGPL, and after a spike confirming `pg` and `postgres` connect and authenticate. No code in this milestone depends on it.

## Alternatives considered

- Pool inside each app: ruled out. 1,000 apps times a pg client exceeds any origin `max_connections` and breaks the 32 MiB cap.
- Run PgBouncer/Odyssey as the pooler: less code, but no query cache, no per-app credential mapping, and an extra process per host. Reasonable fallback for M3 if the pooler's protocol surface grows beyond one engineer-month.
- HTTP-only database drivers (Neon serverless, PlanetScale fetch): works today, but it is not "unmodified drivers" and fails the user's goal.
- Full `node:net` before `cloudflare:sockets`: larger surface for no extra Workers compatibility.
- Terminate TLS in the sproutd frontend for `startTls`: rejected; the frontend serves every tenant, the same reason `ASYNC-IO.md` keeps HTTP in the worker.

## Risks

- Porffor may fail to compile `pg`/`mysql2` or the stream and Buffer polyfills (largest unknown; no code run here).
- Memory per app grows with the shims, against a density promise (`sd/PARITY.md:12`).
- Pooler correctness: transaction pooling with prepared statements is where every pooler has had bugs; wrong cache classification serves stale or wrong data.
- Broker TLS termination means the broker sees DB plaintext; sproutd does not. Different trust story per transport.
- A reachable pooler with scoped credentials is a new cross-tenant surface (red-team scope).

## Effort

Rough: 10 to 14 engineer-weeks.

- M1 (2-3 wk): bundle each driver, list real imports; `cloudflare:sockets` plaintext on standalone; echo test.
- M2 (3-4 wk): TLS and `startTls`, sproutd fd path, broker second connection, Buffer/crypto/net shims; `pg`, `postgres`, `mysql2` pass a smoke suite against a real origin.
- M3 (3-4 wk): Postgres pooler, scoped credentials, config and CLI, limits.
- M4 (2-3 wk): query cache, then MySQL pooling.

## How to measure success

- Conformance: each driver runs its own query test subset (types, prepared statements, transactions, `COPY` excluded) against Postgres 16 and MySQL 8 on all three transports; byte-identical results to workerd with the same Hyperdrive config.
- Density: RSS per idle app with and without the shims; target under +0.5 MiB per app that does not import them, zero.
- Pool: 1,000 apps issuing queries through one config keep origin connections at or below `max_origin`; p50 added latency under 1 ms against a local origin.
- Cache: repeated `SELECT` hit ratio, no hit on `NOW()`, write then read returns stale only within `max_age`.
- Security: scoped credential of app A cannot reach config B; private-IP origin refused unless allow-listed.

## Open questions for the user

1. Scope: Hyperdrive-for-Postgres only first (my recommendation), or raw `connect()` for arbitrary protocols (Redis, SMTP-less) at the same time? This decides whether TLS in the app is needed in M2.
2. Trust: accept the broker seeing DB plaintext on the platform transport, or require end-to-end TLS to the origin (adds BearSSL to deployed sprouts and costs binary size)?
3. Query cache: on by default as on Cloudflare (stale reads surprise people), or opt-in per binding?
4. MySQL in v1, or after Postgres ships?
5. Is `nodejs_compat` allowed to grow past this driver subset (Buffer global opens the door to more Node libraries), or do we gate Buffer to apps that import these drivers?
6. Preview databases: is an AGPL, non-crash-safe engine (PGX/pgrust) acceptable as an opt-in preview/dev origin on the hosted platform, pending counsel review, or do previews use only ordinary Postgres?

# TCP sockets: `connect()` from `cloudflare:sockets`

Compatibility date **2026-11-17** (the previous date in use is 2026-11-16, concurrent standalone `fetch()`). Before it, importing `cloudflare:sockets` fails the build with `cloudflare:sockets needs compatibility_date 2026-11-17 or later`.

Run 2026-11-02 on a Mac (arm64), servers in Docker: Postgres 16 (scram-sha-256, md5 and TLS, one container each) and Redis 7. Reference: workerd 1.20261101.1 (`wrangler` 4.155.0 for the plaintext runs, the `workerd` binary with `tlsOptions.trustedCertificates` for TLS). Sources: `docs/sockets` in sproutboat-packages.

## What milestone 1 covers

- `connect(address | { hostname, port }, { secureTransport: "off" | "on" | "starttls", allowHalfOpen })` returning `readable`, `writable` (byte streams, with write backpressure), `opened`, `closed`, `close()`, `startTls({ expectedServerHostname })`.
- workerd's error shapes: argument errors (`TypeError`/`RangeError` texts), a failed connect rejects `opened` with `proxy request failed, cannot connect to the specified address`, port 25 refused, a closed socket's stream errors.
- Both transports: the embedded one (standalone binaries) and the broker one (platform deploys, `sproutboat dev`).
- Outbound policy is the `fetch()` policy: resolve, vet every address, connect to the vetted IP, private ranges refused unless in `SB_EGRESS_ALLOW`. On the broker transport the broker does the vetting and the TLS, and the egress service takes the tunnel where the broker has no network.
- TLS verifies against the built-in roots; `SB_CA_BUNDLE` adds roots (both transports).
- Limits: 16 open sockets per app, 15 s connect timeout on the broker path.
- For unmodified drivers, from the same date: `navigator.userAgent` is `Cloudflare-Workers`; the CLI bundles with the `workerd` export condition (`pg-cloudflare`, `postgres/cf`), accepts a bundled `Buffer`/`process`, and shims `net`/`tls`/`dns`/`fs`/`crypto` so the Node branch of a driver names `cloudflare:sockets` instead of failing.

## What it leaves out

- `node:net` / `node:tls` as working modules: drivers that have no Workers entry point (`ioredis`, `node-redis`, `mysql2`) do not run. The Redis check below uses a small RESP client written against `connect()`.
- `mysql2`: its generated parsers produce a 1.37 M-line C unit and the compile did not finish in 35 minutes.
- Hyperdrive and pooling; `upgraded`; per-request cleanup of sockets a handler leaves open (they live until closed or the app is reaped, within the 16-socket cap).

## Results against workerd

Same app, same servers, JSON answers compared key by key.

| Check                                                                                                                                                                                                                                 | Observations |                                               Differ |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -----------: | ---------------------------------------------------: |
| `connect()` conformance suite (16 tests), embedded transport                                                                                                                                                                          |           99 | 3 (backpressure window sizes, `desiredSize`: 0 vs 1) |
| `pg` 8.23.1: connect, simple, parameters, types (jsonb, timestamptz, bytea, array, bigint, numeric), DDL, transactions, named prepared statement, errors (SQLSTATE, constraint), pool of 3 with 6 concurrent queries; scram, md5, TLS |       3 x 17 |                                                    0 |
| `postgres` 3.4.9: same set                                                                                                                                                                                                            |       3 x 14 |                                                    0 |
| Redis RESP client: ping, binary values, hashes and lists, MULTI/EXEC, 1,000-command pipeline, 1 MiB value, error replies, quit and `closed`                                                                                           |           17 |                                                    0 |

The 102 driver observations are identical on the embedded transport and on the broker transport (`sproutboat dev`).

## Numbers

Mac arm64, loopback to Docker, median of five runs of 2,000 queries (5,000 for Redis) on an otherwise idle machine; the broker column is from single runs. Standalone is the embedded transport.

|                                              | standalone |           broker (`dev`) |                                  workerd |
| -------------------------------------------- | ---------: | -----------------------: | ---------------------------------------: |
| connect to `opened` (plain, local echo), p50 |     114 us | 200-230 us (`-O0` build) | about 100 us (clock has 1 ms resolution) |
| 16-byte echo round trip                      |      40 us |                   109 us |                                    42 us |
| `pg` `select $1::int`, one connection        |     147 us |               485-516 us |                                   173 us |
| `postgres` same query                        |     147 us |              623-1347 us |                                   126 us |
| Redis `GET`                                  |      92 us |                  1005 us |                                    95 us |
| RSS per open socket                          |     32 KiB |       25-32 KiB (sprout) |                             not measured |

Standalone binaries (idle RSS): the Postgres drivers add about 3 MiB at module init (`pg` 6.6 MiB, `postgres` 6.4 MiB against 3.6 MiB for hello). A handler that does not import them pays nothing.

## Known differences

- Backpressure: the write queue holds more than workerd's about 0.8 MiB before a write stalls (1.2-2.7 MiB on loopback, depending on kernel buffers).
- `localAddress` is `null`.
- The broker transport costs two hops per frame; its per-query latency is 3 to 6 times the standalone one.
- Three Porffor fixes ship in the toolchain patcher (bindings named like libc macros, call argument order, writable `navigator`); none are filed upstream.

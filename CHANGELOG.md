# Changelog

Changes to the self-hosted Sproutboat platform are recorded here. Read the
**Breaking and operator actions** section before upgrading.

## [Unreleased]

## [0.12.1] - 2026-10-29

Adopts `@sproutboat/runtime` 0.35.0 and `@sproutboat/toolchain` 0.20.1 (from 0.34.2 and 0.19.2), the versions CLI 0.43.0 builds with.

### Breaking and operator actions

- Update with `sbctl update`. There are no new units, env files, secrets or
  migrations. Take a backup first (`sudo systemctl start sproutboat-backup`)
  and copy it off the box.
- **Rebuild your apps with CLI 0.43.0** to get the fixes and the speed-ups
  below. They are in the compiled app, so deployed apps keep running as built.
  The garbage-collection fix matters most: an app built before it can, rarely
  and silently, read back a changed string or array after an `await`.
- **A standalone binary opens its SQLite databases in EXCLUSIVE locking mode by
  default** (CLI 0.42.0). While the binary runs, no other process can open its
  databases, so the `sqlite3` shell and `sproutboat kv|d1 --local --data-dir`
  are locked out. Set `SB_SQLITE_EXCLUSIVE=0` to keep shared locking. The
  platform's broker and sproutd are unchanged.
- **Platform rollback.** `SB_REF=v0.12.0 sbctl update` is safe: nothing here
  changes stored data or a frozen contract.
- `MIN_CLI_VERSION` stays `0.0.0`: the control API is unchanged. CLI 0.43.0 is
  the release tested with this platform version.

### Fixed

- **A collection no longer frees Promise's pending-rejections array (CLI
  0.43.0, toolchain 0.20.1).** Once enough rejections had grown that array
  past its static capacity, the collector skipped it as malformed and freed its
  entries at every collection. The next rejection then wrote into memory that
  belonged to another object, so a string or array of a request suspended at an
  `await` could change silently. A standalone binary showed it in about 1
  fresh process in 5 under interleaved requests; sproutd's concurrent smoke
  failed 4 runs in 16. The regression test failed 60 of 60 runs before the fix
  and passes 60 of 60.
- **A chunked upload's end reaches the worker** when sproutd's window was full
  as the last chunk arrived, so a large `ws` or HTTP upload no longer loses its
  connection at the end.

### Performance

- **JWT verification in C (CLI 0.40.0).** `atob`, `TextEncoder.encode`, the
  `ArrayBuffer` copy of `crypto.subtle.sign` and `digest`, and the
  constant-time compare behind `verify` no longer run as JavaScript loops: a
  typical `authenticate()` goes from 21.5 to 7 µs.
- **`JSON.stringify` and `atob` read characters directly** and return an
  8-bit string when they can (CLI 0.39.0 and 0.41.0).
- **D1 is cheaper in standalone builds.** Calls skip the JSON text hop around
  the in-process dispatch, strict rows are built as JS arrays in C with their
  text in one arena, and a strict query takes a direct lane with no statement
  closures. No 88 KiB `mmap` per statement that builds a temporary table
  (`INSERT ... RETURNING`, sorts).
- **The client address is folded once per distinct address**, not on every
  request.
- **A standalone binary collects every 8 requests** and after about 50 ms of
  quiet, instead of after every response (`SB_GC_EVERY=<n>`; `1` restores the
  old behaviour). It costs about 2 MiB more resident memory. sproutd's collector
  and density are untouched.
- **A request's fixed cost drops its text round trips**, regular expressions and
  repeated lookups, and a response's ASCII headers and body are written straight
  from the heap (CLI 0.42.0).
- Together, on the API-challenge mix on one pinned x86 core, CLI 0.41.0 held
  3,200 req/s or more at the bar (p95 under 500 ms, p99 under 1 s, errors under
  1%) where the release before it held 2,800. sproutd still keeps 1,000 apps in
  1,536 MiB.

### Changed

- Adopt `@sproutboat/runtime` ^0.35.0 and `@sproutboat/toolchain` ^0.20.1
  (`@sproutboat/wire` ^0.20.2). `COMPAT.md` and `report.json` are regenerated: 32/32 compile, 3/32 match as
  before (the 29 differ only in `Content-Type`). The median binary is 3.68 MB → 3.70 MB.

## [0.12.0] - 2026-10-27

Adopts `@sproutboat/runtime` 0.34.2 and `@sproutboat/toolchain` 0.19.2, the versions CLI 0.38.0 builds with.

### Breaking and operator actions

- Update with `sbctl update`. There are no new units, env files, secrets or
  migrations. Take a backup first (`sudo systemctl start sproutboat-backup`)
  and copy it off the box.
- Everything except the edge's WebSocket proxy reaches an app only when it is
  rebuilt with CLI 0.32.0 or later, and most of it only at a later
  compatibility date (see Added and Changed). Deployed apps keep running as
  built.
- **Platform rollback.** `SB_REF=v0.11.0 sbctl update` stays safe for apps built
  before `2026-10-28`. The 0.11.0 limits for apps built at `2026-10-28` or
  later still apply (see 0.11.0). An app built at `2026-11-01` that accepts a
  WebSocket loses it on v0.11.0, whose edge does not proxy upgrades.
- `MIN_CLI_VERSION` stays `0.0.0`: the control API is unchanged. CLI 0.38.0 is
  the release tested with this platform version.

### Added

- **WebSockets through the edge (#306).** The edge proxies a client's upgrade
  request to the sprout: it opens the sprout's socket first, so a refusal is a
  plain HTTP error, then upgrades the client and relays text and binary
  messages and closes both ways, with the subprotocol the sprout chose. It
  keeps the sprout warm while a socket is open. Messages up to 32 MiB. Apps
  need CLI 0.36.0 or later at compatibility date `2026-11-01`; before that
  date a 101 answers 501. From `2026-10-30` (CLI 0.34.0) a socket pair whose
  two ends both stay in the app, such as a Worker and its Durable Object,
  works on the platform. Outbound sockets and hibernation (`2026-11-01`) run
  on standalone executables and sproutd; the platform's broker transport
  rejects `fetch` upgrades for now.
- Streamed request uploads from compatibility date `2026-10-27` (sproutd).
- Background work: cron, queue and Durable Object alarm triggers, including
  Workers that export only `scheduled()` or `queue()` (CLI 0.32.0).
- Versions and rollback: deployments keep their versions and
  `sproutboat rollback` returns to an earlier one.

### Changed

- **Queues like Cloudflare's from compatibility date `2026-10-31`**: queue
  conformance goes from 17/46 to 41/46 (CLI 0.33.0). `send()`, `sendBatch()` and
  `metrics()` return Promises, bodies keep their content type, messages carry
  `timestamp` and `retry({ delaySeconds })`, the first of `ack()` and `retry()`
  wins, and a message is retried at most 3 times by default.
- **Faster string building** in compiled apps (toolchain 0.18.0): about 43% more
  heavy-workload throughput on sproutd. Apps rebuild once.
- **A request costs about a quarter of the CPU** (toolchain 0.19.2, CLI 0.38.0).
  Porffor's `globalThis` no longer rebuilds the whole global object on every
  read: a 404 from a standalone binary costs about 89 µs of CPU instead of 319.
- **Memory:** 1,000 apps fit in 1,536 MiB (runtime 0.34.x).
- Adopt `@sproutboat/runtime` ^0.34.2 and `@sproutboat/toolchain` ^0.19.2
  (`@sproutboat/wire` ^0.20.2, `@sproutboat/config` ^0.6.0). `COMPAT.md` and
  `report.json` are regenerated: 32/32 compile, 3/32 match as before (the 29 differ
  only in `Content-Type`). The median binary is 3.23 MB → 3.68 MB.

### Fixed

- **A failed binding call you do not await no longer ends the process.** An
  unhandled rejection (D1, KV, R2 and the other bindings) is logged as
  `Uncaught (in promise) ...`, fires `unhandledrejection` when the app listens
  for it, and the process and other requests keep going, as on Workers (CLI
  0.37.0).

## [0.11.0] - 2026-10-24

### Breaking and operator actions

- Update with `sbctl update`. There are no new units, env files, secrets or
  migrations. Take a backup first (`sudo systemctl start sproutboat-backup`)
  and copy it off the box.
- Deployed apps get two broker changes without a rebuild, at every
  compatibility date:
  - A Durable Object `storage.list({ prefix })` matches the prefix exactly, as
    in Workers. It used SQL `LIKE`, which ignored case and read `_` and `%` as
    wildcards: the prefix `item:a_` also listed `item:ab`. An app that relied
    on that can list fewer keys than before.
  - The broker accepts the `do.sql` op. Only apps built with CLI 0.31.0 at
    `2026-10-29` or later send it.
- Everything else reaches an app only when it is rebuilt with CLI 0.30.0 or
  later, and most of it only at a later compatibility date (see Changed).
- **Platform rollback limit.** `SB_REF=v0.10.0 sbctl update` is safe only while
  no app has been rebuilt at compatibility date `2026-10-28` or later. No data
  is lost, but on v0.10.0 (wire 0.17) such an app loses features. An app
  built at `2026-10-29` or later loses:
  - `ctx.storage.sql`: every `exec()`, `databaseSize` and `transactionSync()`
    throws `sproutboat do.sql: unknown op: do.sql`, and the request fails
    unless the app catches it. The databases stay on disk under
    `resources/<store>.do-sql/` and are reachable again after updating back to
    0.11.0 (checked in a VM);
  - `storage.list({ reverse: true })`: keys come back in ascending order, and
    with `limit` they are the wrong keys.

  Measured in a VM, do.js at `2026-10-29` goes from 93/105 on 0.11.0 to 81/105
  on v0.10.0: those 12 cases, nothing else. An app built at `2026-10-28` loses
  only `reverse`. Durable Object key-value data, alarms, the 64-hex ids, RPC
  and the input gate run in the app's own build, so they keep working, as do
  the `start`, `startAfter` and `end` ranges and exact prefixes, which that
  build filters itself. Apps built before `2026-10-28` go back to `LIKE`
  prefix matching. The command also pins the install to v0.10.0: remove
  `SPROUTBOAT_UPDATE_REF` from `/etc/sproutboat/update.env` to follow
  releases again.

- **App rollback limit (any platform version).** The first time an app built at
  `2026-10-29` creates an object named with `idFromName`, it moves that
  object's keys and alarm from the old `name:NAME` id to the new 64-hex id.
  After that, `sproutboat rollback` to a deployment built at an earlier date
  finds the object empty, because its data is under the new id. Nothing is
  lost: rolling forward again shows the data. But keys the older build writes
  while it is active replace the same keys when the newer build comes back
  (checked in a VM). Roll forward instead of back, or restore a backup taken
  before the move.
- `MIN_CLI_VERSION` stays `0.0.0`: the control API is unchanged. CLI 0.31.0 is
  the release tested with this platform version.

### Added

- Durable Objects `ctx.storage.sql` for apps built with CLI 0.31.0 at
  compatibility date `2026-10-29` (`@sproutboat/wire` 0.19.0, `do.sql`). Each
  object has its own SQLite database in
  `resources/<store>.do-sql/CLASS/<id>.sqlite`, beside the project's Durable
  Object store, so it survives redeploys. Backups already archive these files
  and `sbctl restore` brings them back writable by the edge; tests now cover
  both. One broker keeps at most 64 of these databases open and closes the
  least recently used. That bounds its file descriptors at about 200. It
  also bounds memory, but not tightly: in a Linux VM, 64 open databases
  added about 40 MB to the broker when small and about 175 MB when each held
  4 MB and was read in full (SQLite's page cache per connection). That memory
  counts against the edge unit's `MemoryMax`. The platform runs one broker
  per deployment and no shared SQL pool, so the uncapped pool path in wire
  0.19 is not used.

### Changed

- Adopt `@sproutboat/runtime` 0.30.0, `@sproutboat/wire` 0.19.0 and
  `@sproutboat/toolchain` 0.15.0, the versions CLI 0.31.0 builds with.
- New behaviour, gated by each app's compiled `compatibility_date` as before:

  | From date    | Behaviour                                                                                                                                                                                                         |
  | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `2026-10-28` | Durable Objects: an input gate (concurrent read-then-write updates are no longer lost), Promise storage, `transaction()`, `sync()`, typed values, `list()` ranges; `sendBatch({ delaySeconds })` delays the batch |
  | `2026-10-29` | Durable Objects: RPC on stubs, 64-hex ids with `equals()`, `getByName`, `ctx.storage.sql`; an exception in the object rejects `stub.fetch()` instead of returning a 500                                           |

- Durable Object data written at an earlier date survives the move to
  `2026-10-29`: objects named with `idFromName` move to their new id on first
  use, and `idFromString` still accepts the old `name:` and `uid:` ids.
- The compatibility suite still reads 32/32 compile, 3/32 match. The median
  sprout binary grows from 2.90 MB to 3.23 MB with the new prelude.

### Fixed

- Queues: a consumer whose `queue()` handler throws gets every message it did
  not ack or retry redelivered, as on Workers. Before, the broker transport
  delivered such a batch once and dropped it. This applies at every
  compatibility date, once the app is rebuilt with CLI 0.30.0 or later.
  (`sendBatch()` bodies arriving as `"[object Object]"` affected only
  standalone executables and sproutd, not the platform.)
- The control version in `x-sproutboat-control` reads `0.11.0`.

## [0.10.0] - 2026-10-23

### Breaking and operator actions

- Update with `sbctl update`. It reinstalls the edge unit with the new
  response limit and restarts the services. No new units, env files or
  secrets. If you set `SPROUTBOAT_RESPONSE_MAX_BYTES` yourself, your value
  still applies.
- Deployed apps get the KV and R2 `list()` prefix fix (see Fixed) without a
  rebuild, at every compatibility date. An app that passes a prefix containing
  uppercase letters, `_` or `%` can list fewer keys than before.
- When a broker first opens a KV or R2 store after the update, it adds a
  `metadata` column to KV and an `md5` column to R2. Existing values, objects,
  etags and D1 rows are unchanged, and v0.9.2 reads the migrated stores as
  before, so rolling back keeps the data.
- A D1 statement that only reads now reports `meta.changes` as 0, at every
  date. It repeated the previous write's count.
- A client that disconnects now stops the sprout's request. The edge logs it as
  499 with `errorKind: "client-closed"`. Before, the request ran to the end.
- The edge removes `x-sb-edge-secret`, `x-sb-edge-token`, `x-sb-binding-call`
  and `x-sb-url` from every incoming request, and `x-sb-uncaught` from every
  response a client receives.
- Roll back with `SB_REF=v0.9.2 sbctl update` only before apps are rebuilt at
  compatibility date `2026-10-25` or later. On v0.9.2 such an app's KV `list()`
  returns no keys and its metadata reads `null`, without an error. The command
  also pins the install to v0.9.2: remove `SPROUTBOAT_UPDATE_REF` from
  `/etc/sproutboat/update.env` to follow releases again.
- Restore a backup with `sudo sbctl restore <archive> --force` (see Fixed). The
  restore runbook in `infra/README.md` used before this release can lose control
  data.
- `MIN_CLI_VERSION` stays `0.0.0`: the control API is unchanged, and older CLIs
  keep working. CLI 0.28.0 is the release tested with this platform version.

### Added

- Service-binding calls are vouched for by the edge (#295). With a sprout built
  by CLI 0.20.0 or later, the callee sees the caller's URL as `request.url`, and
  a callee that throws makes the caller's `fetch()` reject with its error, as in
  workerd. Brokers get a per-boot edge secret and each sprout its own token.
  Clients can forge neither.
- `tests/service-bindings`: a service-binding conformance and reliability suite
  compared against workerd, including streaming, Workers RPC and Request
  fidelity cases (#293, #298, #301).
- `tools/with-local-packages.ts` runs one command against a local
  `sproutboat-packages` checkout (#300).
- `sbctl restore <archive> [--force]` stops control, the edge and the backup
  timer, then restores a backup. It gives each service its files back with the
  owners and modes `install.sh` sets, then starts the services again.

### Changed

- Adopt `@sproutboat/runtime` 0.28.0, `@sproutboat/toolchain` 0.14.0 (Porffor
  Alpha 19) and `@sproutboat/wire` 0.17.0 (#288 to #303). The broker can stream
  `fetch()` and service-binding responses and request bodies, honours aborts,
  and no longer resends a call it may already have run. It falls back to whole
  bodies for sprouts that don't ask for streaming.
- New behaviour is gated by each app's compiled `compatibility_date`. A deployed
  sprout carries the runtime it was built with, so existing deployments keep
  their behaviour until they are rebuilt with a newer CLI at a later date:

  | From date    | Behaviour                                                                                                                              |
  | ------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
  | `2026-10-21` | `Request.body` and `Response.body` are `ReadableStream`s; `fetch()` and service-binding responses stream                               |
  | `2026-10-22` | `fetch()` and binding calls return Promises and run off the event loop; redirects follow Fetch; opt-in LTX capture (`SB_LTX_ENABLE=1`) |
  | `2026-10-23` | `fetch(Request)` and `new Request(request, init)` follow workerd (GET and HEAD refuse a body, immutable headers)                       |
  | `2026-10-24` | D1 returns Promises and follows workerd's rules (types, parameter counts, foreign keys, errors)                                        |
  | `2026-10-25` | KV follows the Workers API (Promises, types, metadata, expirations, errors)                                                            |
  | `2026-10-26` | R2 follows the Workers API (Promises, MD5 etags, ranges, conditionals, `uploadPart()` bodies)                                          |
  | `2026-10-27` | Request bodies stream; `SB_REQUEST_BODY_MAX` defaults to 100 MiB (1 MiB before)                                                        |

- The compatibility suite reads 32/32 compile, 3/32 match. Every handler's
  status and body match Bun, including the two date-parsing cases that failed
  in 0.9.2. The 29 mismatches are `Content-Type` alone: since runtime 0.17.0,
  string bodies default to `text/plain;charset=UTF-8` and `Response.json` sets
  `application/json`, as in the Fetch spec and workerd, where Bun differs. This
  reaches an app only when it is rebuilt with CLI 0.18.0 or later, at any
  compatibility date.
- The edge's per-response safety limit is 512 MiB instead of 10 MiB. Responses
  stream through the edge, and the limit applies to service-binding calls too
  (#296).
- Edge connections stay open 5 seconds past the request deadline, up to Bun's
  maximum of 255 seconds, so a slow sprout gets the edge's 504 instead of a
  dropped connection after 10 seconds (#294).

### Fixed

- KV and R2 `list()` prefixes match exactly, as in Workers (`@sproutboat/wire`
  0.15.0 and 0.16.0). They used SQL `LIKE`, which ignored case and read `_` and
  `%` as wildcards: the prefix `a` also listed `AB`, and `a_` also listed `ab`.
  The dashboard and the KV export already matched exactly.
- Restoring a backup brings back the backed-up control data. The restore left
  the target install's `sproutboat.sqlite-wal` beside the restored database,
  and SQLite replayed it over the restored file. Control came back with the new
  install's users and no projects. The restore now deletes each restored
  database's `-wal`, `-shm` and `-journal` files first. It refuses archive
  members outside the state dir, keeps the install's directories, and leaves
  binding data writable by the edge, which had failed with `EACCES` (#139).
- At narrow widths, a long dashboard breadcrumb is cut off with an ellipsis
  instead of pushing the account menu off-screen.
- The Admin › Backups page names everything a backup holds, including binding
  data, and gives the `sbctl restore` command.
- A sprout no longer fails to start with "Is port N in use?" when another local
  address holds the port. The supervisor checks the wildcard address too, and
  tries each port in the range at most once (#300).
- The control version in `x-sproutboat-control` reads `0.10.0`. It had read
  `0.5.3` since v0.5.3.

## [0.9.2] - 2026-10-11

### Changed

- Adopt toolchain 0.7.0, runtime 0.16.0 and wire 0.12.2 with Porffor Alpha 17.
  Native handlers gain in-memory Web Streams and global timers, with compiler
  fixes for Better Auth's model resolver and base64 signatures. HTTP remains
  buffered; AES/JWE stateless sessions remain unsupported.

## [0.9.1] - 2026-10-10

### Changed

- Shared runtime and compiler dependencies move to runtime 0.15.0, toolchain
  0.6.0 and wire 0.12.1. Porffor alpha-16 implements Proxy and collection
  iterators; the runtime adds live URLSearchParams and FormData iterators.
  All 32 compatibility handlers compile and 30 match Bun. The two existing
  non-ISO date parsing mismatches remain.

## [0.9.0] - 2026-10-05

### Added

- Backups now include binding data: every KV, D1, R2, queue and Durable
  Object store under `resources/` and `brokers/`, each snapshotted with
  `VACUUM INTO` so writes in flight are captured. Before this, a restore
  brought projects back with empty storage (#139).
- `bun apps/control/src/backups.ts restore <archive>` restores a backup onto
  an empty install. It checks the whole archive first, refuses a state dir
  that already has a control database unless `--force`, and warns when the
  secrets key is missing. `infra/README.md` has the runbook.

### Changed

- A new version only goes live once it starts. Control asks the edge to start
  each deploy or rollback target first; if it exits or doesn't listen within
  10 s, the deploy fails with 409 and the current version keeps serving. Its
  cron, queue and alarm timers stay off until its route is active (#141).

### Fixed

- Per-deployment broker state (`/var/lib/sproutboat/brokers/<digest>/`) is
  removed when its version is pruned or its project deleted. It used to stay
  forever, one copy per deploy, and ride along in every backup. Control clears
  the existing leftovers when it starts.

### Breaking and operator actions

- Update with `sbctl update`: it creates `/var/lib/sproutboat/activation` and
  installs the units that point control and the edge at it.

## [0.8.1] - 2026-10-05

### Fixed

- The deployment page's "Compare against" picker shows "Choose a version…"
  instead of an empty box (#255).

### Changed

- The compatibility suite and tools build with `@sproutboat/toolchain` 0.5.0
  (Porffor alpha-15): 32/32 compile, 30/32 match, unchanged. Sprouts are built
  by the CLI, so the class-expression (#256) and date-offset fixes reach them
  through CLI 0.15.0.

### Breaking and operator actions

- None. `sbctl update` is sufficient.

## [0.8.0] - 2026-10-05

### Added

- `sproutboat-egress.service`: deployed `fetch()` reaches the internet on the
  systemd install. Brokers hand each request to this token-gated loopback
  service, which runs outside the edge's network deny and refuses private and
  reserved addresses itself (`@sproutboat/wire` 0.12.0, #252).

### Breaking and operator actions

- `sbctl update` installs and starts the new unit and generates
  `/etc/sproutboat/egress.env`. `SB_EGRESS_ALLOW` now goes in that file.

## [0.7.0] - 2026-10-04

### Changed

- Brokers refuse private and reserved addresses for `fetch()`, checking the
  resolved address at connect; the `outbound` allowlist is gone
  (`@sproutboat/wire` 0.11.0, #174).
- The dashboard no longer lists outbound hosts.

### Fixed

- The deployment page's version compare loads on selection, and rollback always
  clears its busy state.

### Breaking and operator actions

- To let sprouts reach a private address, such as a database on the same host,
  set `SB_EGRESS_ALLOW` (`*` or exact addresses) in the supervisor's
  environment; brokers inherit it.
- The edge unit's `IPAddressDeny=any` still blocks all off-box egress on the
  systemd install, so `fetch()` reaches nothing outside the host there.
  `sbctl update` is sufficient.

## [0.6.0] - 2026-10-04

### Added

- The edge applies an asset directory's `_redirects` and `_headers`
  (Cloudflare Pages format), read from `assets.json`. Redirects answer before
  any file lookup; header rules apply to edge-served files and can override
  `Cache-Control` or unset a header. Needs sprouts built with CLI 0.13.0 (#61).

### Fixed

- Durable Object storage and alarms survive redeploys. They now live in one
  database per owner and project instead of the per-deployment state (#207).

### Changed

- `@sproutboat/wire` 0.10.0.

### Breaking and operator actions

- Durable Object data written before this release is not carried over: the
  first deploy after upgrading starts from empty storage, as every redeploy
  did before. `sbctl update` is sufficient.

## [0.5.9] - 2026-10-04

### Fixed

- Typed-array writes past the end are ignored instead of overwriting
  neighbouring memory (#241).
- Typed-array `join()` and `toString()` work; `Uint8Array.join` returned
  garbage and `Uint16Array.join` could kill the sprout (#242).
- KV stores binary values. The broker's KV tables gain a `binary` column on
  first use, and `get(key, type)` supports `"text"`, `"json"` and
  `"arrayBuffer"` (#233).
- Binary `fetch()` and service-binding request bodies reach the upstream as
  their exact bytes (#232).

### Changed

- Sprouts build with `@sproutboat/toolchain` 0.4.24, `@sproutboat/runtime`
  0.13.5 and `@sproutboat/wire` 0.9.3. Sprouts built before this release keep
  their previous KV and fetch behaviour.

## [0.5.8] - 2026-10-03

### Fixed

- `String.prototype.replaceAll` is linear instead of quadratic: a 2.1 MB
  replacement went from about 42 s to 71 ms (#237).
- uuid and @noble/hashes work in sprouts. Integer typed-array stores now wrap
  instead of clamping; `typedArray.set(source)` with no offset copies to the
  start instead of the wrong memory; `~x` wraps for large values; out-of-range
  typed-array reads return `undefined`; and a handler's own top-level `URL` no
  longer replaces the runtime's `URL` class at startup (#238).

### Changed

- Sprouts build with `@sproutboat/toolchain` 0.4.22 and `@sproutboat/runtime`
  0.13.4. The median compatibility-suite binary is 1.02 MB, up from 0.98 MB.

## [0.5.7] - 2026-10-02

### Fixed

- Floating-point results on arm64 now match JavaScript: builds use
  `-ffp-contract=off`, so `a * b + c` rounds twice as JavaScript requires
  instead of once in a fused instruction (#235).
- Standalone binaries accept HTTP/1.0 requests instead of answering 505, so
  they work behind nginx's default `proxy_http_version 1.0` (#236).
- Binary responses from outbound `fetch()` and service bindings arrive intact.
  The broker (`@sproutboat/wire` 0.9.2) now sends them as raw bytes to sprouts
  built with runtime 0.13.3 or later; older sprouts are served exactly as before
  (#232).

## [0.5.6] - 2026-10-02

### Fixed

- Async handlers no longer start failing on every request after a few
  requests. An async function returning `null` was rejected with
  `TypeError: Cannot get property of null` once a `toISOString()` call had
  run, and the deployment never recovered. Sprouts now build with
  `@sproutboat/toolchain` 0.4.17, which patches the Porffor bug behind it
  (#168).
- Non-ASCII text read back from bindings is no longer garbled: D1 rows, KV
  values, cached bodies and error messages returned "café" as "cafÃ©"
  (`@sproutboat/runtime` 0.13.2, #189).
- Uncaught handler exceptions are logged to the sprout log instead of being
  swallowed behind a bare 500.

## [0.5.5] - 2026-10-01

### Changed

- Sprouts build with Porffor alpha-13 (`@sproutboat/toolchain` 0.4.16, up
  from 0.4.13 on alpha-9) and `@sproutboat/runtime` 0.13, matching CLI
  v0.12.3. This includes the coroutine-stack fix for #178, which stopped
  large async handlers from crashing with SIGBUS. Compatibility is unchanged
  at 32/32 compile, 30/32 match.

## [0.5.4] - 2026-09-30

### Fixed

- The installer's closing instructions told you to run
  `bunx @sproutboat/cli login`, an old 0.1.0 package. They now print
  `npx sproutboat login --api-url https://control.<domain> --token <token>`.

## [0.5.3] - 2026-09-26

### Added

- Deployment history now shows compile time and binary size, with a binary-size
  trend across retained versions. Existing sizes are recovered from available
  artifact manifests.
- A dedicated CLI authorization page for device login.

### Changed

- The edge serves static asset bodies through `Bun.file()` rather than reading
  the complete file into memory per request.
- Updated the Porffor alpha 9 toolchain to `@sproutboat/toolchain@^0.4.13`
  and the artifact manifest contract to `@sproutboat/artifact@^0.3.0`.
- The control API now reports the platform tag version in its version header.
  CLI v0.11.13 is the release tested with this platform version.

### Fixed

- Updated the native runtime for repeated HMAC signing with raw digest bytes.

### Breaking and operator actions

- None. Existing artifacts remain valid, and `sbctl update` is sufficient.

## [0.5.2] - 2026-09-18

### Fixed

- `@sproutboat/toolchain` bumped to `^0.4.10`, pinning Porffor to the
  `alpha-7` tag. All local patches (render.js, uwebsockets.js) verified
  against the real alpha-7 source — no anchor drift, and the full test
  suite (153 tests) passes.

## [0.5.1] - 2026-09-17

### Fixed

- `@sproutboat/toolchain` bumped to `^0.4.9` and `@sproutboat/runtime` to
  `^0.9.6`. `0.4.6`/`0.4.7` shipped a native R2 size-gating feature
  (baronunread/sproutboat#202) with a misplaced `#endif` in the generated
  C++ guard, breaking every R2-free native build with a compiler error.
  The fix landed as `0.4.8`, but that version got stuck permanently
  conflicted on npm after an interrupted trusted-publish attempt — so
  `0.4.9`/`0.9.6` instead revert #202 outright: R2 transfer support is
  native code again, always compiled in with 404 stubs where unused, the
  pre-#202 shape. The size gate saved ~11KB of `__text` (~1.3% of a typical
  binary) and didn't even change the shipped file size on macOS, since
  `__TEXT` is page-aligned there — not worth the guard-placement bug class
  it introduced.

### Breaking and operator actions

- None. `sbctl update` is sufficient.

## [0.5.0] - 2026-09-15

### Added

- R2 object browser in the dashboard (`/r2/:id`): read-only list, prefix
  filter, download — same authenticated/resource-ownership/audit-logged
  posture as the existing KV explorer (baronunread/sproutboat#183).

### Fixed

- The 100% CPU livelock on a `fetch` handler that resolves a promise with a
  plain object (baronunread/sproutboat#168), and `new Response(r2Object.body)`
  corrupting binary R2 content (baronunread/sproutboat#177) — both picked up
  via `@sproutboat/toolchain` `^0.3.2` → `^0.4.1` and `@sproutboat/runtime`
  `^0.6.5` → `^0.7.1`. The runtime bump also carries R2's file-backed blob
  storage rework (baronunread/sproutboat#56) and a raw-bytes `put()` fix
  (baronunread/sproutboat#184).

### Breaking and operator actions

- None. `sbctl update` is sufficient.

## [0.4.3] - 2026-09-14

### Fixed

- `@sproutboat/runtime` bumped to `^0.6.6`. `__sbEntry` called
  `handlers.fetch()` (and the `scheduled`/`queue`/`alarm` trigger paths)
  with no try/catch at all: any synchronous throw, or a rejected async
  handler promise, propagated all the way up and crashed the whole process,
  taking down every other in-flight and future request on that sprout until
  whatever supervised it restarted the binary (baronunread/sproutboat#179).
  A throwing/rejecting `fetch()` now returns a 500 instead. `scheduled()`/
  `alarm()` still reply 204 either way (no
  failure signal existed before this either); a throwing `queue()` falls
  through to the existing default-ack pass, same as a handler that never
  calls `ack()`/`retry()` on every message.

### Breaking and operator actions

- None. `sbctl update` is sufficient.

## [0.4.2] - 2026-09-14

### Fixed

- `@sproutboat/runtime` bumped to `^0.6.5`, which windows the byte encoder
  behind `crypto.subtle`. `0.6.4` fixed that encoder for large inputs and
  regressed it badly for small ones: an app hashing ~150-byte values on every
  request lost 64% of its throughput, tripled its p50 and grew 41% in RSS
  (baronunread/sproutboat#181). `0.6.5` keeps the large-input fix from #180
  without that cost, by only reaching for an array once 512 bytes have
  accumulated. This platform never ran `0.6.4`; the pin moves straight from
  `^0.6.3` to `^0.6.5`.

### Breaking and operator actions

- None. `sbctl update` is sufficient.

## [0.4.1] - 2026-09-14

### Fixed

- Static assets no longer force a network round trip on every request.
  Fingerprinted build output (Vite, Astro, webpack/CRA, Next.js, Nuxt,
  SvelteKit -- detected by filename shape, not a hardcoded framework
  directory) is now cached for a year as immutable; everything else with a
  stable name (fonts, favicon, OG images) gets a bounded day-long cache.
  Previously every asset was sent `max-age=0, must-revalidate`, so nothing
  was ever actually cached -- visible as content popping in a beat late
  once page response times got fast enough to expose the round trip.
- `@sproutboat/runtime` bumped to `^0.6.3`: a handler calling `.text()`/
  `.json()` on a `Response` built from raw wire bytes (the assets binding,
  outbound `fetch()`, service bindings) got the bytes back undecoded
  instead of as real UTF-8 text (mojibake on any non-ASCII content), and
  that same decode built its result with `O(n^2)` string concatenation,
  making a ~43KB page take 2.6s+ of real CPU time per request.

## [0.4.0] - 2026-09-11

### Added

- Deploys compile against the `@sproutboat/{runtime,wire}` 0.5.0 surface:
  `env.<NAME>.limit({ key })` now returns `{ success, resetAt }`. `resetAt` is
  epoch milliseconds for when the fixed window rolls, so a throttled request
  can be answered with an accurate `Retry-After`
  (`Math.ceil((resetAt - Date.now()) / 1000)`). Handlers reading only
  `success` are unaffected.

### Changed

- `@sproutboat/runtime` and `@sproutboat/wire` pinned to `^0.5.0`.
- `docs/capability-http-sync-v0.md` documents async handlers: `fetch` may
  return a promise the handler itself creates (a `.then()`-chained one hangs),
  such a response omits `x-sb-cpu-ms`, and `crypto.subtle` digest/sign/verify
  are async in signature only over synchronous inline C.

### Breaking and operator actions

- None. `sudo sbctl update` picks up the new runtime; existing deployments keep
  working and gain the field on their next deploy.

## [0.3.1] - 2026-09-11

### Fixed

- `sbctl update` no longer installs `node_modules` and the built dashboard
  root-only. The bootstrapper kept a restrictive umask while running the
  release installer, so a dependency change left the service users unable to
  read `@sproutboat/*` and both control and edge crash-looped
  (`Cannot find module`). The installer now normalises those trees to
  world-readable, and the bootstrapper resets its umask before the handoff.

### Breaking and operator actions

- None. If a `sudo sbctl update` to 0.3.0 left control or edge failing, this
  release fixes it; re-run `sudo sbctl update` (or
  `chmod -R a+rX /opt/sproutboat/node_modules && sudo sbctl restart`).

## [0.3.0] - 2026-09-11

### Added

- Deploys now compile against the `@sproutboat/{runtime,wire}` 0.4.0 surface, so
  a handler gains:
  - **Rate limiting**: `ratelimiters` in `sproutboat.jsonc` gives
    `env.<NAME>.limit({ key }) -> { success }`, a fixed-window counter served by
    the deployment's broker.
  - A **`crypto.subtle`** subset: `digest` (SHA-256/384/512) and HMAC
    `sign` / `verify`; plus `crypto.scryptVerify` for migrating password hashes.
  - **`env.<D1>.backup()`**: an online, integrity-checked D1 snapshot via
    `VACUUM INTO`.
  - **`request.cf.clientIp`**: the connection's remote address.

### Changed

- Config parsing, the artifact manifest, the binding broker and the native-fetch
  runtime now come from published `@sproutboat/*` packages instead of a
  `github:` dependency on the CLI. The Porffor pin and its source patches moved
  to `@sproutboat/toolchain`. No wire change beyond the two new broker ops
  above.
- Porffor pinned alpha-4 -> alpha-5 (`1f4ae4ae`) for the compile path. Deployed
  artifacts are immutable and unaffected; new deploys pick it up. The Porffor
  compatibility suite holds at 32/32 compile, 29/32 match.

### Fixed

- A completed `sbctl update` restarts the active control and edge processes
  after replacing their source, so the new runtime actually activates.
- The edge retains still-active timed dispatchers across a candidate handoff
  instead of dropping them.
- The shared edge response cache is tightened to anonymous `GET` requests whose
  response is `Cache-Control: public` with a finite lifetime. Anything carrying
  `Authorization`, `Cookie`, `Set-Cookie`, `Vary` or a revalidation directive
  bypasses it, so one deployment's dynamic response can never be served for
  another's request.

### Breaking and operator actions

- None. Upgrade once with `sudo sbctl update`.

## [0.2.1] - 2026-09-08

### Fixed

- Updates now restart active control and edge processes after replacing their
  source, so a completed upgrade actually activates its new runtime.

## [0.2.2] - 2026-09-08

### Fixed

- Dynamic responses now return the measured Sprout CPU header, while cached
  entries continue to omit the per-request value.

## [0.2.1] - 2026-09-08

### Breaking and operator actions

- No known breaking API or runtime changes. Upgrade once with `sudo sbctl update`.
  Later updates stage a fresh release before running its installer.

### Fixed

- Upgrades now create and normalize both `brokers` and `resources` state
  directories before restarting the edge, so binding-backed Sprouts can start.
- Existing admin tokens are no longer printed during an upgrade.
- Staged updates normalize destination modes before synchronizing code, so the
  edge can traverse the application tree and execute Bun.

### Added

- A root-owned update bootstrapper stages a fresh source tree outside the
  active installation, serializes concurrent updates, and records the target
  commit and update pin in `/etc/sproutboat/update.env`.

## [0.2.0] - 2026-09-07

### Breaking and operator actions

- No known breaking API or runtime changes.
- Run the installer or `sbctl update` when upgrading. The KV administration API
  requires updated systemd units and shared group permissions for
  `/var/lib/sproutboat/resources`.
- Publish and pin the matching CLI release before tagging the platform. The new
  control endpoints are consumed by `sproutboat kv key`, `kv bulk`, and
  `kv export`.

### Added

- Authenticated, owner-scoped KV key listing, individual key operations,
  bounded bulk transfer, and paginated export support.
- Safe KV audit events containing actor, resource ID, operation, status, and
  counts without keys or values.
- Service bindings between active deployments owned by the same account.
- Refined dashboard navigation, resource forms, and account fixtures.

### Fixed

- Shared binding data now lives outside the log directory and remains writable
  by the edge and control services during KV administration.
- Deployed static assets preserve binary bytes when fetched through an assets
  binding.
- Failed KV exports remove their temporary file and never leave an apparently
  complete destination.

## [0.1.0] - 2026-09-01

First tagged self-hosted platform checkpoint.

[Unreleased]: https://github.com/baronunread/sproutboat/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/baronunread/sproutboat/compare/v0.8.1...v0.9.0
[0.5.9]: https://github.com/baronunread/sproutboat/compare/v0.5.8...v0.5.9
[0.5.8]: https://github.com/baronunread/sproutboat/compare/v0.5.7...v0.5.8
[0.5.7]: https://github.com/baronunread/sproutboat/compare/v0.5.6...v0.5.7
[0.5.6]: https://github.com/baronunread/sproutboat/compare/v0.5.5...v0.5.6
[0.5.5]: https://github.com/baronunread/sproutboat/compare/v0.5.4...v0.5.5
[0.5.4]: https://github.com/baronunread/sproutboat/compare/v0.5.3...v0.5.4
[0.5.3]: https://github.com/baronunread/sproutboat/compare/v0.5.2...v0.5.3
[0.4.3]: https://github.com/baronunread/sproutboat/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/baronunread/sproutboat/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/baronunread/sproutboat/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/baronunread/sproutboat/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/baronunread/sproutboat/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/baronunread/sproutboat/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/baronunread/sproutboat/compare/v0.2.0...v0.2.1
[0.2.2]: https://github.com/baronunread/sproutboat/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/baronunread/sproutboat/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/baronunread/sproutboat/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/baronunread/sproutboat/releases/tag/v0.1.0

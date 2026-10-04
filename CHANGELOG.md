# Changelog

Changes to the self-hosted Sproutboat platform are recorded here. Read the
**Breaking and operator actions** section before upgrading.

## [Unreleased]

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

[Unreleased]: https://github.com/baronunread/sproutboat/compare/v0.5.9...HEAD
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

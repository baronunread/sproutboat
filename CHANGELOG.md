# Changelog

Changes to the self-hosted Sproutboat platform are recorded here. Read the
**Breaking and operator actions** section before upgrading.

## [Unreleased]

### Fixed

- `sbctl update` no longer installs `node_modules` and the built dashboard
  root-only. The bootstrapper kept a restrictive umask while running the
  release installer, so a dependency change left the service users unable to
  read `@sproutboat/*` and both control and edge crash-looped
  (`Cannot find module`). The installer now normalises those trees to
  world-readable, and the bootstrapper resets its umask before the handoff.

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

[Unreleased]: https://github.com/baronunread/sproutboat/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/baronunread/sproutboat/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/baronunread/sproutboat/compare/v0.2.0...v0.2.1
[0.2.2]: https://github.com/baronunread/sproutboat/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/baronunread/sproutboat/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/baronunread/sproutboat/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/baronunread/sproutboat/releases/tag/v0.1.0

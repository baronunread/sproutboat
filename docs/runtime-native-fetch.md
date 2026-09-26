# Native-fetch runtime

Each deployment is a long-lived HTTP server: Porffor (`alpha-9`) compiles
`export default { fetch(request) { … } }` into a native binary that embeds a
[uWebSockets](https://github.com/uNetworking/uWebSockets) server. Porffor's C
runtime parses the request and calls `fetch`; the handler returns a `Response`.

## Lifecycle

- The supervisor (`services/supervisor/src/run.ts`, `WorkerPool`) assigns each
  deployment a loopback port, starts the sprout with `PORT` in its environment
  (honoured by the render.js patch in `@sproutboat/toolchain`), waits for it to
  accept a TCP connection, and restarts it if it exits.
- One process serves the deployment for its whole life. The supervisor restarts
  it if it exits; there is no per-request recycle.
- Idle deployments are evicted after `idleMs` (default 10 min).
- The edge (`services/edge/src/main.ts`) reverse-proxies each request to
  `workerEndpoint(workerPath)`.

## Handler contract

The runtime supplies `Request`, `Response`, `Headers`, `URL`,
`URLSearchParams`, `JSON`, `TextEncoder`/`TextDecoder`, and `console` (logs go
to the sprout's stderr). The CLI bundles imports with Bun before Porffor and
validates the bundled output with `validateHttpSyncSource`
(`@sproutboat/runtime`): no Node/Bun/Deno globals, unsupported `node:` APIs,
or `WebSocket`. Outbound `fetch` requires an allowlist binding.

## Sandbox

On Linux the sprout runs inside `infra/sandbox/sprout-sandbox.sh` (bubblewrap):
private user/pid/mount/ipc/uts namespaces, unprivileged uid, read-only rootfs
exposing only the runtime libraries and the artifact directory, `--die-with-parent`,
optional seccomp. It keeps the caller's network namespace so the edge can reach
its loopback port; egress is denied by the edge unit's
`IPAddressDeny=any` / `IPAddressAllow=localhost`.

## Known Porffor gaps (alpha-9)

- `Date` string parsing is wrong for some non-ISO inputs (capabilities
  `15-date-iso` and `16-date-parts`). The toolchain patch fixes ISO timezone
  offsets in `32-date-offset`.
- `Porffor.dlopen` is unavailable in the native backend (not needed here).

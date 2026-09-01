# Native-fetch runtime

Each deployment is a long-lived HTTP server: Porffor (`alpha-3`) compiles
`export default { fetch(request) { … } }` into a native binary that embeds a
[uWebSockets](https://github.com/uNetworking/uWebSockets) server. Porffor's C
runtime parses the request and calls `fetch`; the handler returns a `Response`.

## Lifecycle

- The supervisor (`services/supervisor/src/run.ts`, `WorkerPool`) assigns each
  deployment a loopback port, starts the sprout with `PORT` in its environment
  (honoured by `patches/porffor-render.patch`), waits for it to accept a TCP
  connection, and restarts it if it exits.
- One process serves the deployment for its whole life. alpha-3 has working
  memory management — RSS stays flat over hundreds of thousands of requests — so
  there is no per-request recycle.
- Idle deployments are evicted after `idleMs` (default 10 min).
- The edge (`services/edge/src/main.ts`) reverse-proxies each request to
  `workerEndpoint(workerPath)`.

## Handler contract

alpha-3 provides real `Request`, `Response`, `Headers`, `URL`,
`URLSearchParams` (added by `patches/porffor-fetch-globals.patch`), `JSON`,
`TextEncoder`/`TextDecoder`, and `console` (logs go to the sprout's stderr).
Handlers are import-free and validated by `validateHttpSyncSource`
(`sproutboat/runtime/source`): no `import`/`require`, no Node/Bun/Deno
globals, no outbound `fetch`/`WebSocket` (a deliberate capability boundary — see
issue #19, and the sandbox blocks egress regardless).

## Sandbox

On Linux the sprout runs inside `infra/sandbox/sprout-sandbox.sh` (bubblewrap):
private user/pid/mount/ipc/uts namespaces, unprivileged uid, read-only rootfs
exposing only the runtime libraries and the artifact directory, `--die-with-parent`,
optional seccomp. It keeps the caller's network namespace so the edge can reach
its loopback port; egress is denied by the edge unit's
`IPAddressDeny=any` / `IPAddressAllow=localhost`.

## Known Porffor gaps (alpha-3)

- `Date` string parsing is wrong for some inputs (capability `15-date-iso`).
- `Porffor.dlopen` is unavailable in the native backend (not needed here).

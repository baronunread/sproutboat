# Tasks — snippet-sized, in order

> Phase 0 below records the completed compatibility-harness work. The old
> Phase 1 task sketches predate the multi-region infrastructure evaluation and
> are superseded by the implementation sequence and exit criteria in
> [PLAN.md](PLAN.md). Rewrite them as executable tasks when Phase 1 begins.

Rules for the agent: smallest thing that passes the check, stdlib first, no
frameworks, no speculative abstractions. Each task ends with its acceptance
check passing. Bun for host-side scripts unless stated.

## Phase 0 — compat harness

### T1. Capability suite
Create `tests/porffor/capabilities/` with 30 single-file handlers using the frozen contract
(`export default { fetch(request) {...} }`). Cover: static response, JSON
parse/stringify, URL/query parsing, string manipulation, regex, dates, math,
headers echo, status codes, small state machines (e.g. Slack slash-command
parser, Stripe-style signature *shape* check without crypto, GitHub webhook
payload routing). Each file ≤40 lines, zero imports.
**Check:** every file runs under `bun run tools/refserve.ts tests/porffor/capabilities/<f>.js` and
answers an HTTP request.

### T2. Reference server
`tools/refserve.ts`: takes a handler file, serves it with `Bun.serve` on a
port, maps Bun's request to the contract's `fetch(request)`. ~30 lines.
**Check:** `curl localhost:PORT/?q=1` returns the handler's output for 3
capability handlers.

### T3. Porffor compile wrapper
`tools/compile.ts`: shells out to `porf native <in> <out>` (Porffor from npm,
pinned version in package.json), captures exit code + stderr, returns
`{ok, binaryPath, sizeBytes, error}`. No retries, no queue.
**Check:** compiles a hello-world handler to a runnable binary; prints size.

### T4. Harness shim
Porffor won't have an HTTP server; the harness invokes handlers as CLI:
`tools/shim.js` is prepended/wrapped around each capability handler so the compiled
binary reads a JSON request `{method,url,headers,body}` from argv/stdin, calls
`fetch()`, prints JSON response `{status,headers,body}` to stdout. Keep the
shim to plain JS Porffor is likely to support (no async needed if handler is
sync; support returned Promise with a `.then` print).
**Check:** hello-world compiled binary echoes a JSON response for a JSON
request.

### T5. Differential runner
`tools/diff.ts`: for each capability handler — run via refserve/Bun AND via compiled
binary with the same 3 canned requests; deep-compare
`{status, body, content-type}`. Emit `report.json`:
per-file `{compiles, matches, sizeBytes, compileMs, runMs, error}`.
**Check:** `bun tools/diff.ts` produces report.json covering all capability handlers
without crashing on failures.

### T6. Compat report
`tools/report.ts`: reads report.json, prints a markdown table + summary line
("18/30 compile, 15/30 match, median binary 2.4 MB"). Write result to
`COMPAT.md`.
**Check:** COMPAT.md exists with the summary line. **This is the go/no-go
artifact (kill criterion: <40% matching).**

## Phase 1 — thinnest product (only after Phase 0 passes)

### T7. Binary runner contract
Reuse the T4 shim as the production ABI v0: router talks to compiled binaries
over stdin/stdout JSON, one process per request initially.
`ponytail:` per-request spawn is fine at 1 MB binaries; move to a warm pool
socket protocol when p50 latency matters.
**Check:** a script sends 100 sequential requests through a spawned binary,
all correct.

### T8. Router
`router/main.ts` (Bun): HTTP server; maps `<app>.localhost` subdomain → app
dir under `apps/<name>/{bin | fallback.js}`; compiled path spawns binary with
JSON request; fallback path dynamically imports the JS and calls its fetch.
No config file — the filesystem is the registry.
**Check:** two apps (one compiled, one fallback) both answer via
`curl -H 'Host: a.localhost' localhost:8080`.

### T9. Deploy endpoint
`POST /deploy` on a separate admin port: multipart {name, file} → save to
`apps/<name>/src.js` → T3 compile → on success emit binary, on failure copy
to `fallback.js` → run T5-style diff probes → write `apps/<name>/meta.json`
`{path: "compiled"|"fallback", deployedAt, sizeBytes}`. Auth: single bearer
token from env.
**Check:** deploying a good handler lands on compiled path; deploying one
using an unsupported API lands on fallback; both immediately serve.

### T10. CLI
`cli/platform` (single Bun file, `bun build --compile` later): commands
`deploy <file>` and `logs <app>` (tail server-side log file over HTTP
streaming). Config: `~/.platformrc` with url+token.
**Check:** `platform deploy tests/porffor/capabilities/01-hello.js` → prints live URL; curl works.

### T11. Sandbox wrapper
Run compiled binaries via `bwrap`/unprivileged container: no network, RO
filesystem, 64 MB memory rlimit, 5 s CPU limit, own uid. One wrapper script
`runtime/jail.sh`; router uses it for every spawn. Do NOT skip.
**Check:** a capability handler still works jailed; a handler attempting to read
`/etc/passwd` or open a socket fails.

### T12. Probe-gated promotion
Fold T5 diff probes into deploy (T9): a handler is only marked `compiled` if
all probes match the fallback's output; otherwise serve fallback and store the
mismatch in meta.json (this becomes the shim backlog data).
**Check:** a handler that compiles but behaves differently ends up on
fallback with the mismatch recorded.

## Phase 2 seeds (write only when Phase 1 milestone hit)

- T13. Telemetry: append per-deploy `{compiled, error-category}` to an ndjson
  file; `tools/moat.ts` aggregates into the public compat number.
- T14. Shims: pick top failure category from T13 data; write smallest shim in
  `runtime/shims/`; re-run the capability suite.
- T15. Branch previews: deploy name = `<app>-<branch>`; nothing else changes.

Skipped everywhere: dashboard/UI, database (filesystem + ndjson), queues,
Docker orchestration, multi-tenancy beyond the jail, custom domains — add each
only when a real user asks.

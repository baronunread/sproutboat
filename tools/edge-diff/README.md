# edge-diff

Black-box differential test of the Bun edge (`services/edge`) against the Rust edge
(`services/edge-rs`, binary `sproutboat-edge`).

For every case the harness starts a fresh edge with identical env, an identical temp
`routes.json` and a fresh set of identical fake sprouts, sends the same request script, and
compares status, normalised response headers (`date` ignored, names case-folded and sorted;
the tool reports missing, extra and different headers separately), body bytes, and the NDJSON
request log (field set, field order, types and values; the tool only checks that `at` is a plausible
ISO time, `durationMs` / `ttfbMs` / `startupMs` / `bootMs` only for null-ness and a sane range).
The tool scrubs ports out of bodies, headers and logs.

```sh
bun tools/edge-diff/run.ts                      # Bun vs Rust, all cases
bun tools/edge-diff/run.ts --only cache-miss-then-hit,assets-*   # ids, or a prefix ending in *
bun tools/edge-diff/run.ts --bun-only           # baseline: prints what the Bun edge does
bun tools/edge-diff/run.ts --bun-vs-bun         # self-check of the comparison and normalisation
bun tools/edge-diff/run.ts --jobs 4 --out report.md --json summary.json
bun tools/edge-diff/run.ts --list
```

The Rust binary is `$SB_EDGE_RS_BIN` or `services/edge-rs/target/release/sproutboat-edge`
(`--rust-bin` overrides both). The report is markdown on stdout (and `--out`), followed by a JSON
summary (also `--json`). Exit code is 1 when a case is DIFFERENT or ERROR and not allowlisted in
`known-differences.json` (`{ "<case id>": "<reason>" }`); allowlisted cases print as
`KNOWN DIFFERENCE` with their reason.

## Service-binding calls

The real credentials are random per process, so a case that sets `credentials` (credential -> hostnames it may call) starts both edges through a wrapper (`bun-edge-main.ts`, and `sidecar-main.ts` as the Rust edge's `SPROUTBOAT_SIDECAR_SCRIPT`) that registers them in the supervisor's registry (`registerBindingCredential` in `services/supervisor/src/run.ts`) from a file; `ctx.setCredentials()` rewrites the file mid-case and waits for the acknowledgement, which is how a broker's exit is simulated. The `binding-*` cases call the edge directly the way a broker would, or run a chain client -> app A -> edge -> app B where the fake app's `/call` endpoint is A's broker. The callee's random edge token is compared by presence only.

## Layout

- `run.ts` CLI and report; `runner.ts` one case on one edge; `compare.ts` normalisation and diffs.
- `lib.ts` process tracking, fixtures (fake apps, stand-in sprouts, asset manifests), a raw HTTP/1.1
  client (keeps duplicate headers, reports truncated bodies) and a WebSocket client.
- `fake-app.ts` the fake sprout (node:http, because Bun adds a content-type to every response and the
  runtime's bare 500 has none). It doubles as the supervisor's stand-in sprout through a tiny
  `#!/bin/sh` wrapper that honours `$PORT`, like `tests/tail.e2e.test.ts`. No bubblewrap needed
  (`SPROUTBOAT_SPROUT_SANDBOX=none`).
- `cases-*.ts` the cases: core (routing, caps, timeouts, uncaught, cold start, routes.json
  validation), cache, assets, websocket, reload and activation.

## Safety

The tool tracks and kills every child (SIGTERM, then SIGKILL); sprouts the edge leaves behind register a
pid file and are swept after each case. Nothing uses `pkill` or `pgrep`. Temp dirs live under the OS
tmpdir and the tool removes them after each case and on exit. Each case has a timeout (`--timeout`, default
30 s, or `timeoutMs` on the case).

## Not covered

Idle eviction of sprouts, and a mid-body upstream failure behind a binding call (the Rust edge logs it, the Bun edge does not; see `intentional-more-events-logged`).

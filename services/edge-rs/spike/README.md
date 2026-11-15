# SPIKE: rustls in edge-rs (do not merge)

Plan 022 decision 8. Findings, benchmark and verdict: `architecture-review-20261112/022-spike-edge-rustls.md` in the platform notes.

- `../src/tls.rs`, `../src/acme.rs`: the prototype. Off unless `SPROUTBOAT_TLS_LISTEN` is set. Settings are the `SPROUTBOAT_TLS_*` variables read in `Settings::from_env`.
- `src/`: certificate generator (lego's layout plus Caddy drop-ins), 28-byte backend, load client (`lat`, `thr`, `hs`).
- `bench/`: `build.sh`, `driver.ts` (`mem`, `perf`, `gethttp`), `summarize.ts`, `certserver.ts` (Caddy `get_certificate http` stand-in).
- `e2e.sh`: 12 end-to-end checks (SNI, hot reload, h1, h2, forwarded headers, redirect, on-demand ACME against pebble).

Throwaway names and pebble only: no real key, certificate, domain or Let's Encrypt order was used.

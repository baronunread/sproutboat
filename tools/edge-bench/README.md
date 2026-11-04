# edge-bench

Compares the Bun edge (`bun services/edge/src/main.ts`) with the Rust edge (`sproutboat-edge`) in
front of the same trivial upstream, and measures Caddy's own cost with TLS.

- `loadgen/` standalone crate (not part of `services/edge-rs`): `loadgen` (closed-loop HTTP/1.1 load generator)
  and `fake-upstream` (keep-alive server, `GET /` returns a ~120 byte JSON body, no logging; `--any` accepts any host/path/method).
- `run.ts` orchestrates one scenario and prints a markdown table, and appends JSON lines to `results/` (gitignored).

## Run

```sh
cargo build --release --manifest-path tools/edge-bench/loadgen/Cargo.toml
# Rust edge is built separately: (cd services/edge-rs && cargo build --release)

bun tools/edge-bench/run.ts --edge bun            # also: rust | direct
bun tools/edge-bench/run.ts --edge caddy-bun --caddy "$(which caddy)"   # also: caddy-rust | caddy-direct
bun tools/edge-bench/run.ts --edge rust --conns 1,8 --duration 3 --warmup 1
bun tools/edge-bench/run.ts --edge caddy-rust --dry-run                 # print commands only
```

Scenarios (`--scenario`, default `hello`): `hello` proxies `GET /` to the trivial upstream, run as the route's sprout (`direct` runs it standalone); `asset` serves a 4 KiB file from the route's asset manifest (no sprout runs); `cached` serves a public, cacheable answer from the edge cache (the sprout, a copy of `fake-upstream --cache-control`, runs once to fill it). `hello`, `asset` and `cached` on an edge run the sprout unsandboxed (`SPROUTBOAT_SPROUT_SANDBOX=none`).

Flags: `--conns 1,8,32,128`, `--bun-main PATH` (a bundled Bun edge, `bun build services/edge/src/main.ts --target bun`), `--duration 15`, `--warmup 3`, `--rust-bin PATH`, `--caddy PATH`,
`--no-newconn`, `--out FILE.jsonl`, `--dry-run`. One scenario per invocation; run `bun`, `rust`, `direct` in sequence, never in parallel.

`direct` points the loadgen straight at the upstream (baseline). `caddy-*` puts Caddy (`tls internal`,
local CA, bound to 127.0.0.1, trust-store install skipped, storage under a temp dir) in front of the edge (or the upstream for
`caddy-direct`); the loadgen then uses `--tls-insecure` with SNI `bench.sproutboat.local`. Caddy modes add a row
`<edge>-newconn` at C=32 with a new TCP+TLS connection per request (`--no-keepalive`; latency includes the handshake).

On exit `run.ts` signals only the PIDs it started (SIGTERM, then SIGKILL after 3 s); no pkill/pgrep.

## Columns

- `req/s`, `p50`, `p99`: measured window only (warmup excluded), per request, closed loop with C connections issuing back to back.
  The loadgen JSON also has p90, p99.9, max, mean.
- `edge / caddy / upstream / loadgen CPU us/req`: utime+stime of that process divided by completed requests in the window.
  On Linux it is read from `/proc/<pid>/stat` right at the window start and end (assumes CLK_TCK=100) and includes the loadgen itself.
  On macOS only the coarse `ps -o time=` (10 ms resolution) over the whole run including warmup is available, with requests estimated
  as rps * (duration + warmup); treat as indicative. Loadgen CPU is `n/a` on macOS.
- `edge RSS MiB` / `caddy RSS MiB`: `VmRSS` of the process right after the window (Linux; the JSON also has the `VmHWM` peak).
- `errors`: connect/request failures; `non-2xx`: responses with a non-2xx status. Both should be 0.

Memory caps on Linux: every process runs under `systemd-run --user --scope -p MemoryMax=N -- cmd`
(fallback `sudo -n systemd-run --scope`, which makes the recorded PID sudo's, so CPU is unreliable there). Caps: edge 512M,
upstream 256M, loadgen 512M, caddy 512M. macOS has no cgroups: keep C modest.

## Linux bench box (instabox-romeo, 4 vCPU)

Never run this on othello and never create/delete/stop/snapshot boxes. Hold the lock for the whole run:

```sh
ssh user@instabox-romeo
flock /data/home/sb-bench/romeo.lock bash -c '
  cd <checkout> &&
  cargo build --release --manifest-path tools/edge-bench/loadgen/Cargo.toml &&
  (cd services/edge-rs && cargo build --release) &&
  for e in direct bun rust caddy-direct caddy-bun caddy-rust; do
    bun tools/edge-bench/run.ts --edge $e --caddy "$HOME/bin/caddy" || exit 1
  done'
```

With 4 vCPU the loadgen (2 threads), upstream (2 threads) and edge compete; compare edges relative to `direct`,
and use the CPU us/req columns as the less noisy metric.

## Getting caddy

Check `which caddy` first.

- macOS: `brew install caddy`.
- Linux (no root): download the official release tarball from https://github.com/caddyserver/caddy/releases
  (`caddy_<version>_linux_amd64.tar.gz` or `..._linux_arm64.tar.gz`) into a new empty directory, extract, and pass
  `--caddy /path/to/caddy`:
  `mkdir -p ~/bin/caddy-dl && curl -fsSL -o ~/bin/caddy-dl/c.tgz <tarball-url> && tar -xzf ~/bin/caddy-dl/c.tgz -C ~/bin/caddy-dl caddy && mv ~/bin/caddy-dl/caddy ~/bin/caddy`

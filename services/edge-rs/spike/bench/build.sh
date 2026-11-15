#!/bin/bash
# Build the edge and the tools on the bench box, fetch Caddy 2.11.9 (the version othello pins).
# Run from the spike scratch dir with the sources rsynced to ./src (services/edge-rs, spike inside it).
# Never pkill; the cargo run is capped so it cannot starve the box.
set -euo pipefail
D=$(pwd)
mkdir -p bin
# rsync keeps the sources' old mtimes; make cargo see them as changed
find src -name "*.rs" -exec touch {} +
export CARGO_TARGET_DIR=$D/target
systemd-run --user --scope --quiet -p MemoryMax=3G nice -n 10 bash -c "cd $D/src && cargo build --release -j2 --locked" 2>&1 | tail -3
cp target/release/sproutboat-edge bin/
( cd src/spike && export CARGO_TARGET_DIR=$D/target-tools && systemd-run --user --scope --quiet -p MemoryMax=2G nice -n 10 cargo build --release -j2 2>&1 | tail -2 )
cp target-tools/release/{certgen,backend,bench} bin/
if [ ! -x bin/caddy ]; then
  v=2.11.9
  curl -fsSL -o caddy.tgz "https://github.com/caddyserver/caddy/releases/download/v$v/caddy_${v}_linux_amd64.tar.gz"
  echo "0e85544340290a16ce4bfb76fe7d65e9de1bf3a6e67f5ccfff30b30d27ea4c73e078077b7bf3e58ae60b6b12e44327705287059c775bca5782e8ee85ea7edd75  caddy.tgz" | sha512sum -c -
  echo "0e85544340290a16ce4bfb76fe7d65e9de1bf3a6e67f5ccfff30b30d27ea4c73e078077b7bf3e58ae60b6b12e44327705287059c775bca5782e8ee85ea7edd75  caddy.tgz" | sha512sum -c -
  tar -xzf caddy.tgz -C bin caddy && rm caddy.tgz
fi
bin/caddy version
ls -l bin

#!/usr/bin/env bash
# Build the two hand-made sproutd modules the e2e deploys: app-v1.so and app-v2.so.
#
#   tools/sproutd-e2e/build-modules.sh SPROUTD_DIR GENERATION_DIR CLI_DIR OUT_DIR
#
# SPROUTD_DIR      a sproutd checkout (build/compile-app.ts)
# GENERATION_DIR   its built generation (bun build/build.ts out/gen -> out/gen/generation)
# CLI_DIR          a sproutboat-cli checkout with its dependencies installed (bun install)
# OUT_DIR          receives app-v1.so, app-v2.so and their SHA-256 sums
#
# A module is only valid against the generation it was compiled for (design 05, section 3), so build
# these with the generation the VM's sproutd runs. Phase 2 replaces this script with a compile service.
set -euo pipefail
SPROUTD=$(cd "$1" && pwd); GEN=$(cd "$2" && pwd); CLI=$(cd "$3" && pwd); OUT=$(mkdir -p "$4" && cd "$4" && pwd)
HERE=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/sbd-e2e-build.XXXXXX")
trap 'rm -rf "$work"' EXIT
for v in v1 v2; do
  app="$work/$v"
  mkdir -p "$app"
  cp -R "$HERE/app/." "$app/"
  sed -i.bak "s/__VERSION__/$v/" "$app/src/index.js" && rm "$app/src/index.js.bak"
  (cd "$app" && bun "$CLI/src/main.ts" build "$app" --standalone --emit-only >/dev/null)
  bun "$SPROUTD/build/compile-app.ts" "$GEN" "$app" "$OUT/app-$v.so" --name "phase1-$v"
done
(cd "$OUT" && shasum -a 256 app-v1.so app-v2.so | tee SHA256SUMS)

FROM oven/bun:1.4.0

# Porffor native-fetch cross-compile toolchain:
#   build-essential/clang -> cc, c++, make   (uSockets + the generated server)
#   cmake                 -> the per-build server link step (>= 3.20)
#   git                   -> one-time uWebSockets source fetch
#   curl                  -> artifact smoke test
RUN apt-get update \
  && apt-get install --yes --no-install-recommends build-essential clang cmake git curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

# Apply the Porffor patches (patches/*.patch) during `bun install`'s postinstall,
# so they must be present before it runs.
COPY package.json bun.lock ./
COPY tools ./tools
COPY patches ./patches
RUN bun install --frozen-lockfile

COPY . .

# Stamp the toolchain identity so the CLI reads it from the image
# (`docker run <ref> --entrypoint cat /opt/sproutboat-toolchain.json`) rather
# than the monorepo's bun.lock / node_modules.
RUN bun -e 'import { porfforVersion } from "./tools/porffor"; \
  const esbuild = (await Bun.file("node_modules/esbuild/package.json").json()).version; \
  process.stdout.write(JSON.stringify({ porffor: porfforVersion(), esbuild }))' > /opt/sproutboat-toolchain.json

# Warm the uWebSockets cache (git clone + `uSockets.a` build) into this layer so
# per-deploy compiles reuse it instead of each taking minutes.
RUN bun run tools/compile.ts tests/porffor/capabilities/01-hello.js /tmp/prewarm \
  && rm -f /tmp/prewarm

ENTRYPOINT ["bun"]

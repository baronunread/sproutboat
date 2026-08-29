# Porffor compile toolchain image

`sproutboat build` compiles a handler to a `linux/amd64` native `worker` inside
this image (Node + a C toolchain + uWebSockets + the pinned Porffor). It runs on
whatever machine runs the CLI — normally your laptop, `wrangler`-style — not the
server.

CI (`.github/workflows/build-image.yml`) builds and publishes it to
`ghcr.io/baronunread/sproutboat/build` whenever the Dockerfile, the Porffor pin
(`bun.lock`), or the wrap/patch logic changes. The CLI `docker pull`s it on
first `build` and records its registry digest in the manifest.

Build it yourself (offline, or a private registry):

```sh
docker build --platform linux/amd64 -t ghcr.io/baronunread/sproutboat/build:latest -f build-image/Dockerfile .
```

Overrides:

- `SPROUTBOAT_BUILD_IMAGE_REF` — a different ref to pull/run.
- `SPROUTBOAT_BUILD_IMAGE` — pin an exact `…@sha256:…` digest (skips the pull).

The CLI runs the image with networking disabled, a read-only source mount, and a
writable artifact mount.

# Local build image

The build image is the only supported route to a `linux/amd64` worker when the
developer host is not native Linux x86-64. Build it with:

```sh
docker build --platform linux/amd64 -t sproutboat/build:dev -f build-image/Dockerfile .
```

The CLI invokes the image with networking disabled, a read-only source mount,
and a writable artifact mount. `SPROUTBOAT_BUILD_IMAGE` must contain the immutable
image identity recorded in the manifest. For a locally tagged test image, set
`SPROUTBOAT_BUILD_IMAGE_REF=sproutboat/build:dev` as the runnable reference too.

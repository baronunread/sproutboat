#!/usr/bin/env sh
set -eu

docker build --platform linux/amd64 -t sproutboat/build:stable -f build-image/Dockerfile .
image_id=$(docker image inspect sproutboat/build:stable --format '{{.Id}}')
printf '%s\n' "Built sproutboat/build:stable (${image_id})"
printf '%s\n' "For a local build, set SPROUTBOAT_BUILD_IMAGE=sproutboat/build@${image_id} and SPROUTBOAT_BUILD_IMAGE_REF=sproutboat/build:stable."

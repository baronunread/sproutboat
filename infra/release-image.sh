#!/usr/bin/env sh
set -eu

docker build --platform linux/amd64 -t porffer/build:stable -f build-image/Dockerfile .
image_id=$(docker image inspect porffer/build:stable --format '{{.Id}}')
printf '%s\n' "Built porffer/build:stable (${image_id})"
printf '%s\n' "For a local build, set PORFFER_BUILD_IMAGE=porffer/build@${image_id} and PORFFER_BUILD_IMAGE_REF=porffer/build:stable."

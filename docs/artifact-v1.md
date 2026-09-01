# artifact-v1

An upload is exactly `manifest.json` plus an executable `worker`; it never
contains source code. The manifest is validated by
the CLI package (`sproutboat/runtime/manifest`) before storage or activation.

`artifact-v1` targets `linux-x86_64`, uses `abi-v1`, and supports only the
`http-sync-v0` capability profile. Both worker and source digests are lowercase
SHA-256 values prefixed by `sha256:`.

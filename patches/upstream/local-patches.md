# Historical local patch inventory

This records the original CLI patch step. Current Porffor patches and the pin
live in `@sproutboat/toolchain` (`packages/toolchain/src/patch.ts` and
`packages/toolchain/src/acquire.ts` in `sproutboat-packages`). The original
`src/patch-porffor.ts` used idempotent, marker-guarded in-place edits of
Porffor's generated C:

- `compiler/render.js`: the native-fetch server reads its listen port from
  `$PORT` at runtime (falling back to the compiled `port:`), routes handler
  `console` output to stderr unbuffered (#165), and UTF-8 encodes the
  `bytestring` (Latin-1-range) branch of `porf_native_fetch_read_value` instead
  of copying its code units onto the wire raw (#172).
- `compiler/index.js`: `SB_EXTRA_LINK` / `SB_EXTRA_CFLAGS` splice points so a
  standalone build can link SQLite / include `<bearssl.h>` (#15).
- `compiler/uwebsockets.js`: configurable request-body limit (#56), the #156
  status-line fix, and the #163 `x-sb-remote-addr` synthetic header. See the
  linked notes in [the index](README.md).

At the time, the pin lived in `src/porffor-toolchain.ts` (`PORFFOR_CHANNEL` /
`PORFFOR_COMMIT_FULL`) at **alpha-6** (`038f415e`). The current toolchain uses
**alpha-7** (`8f015414`). Patches are applied from the build path, not a
`postinstall` hook: package managers block dependency lifecycle scripts by
default, so a published `postinstall` would silently not run.

This patch step is the only thing keeping the CLI on Porffor **source**
(`github:CanadaHonk/porffor#<channel>`) rather than the prebuilt release binary
(`porffor-<host>.tar.gz`, ~2 MB, same commit): the prebuilt binary has no
`render.js` to patch. If the remaining edits in these notes land upstream,
the prebuilt binary can replace that source-patching step.

For the original `$PORT` proposal, see the [runtime port draft](runtime-port.md).
The maintainer may want a general environment binding instead of a `PORT`
special case.

# Response bytestrings go out raw instead of UTF-8 encoded (#172)

**Version:** `alpha-5` @ `1f4ae4ae`, `compiler/render.js`, native-fetch build.

`porf_native_fetch_read_value()` is where a response body, header name, or
header value crosses from Porffor's internal string representation to the
bytes uWS writes on the socket. Its `${TYPES.string}` (UTF-16) branch correctly
encodes each unit to UTF-8. Its `${TYPES.bytestring}` branch, the
Latin-1-range representation Porffor uses whenever every code point fits one
byte, which most JS strings do, instead copies the raw code units straight
into `*out_buf`, no encoding at all. A code unit in `0x00-0x7F` happens to be
identical in both encodings, so plain ASCII output looks fine; anything in
`0x80-0xFF` (`é`, `ñ`, `€`'s constituent bytes, any accented Latin text) reaches
the client as the raw Latin-1 byte instead of its 2-byte UTF-8 encoding. The
result is mojibake regardless of what `Content-Type` charset the handler declares.

**Local patch** (`@sproutboat/toolchain`'s `patchRenderJs` in
`packages/toolchain/src/patch.ts`): give the `bytestring` branch the same treatment as its
`string` sibling three lines down: walk the units, emit each as 1 or 2 UTF-8
bytes depending on whether it's below `0x80`, into a `malloc`'d buffer handed
back through the existing `out_owned` (freed by the caller, same as the
`string` branch already relies on).

**Upstream shape** (rewrite before filing, per `AI_POLICY`; file as an issue):
`porf_native_fetch_read_value`'s `bytestring` branch should UTF-8 encode like
its `string` branch does, not copy raw. Distinguishing "value that happens to
fit one byte per unit" from "value that is already UTF-8 bytes" is an internal
representation detail; nothing about the wire protocol should leak it.

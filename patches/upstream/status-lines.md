# Unlisted HTTP status codes reset the connection (#156)

**Version:** `alpha-5` @ `1f4ae4ae`, `compiler/uwebsockets.js`, native-fetch build.

`lookup_status_line(i32 status)` is a `switch` mapping status codes to reason
strings for `res->writeStatus()`. Its `default` returns an empty
`std::string_view`, so any code not in the switch, such as 303, 206, 300, 305,
402, or 451, produces `writeStatus({})`, a malformed status line, and the client
sees a connection reset (`curl` reports `000`). Only the embedded/standalone
response path is affected; a deployed sprout's Response travels as frame JSON
and the broker's own HTTP stack serializes the status line.

**Local patch** (`@sproutboat/toolchain`'s `patchUwebsockets` in
`packages/toolchain/src/patch.ts`): widen the return
type to `std::string` and make `default` synthesize `"<code> Status"` from the
number, so every code produces a well-formed line. Add `case 303: return "303
See Other";` for the common one's real phrase. The sole caller feeds the result
straight to `writeStatus`, which copies synchronously, so returning by value is
safe.

**Upstream shape** (rewrite before filing, per `AI_POLICY`; file as an issue):
the `default` case should still yield a syntactically valid status line rather
than an empty one: either a synthesized `"<code> \r\n"` or the full IANA table.
A silent connection reset for a valid HTTP status is the worst failure mode.

Repro: `porf native` a handler that returns `new Response("", { status: 303 })`
and `curl` it: the connection resets. `302`/`307` are fine.

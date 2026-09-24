# Native fetch cannot expose the remote address (#163)

**Version:** `alpha-5` @ `1f4ae4ae`, `compiler/uwebsockets.js`, native-fetch build.

`collect_headers()` takes only `uWS::HttpRequest*`, and nothing else about the
connection reaches the handler. `uWS::HttpResponse::getRemoteAddressAsText()`
has the peer address right there, but the handler has no way to it, so every
app behind a proxy hand-rolls `X-Forwarded-For` parsing, and every app in front
of one has no client IP at all. workerd (`request.cf`), `Deno.serve`
(`info.remoteAddr`) and `Bun.serve` (`server.requestIP`) all expose it.

**Local patch** (`@sproutboat/toolchain`'s `HDR_*` entries in
`packages/toolchain/src/patch.ts`): `collect_headers`
grows a `res` argument and appends one synthetic request header,
`x-sb-remote-addr: <res->getRemoteAddressAsText()>`, after dropping any inbound
header of that name. The prelude reads it into `request.cf.clientIp`, folds
IPv4-mapped IPv6, and resolves it against `SB_TRUSTED_PROXIES` +
`X-Forwarded-For`.

**Upstream shape** (rewrite before filing, per `AI_POLICY`; file as an issue):
expose the remote address to a native-fetch handler, on `request` (a
documented field, or `request.cf` for workerd parity), or as a second argument
to `fetch`. The IPv4-mapped-IPv6 form uWS returns for v4 clients on a
dual-stack socket is worth normalising there too.

Repro: `porf native` any `export default { fetch }`: there is no property or
argument carrying the client's IP.

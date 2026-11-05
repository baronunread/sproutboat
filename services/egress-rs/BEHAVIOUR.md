# Egress service: behaviour and security contract

Subject: `sproutboat-egress` (this crate), a one-for-one replacement for the Bun egress service,
`@sproutboat/wire/src/egress.ts` (HTTP) and, from sproutboat-packages main, `tcp.ts`
(`listenTunnelService`, the TCP tunnel behind `connect()`). Address policy comes from
`@sproutboat/runtime`'s `egress.ts` (`BLOCKED_RANGES`, `egressRefusal`).

Note: the Bun 1.4.0 the installer ships differs from 1.4.4 in URL credentials, HEAD framing and refused-connect wording; the Rust service follows 1.4.3+, and the differential run lists those cases in `tools/egress-diff/known-differences-bun-before-1.4.3.json` only while the service's Bun is older.

Evidence: every statement below about the Bun service was checked by running it (Bun 1.4.4, macOS) through
`tools/egress-diff` (see "How it is tested"). Where the Bun service does something that looks like an accident, it is
listed under "Quirks preserved" and kept, unless it is one of the intentional differences D1 to D6.

## 1. What the service is

Brokers (inside `sproutboat-edge.service`, whose `IPAddressDeny=any` keeps sprouts off the network) hand every outbound
`fetch()` to this service on loopback; sprouts share loopback, so each call carries a token only brokers have. The
service resolves, vets every address, connects to a vetted address, and relays one request. `connect()` sockets use the
same vetting through a second, raw-TCP listener.

How the Bun pieces relate: `@sproutboat/runtime` `egress.ts` is the address table and refusal text (shared by the TS
broker path, the Bun service and, generated, the C client in `transport-embedded.js`); `@sproutboat/wire` `egress.ts` is
the service and `vettedFetch`; the broker (`broker.ts`) calls the service when `SB_EGRESS_URL` is set and otherwise runs
`vettedFetch` itself. The Rust service replaces only the service process. The broker, the runtime table and the C client
are untouched and keep working; the Rust table (`src/addr.rs`) is a port of the runtime table and is pinned to it by
tests and the differential harness.

## 2. Process interface

```
SB_EGRESS_TOKEN=... [SB_EGRESS_ALLOW=...] sproutboat-egress [--host 127.0.0.1] [--port 8070] [--tcp-port <port+1>]
```

| Item                           | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SB_EGRESS_TOKEN`              | Required. Unset or empty: prints `sproutboat egress: SB_EGRESS_TOKEN is required` on stderr, exit 1.                                                                                                                                                                                                                                                                                                                                                                                                     |
| `--host`                       | Default `127.0.0.1`. The service does not authenticate by address; the token is the gate. Never bind it to a public address.                                                                                                                                                                                                                                                                                                                                                                             |
| `--port` / `PORT`              | HTTP port. `--port` wins, then `PORT`, default 8070. `0` picks a free port.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `--tcp-port`                   | Tunnel listener, default HTTP port + 1 (Bun: same). `0` picks a free port.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `SB_EGRESS_ALLOW`              | Comma-separated entries: `*` (everything), an IP address in any spelling, or a CIDR range. Entries are **parsed**: `::ffff:7f00:1`, `::ffff:127.0.0.1` and `127.0.0.1` are one address, `10.0.0.0/8` allows a subnet. An entry that is none of these makes the service exit 1 at startup with `sproutboat egress: invalid SB_EGRESS_ALLOW entry "<entry>": expected an IP address, a CIDR range such as 10.0.0.0/8, or *`. (**Differs from Bun**, which compared answer text exactly and had no ranges.) |
| `SB_EGRESS_STRICT`             | Rust only. The whole address table (section 6.1) applies unless this is `0`; `0` limits the check to the first 22 entries, the table the released Bun service has. An opt-out, not a mode: nothing else changes.                                                                                                                                                                                                                                                                                         |
| `SB_EGRESS_CONNECT_TIMEOUT_MS` | Rust only. How long opening a connection (TCP, and the TLS handshake for https) may take, default 10000. Also the tunnel's connect deadline when set (default 15000 there). Not a positive integer: exit 1 at startup with a message.                                                                                                                                                                                                                                                                    |
| `SB_CA_BUNDLE`                 | PEM file of extra TLS roots, added to the built-in roots. Never removes roots, never disables verification.                                                                                                                                                                                                                                                                                                                                                                                              |
| `SB_EGRESS_THREADS`            | Rust only: tokio worker threads, default 2 (more threads cost CPU per request on a loopback helper; see the PR benchmark).                                                                                                                                                                                                                                                                                                                                                                               |
| `SB_EGRESS_MAX_REQUEST_BYTES`  | Rust only: request-body cap, default 128 MiB (what `Bun.serve` enforces by default).                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Output                         | stdout `sproutboat egress tunnels listening on port N`, then `sproutboat egress listening on http://127.0.0.1:PORT/`. `--print-ranges` prints the address table as JSON and exits (used by the harness to pin it to the TS one).                                                                                                                                                                                                                                                                         |
| Signals                        | SIGTERM / SIGINT exit 0 (Bun: default signal handling).                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Port in use                    | Exit 1 with a message on stderr.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

systemd: this is the default egress. `sproutboat-egress.service` runs `/usr/local/lib/sproutboat/bin/sproutboat-egress --host 127.0.0.1 --port 8070` with `MemoryMax=128M`; `sbctl engine bun` swaps in the Bun egress through a generated drop-in (`infra/sb-engine`). See the Engines section of `infra/README.md`.

## 3. HTTP contract

One request in, one upstream request out. The request path and query of the call to the service itself are ignored.

### 3.1 Request headers

| Header              | Meaning                                                                |
| ------------------- | ---------------------------------------------------------------------- |
| `x-sb-egress-token` | Must equal the token (compared in constant time after a length check). |
| `x-sb-egress-url`   | The target, parsed with the WHATWG URL parser.                         |

Duplicate headers are folded with `, ` before use (a `Headers` object does the same).

### 3.2 Order of checks

1. Token: missing, wrong length or wrong value: **401**, `content-type: text/plain;charset=utf-8`, body `unauthorized`.
2. URL: absent, empty, relative or unparsable: **400** JSON `{"error":"invalid url: <raw header value>"}`.
3. Scheme other than `http`/`https`: **400** `{"error":"unsupported protocol: <scheme>:"}`.
4. Destination port 25: **502** `{"error":"fetch() refused: port 25 is blocked, as on Workers"}`, before any lookup (the tunnel
   refuses it with the same words and `connect()`). **Differs from Bun**, which has no port rule.
5. Resolve the host and vet each answer. **Before any of the request body is read** (Bun read the whole body first).
6. Request body: GET and HEAD carry none. Otherwise a declared length over the body cap is **413** at once; a declared length
   up to 256 KiB is read into memory; anything else (larger, or chunked) is **streamed** to the upstream as it arrives, and
   cut off with **413** if it runs past the cap.
7. Connect, relay.

Every error from 2 on carries `x-sb-egress-error: 1` (413 excepted: plain text) and, for JSON errors,
`content-type: application/json;charset=utf-8`. Failures after the vetting step are **502** with `{"error":"<message>"}`.

### 3.3 The upstream request

- Method and body as received. GET and HEAD never carry a body (a body sent with them is dropped). A buffered body always
  carries `content-length` (`0` when empty), as Bun's `fetch` does; a streamed one carries the caller's, or is chunked.
- Headers: all of the caller's, except `x-sb-egress-url`, `x-sb-egress-token`, `host`, `content-length` (Rust also drops
  `transfer-encoding` and `expect`, which cannot survive re-framing the body; not probed on Bun).
- `Host` is set to the URL's host plus its port when not the scheme default, never the address connected to.
- Request target is path plus query; the fragment is dropped.
- `user:pass@` in the URL becomes `Authorization: Basic ...` (percent-decoded) unless the caller sent `Authorization`.
- `Accept: */*` is added when absent (Bun does too, and so does workerd). **No `User-Agent` is added**: the upstream sees one
  only if the app set it. (**Differs from Bun**, which added `User-Agent: Bun/<version>`. User-visible: some APIs reject a request
  with no user agent; release notes.)
- No `Accept-Encoding` is added, and the response is **not** decompressed: bytes and `Content-Encoding` pass through, so the
  broker decodes exactly as a direct fetch would.
- Redirects are **not** followed: a 3xx comes back as is, `Location` untouched. (This is also a security property: a
  redirect to a private address is the broker's next call, vetted again.)
- HTTP/1.1 only, keep-alive. Connections are pooled per (scheme, name, address, port); see 3.6.

### 3.4 The response

Status and headers as the upstream sent them, body streamed. Repeated headers are folded with `, `, except `set-cookie`
which stays one entry per cookie. `transfer-encoding` is dropped (the service frames its own response). A body-carrying
response with no `content-type` gets `application/octet-stream` (a Bun `Response` built from a stream does this; 204, 205,
304, HEAD and `content-length: 0` do not). `date` is the service's own. A truncated or reset upstream body aborts the
response to the broker (it does not look like a complete answer).

### 3.5 Timeouts and limits

| Item                 | Bun service                                                          | Rust service                                                                                                                                                                                                                   |
| -------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Idle / total timeout | none (`idleTimeout: 0`; the broker owns the deadline)                | none (same)                                                                                                                                                                                                                    |
| Connect timeout      | the OS's                                                             | 10 s for TCP and, separately, the TLS handshake (`SB_EGRESS_CONNECT_TIMEOUT_MS`); then 502 `connect to <ip>:<port> timed out after <n> ms (SB_EGRESS_CONNECT_TIMEOUT_MS)`. A timeout is final (no next address), like a reset. |
| Request body         | 128 MiB (`Bun.serve` default), then 413, all buffered before vetting | 128 MiB (`SB_EGRESS_MAX_REQUEST_BYTES`), then 413; at most 256 KiB buffered per request, the rest streamed after vetting                                                                                                       |
| Response body        | unlimited, streamed                                                  | unlimited, streamed                                                                                                                                                                                                            |
| Client goes away     | the upstream request keeps running                                   | the upstream request is cancelled                                                                                                                                                                                              |
| Idle upstream conns  | Bun's pool                                                           | 15 s, 64 per key, 512 keys                                                                                                                                                                                                     |

### 3.6 Connection reuse

A pooled connection is reused only for the same (scheme, name, vetted address, port), so a TLS session verified for one
name is never used for another. The address is vetted on every request, pooled or not; a name that now resolves somewhere
else gets a new connection to the new, vetted address. If a reused connection turns out to have been closed by the server
before any response byte arrived, a request whose body is in memory is retried once on a fresh connection. A streamed body
is always sent on a connection opened for it (it cannot be replayed), and that connection may be pooled afterwards.

### 3.7 TLS

`https` targets connect to the vetted address and verify the certificate against the **name** (or the address, for an IP
literal), with SNI set to the name (none for an IP). Roots: the built-in set plus `SB_CA_BUNDLE`. Verification cannot be
turned off. ALPN offers `http/1.1` only.

### 3.8 Failure messages

| Situation                     | `error` text                                                                                                                                      | Same as Bun            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Refused address               | `fetch() refused: <host> resolves to <address>, a private or reserved address (<range>). An operator can allow it with SB_EGRESS_ALLOW=<address>` | byte for byte          |
| Port 25                       | `fetch() refused: port 25 is blocked, as on Workers`                                                                                              | no (Bun had no rule)   |
| Resolution failed / no answer | `could not resolve <host>` (host as in the URL, brackets kept for IPv6)                                                                           | yes                    |
| Connection refused            | `ECONNREFUSED: Unable to connect. Is the computer able to access the url?`                                                                        | yes                    |
| Connect timeout               | `connect to <ip>:<port> timed out after <n> ms (SB_EGRESS_CONNECT_TIMEOUT_MS)`                                                                    | no (Bun had none)      |
| Other transport / TLS failure | Free text (`TLS handshake failed: ...`, `upstream request failed: ...`)                                                                           | status and header only |

The broker shows these to the app as the `fetch()` error, so only the refusal, resolution and refused-connection texts are
contract. Others differ in wording.

## 4. Tunnel contract (`connect()`)

A second raw-TCP listener. The first frame from a broker is `[u32 LE length][payload]`, payload `[u8 1][u32 LE jsonLen][json]`
with `{"v":1,"token":...,"op":"tcp.open","host":...,"port":...,"mode":"off"|"on"|"starttls","servername":...}`. Anything
else after that is typed frames, `[u8 type][u32 LE length][payload]`:

| Direction         | Types                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| broker to service | 1 data, 2 startTls (payload: server name), 3 shut down the write side, 7 close                   |
| service to broker | 1 data, 4 error (reason), 5 connected, 6 TLS done, 7 closed, 8 end of input (origin half-closed) |

There is no ack on this endpoint; refusals are error frames and the service then closes. Admission order: token (`unauthorized`),
open sockets >= 256 (`Too many open connections`), `host` empty or over 255 chars or bad `mode` (`invalid tunnel target`),
`port` not an integer in 1..65535 (`invalid tunnel port`), port 25 (`connect() refused: port 25 is blocked, as on Workers`).
The head is limited to 64 KiB (more: close without a reply); a first frame that is not a `tcp.open` gets an error frame
`expected tcp.open`.

Vetting is the `fetch()` vetting with the word `fetch()` replaced by `connect()` in the refusal. `host` is used as the
broker sent it (not URL-normalised): an IP literal (strict IPv4, or any IPv6 text, brackets stripped) is its own single
answer; anything else goes to the resolver. Origin connection: every vetted address in order within one 15 s deadline,
next address on any failure. `mode: on` is TLS from the first byte, verified against `servername` (default `host`; none
for an IP). `starttls` upgrades on frame 2. Backpressure is TCP's: a side that cannot write is not read from, with at most
256 KiB buffered each way.

## 5. Quirks preserved, and intentional differences

Preserved from Bun:

1. A response without `content-type` gains `application/octet-stream` (when it has a body).
2. `Authorization` is built from URL userinfo unless the caller sent one; `Accept: */*` is added when absent.
3. When some answers are refused and some are fine, the fine ones are used and the refused ones dropped silently; the
   refusal text is only returned when no answer is usable. Which refusal is named is the first in resolver order.
4. A refused or unreachable address falls through to the next only for _refused / network unreachable / host unreachable_;
   a timeout or reset is final.
5. IPv4-mapped answers are vetted by the IPv4 they carry.
6. `connection: close` / `keep-alive` response headers from the upstream pass through.
7. The tunnel accepts only the exact head shape the Bun code does (`"op":"tcp.open"` must appear verbatim in the JSON text).

**Intentional differences from the Bun service** (each is a case in `tools/egress-diff/known-differences.json`, marked
INTENTIONAL):

| #   | Difference                                                                                                                                                                                                                   | Why                                                                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| D1  | The whole address table is on by default (section 6.1: eight more ranges). `SB_EGRESS_STRICT=0` restores the old 22. The same ranges are added to the shared TS table in sproutboat-packages#240, after which the two agree. | Reserved space with no public service (finding F2, closed).                                         |
| D2  | `fetch()` to destination port 25 is refused.                                                                                                                                                                                 | Workers blocks it, the tunnel already did (F4, closed for 25; there is still no wider port policy). |
| D3  | The destination is vetted before the request body is read; the body is then streamed (at most 256 KiB held in memory); the 128 MiB cap stays.                                                                                | A refused or hostile destination no longer costs a buffered upload (F6, closed).                    |
| D4  | `SB_EGRESS_ALLOW` parses its entries: CIDR ranges, any spelling of an address (so allowing `127.0.0.1` also allows `::ffff:127.0.0.1`, the same destination); invalid entries stop the service at startup.                   | Exact text matching surprised operators (F5, closed).                                               |
| D5  | Connection timeout, 10 s, configurable, with a clear message.                                                                                                                                                                | Bun had none; an unroutable target held a connection for the OS timeout.                            |
| D6  | No default `User-Agent`. **User-visible, release notes:** an app that sets none now sends none (as on workerd); some APIs (GitHub, for one) reject such requests.                                                            | Matches workerd; "Bun/x.y.z" was an implementation leak.                                            |

Not preserved on purpose (all invisible to a correct broker): header-name case (hyper lowercases), the exact bytes of
framing (`content-length` vs `transfer-encoding: chunked`), the text of transport errors, and the Bun service dying on
malformed tunnel JSON (Finding F1).

## 6. Security

### 6.1 Blocked ranges (default: the 30 entries of `BLOCKED_RANGES`)

Order is the order in which the first match names the range in the refusal.

| Range             | What                                             | Range            | What                                                               |
| ----------------- | ------------------------------------------------ | ---------------- | ------------------------------------------------------------------ |
| `0.0.0.0/8`       | "this network", unspecified                      | `::/96`          | unspecified, loopback `::1`, **every** IPv4-compatible `::a.b.c.d` |
| `10.0.0.0/8`      | private                                          | `64:ff9b:1::/48` | local-use NAT64                                                    |
| `100.64.0.0/10`   | CGNAT                                            | `100::/64`       | discard-only                                                       |
| `127.0.0.0/8`     | loopback                                         | `2001:db8::/32`  | documentation                                                      |
| `169.254.0.0/16`  | link-local, **cloud metadata (169.254.169.254)** | `fc00::/7`       | unique local (ULA)                                                 |
| `172.16.0.0/12`   | private                                          | `fe80::/10`      | link-local                                                         |
| `192.0.0.0/24`    | IETF protocol assignments                        | `fec0::/10`      | site-local (deprecated)                                            |
| `192.0.2.0/24`    | TEST-NET-1                                       | `ff00::/8`       | multicast                                                          |
| `192.168.0.0/16`  | private                                          |                  |                                                                    |
| `198.18.0.0/15`   | benchmarking                                     |                  |                                                                    |
| `198.51.100.0/24` | TEST-NET-2                                       |                  |                                                                    |
| `203.0.113.0/24`  | TEST-NET-3                                       |                  |                                                                    |
| `224.0.0.0/4`     | multicast                                        |                  |                                                                    |
| `240.0.0.0/4`     | reserved, **limited broadcast 255.255.255.255**  |                  |                                                                    |

Then, appended last (section 6.2): `192.31.196.0/24`, `192.52.193.0/24`, `192.88.99.0/24`, `192.175.48.0/24`, `::ffff:0:0:0/96`, `2001::/23`, `3fff::/20`, `5f00::/16`.

Embedding rule: an IPv6 address in `::ffff:0:0/96` (IPv4-mapped), `64:ff9b::/96` (NAT64) or `2002::/16` (6to4, bytes 2..6)
is checked by the IPv4 address it carries, against the table above. So `::ffff:127.0.0.1`, `64:ff9b::7f00:1` and
`2002:7f00:1::` are refused as `127.0.0.0/8`, while `64:ff9b::8.8.8.8` and `2002:808:808::` pass. Text that is not an
address at all (including a scoped IPv6 such as `fe80::1%eth0`) is refused as `unparseable address`.

`SB_EGRESS_ALLOW` is the operator's override: `*` disables the block entirely, otherwise only the listed addresses and ranges
(section 2). It belongs to the service's environment, never to the app.

### 6.2 The eight added ranges (default; `SB_EGRESS_STRICT=0` drops them)

The last eight entries of the table, added after the Bun service shipped (sproutboat-packages#240 adds them to the shared TS
table, the Bun egress and the C client): `192.31.196.0/24` (AS112), `192.52.193.0/24`, `192.88.99.0/24` (6to4 relay anycast),
`192.175.48.0/24`, `::ffff:0:0:0/96` (SIIT: carries an IPv4 that the mapped rule does not see), `2001::/23` (IETF protocol
assignments, includes Teredo `2001::/32`), `3fff::/20` (documentation), `5f00::/16` (SRv6). Plain table entries: the same
embedding rule and the same refusal text as the rest. The harness case `ranges/table-pinned` compares the Rust table to the
`BLOCKED_RANGES` of the Bun runtime in use.

### 6.3 DNS rebinding

1. The host is resolved **once per request**. Every answer is vetted. The connection goes to a vetted `IpAddr`
   (`TcpStream::connect(SocketAddr)`); the name is never given to a connector, so no second lookup exists to be raced.
2. TLS verifies against the name, so connecting by address costs no security.
3. The pool key includes the vetted address, and vetting runs again on every request. A name that changes its answer
   between requests is vetted again and gets a new connection if the address changed.
4. Redirects are not followed, so a redirect cannot smuggle in an unvetted address.
5. The tunnel does the same per `tcp.open`.

Tested: `services/egress-rs/tests/service.rs` (counting resolver: one lookup per request, a private second answer is never
used; a private first answer is refused with no connect) and `tools/egress-diff` suite `rebind` (a DNS stub over HTTP, both
services against the same script).

### 6.4 Address forms

IPv4 hosts in decimal (`2130706433`), hex (`0x7f000001`, `0x7f.1`), octal (`0177.0.0.1`), short (`127.1`), percent-encoded,
fullwidth digits and ideographic dots are normalised to dotted decimal by the WHATWG URL parser (the `url` crate, same as
Bun's) before the vetting, so they are refused by address. In the tunnel, where `host` is not URL-parsed, such a form is not
an IP literal, goes to the system resolver, and is vetted by what it resolves to. The decision is always made on the address
that will be connected to.

### 6.5 Other defences

- Token compared in constant time; 401 before any other work; the service has no unauthenticated route.
- No redirect following, no proxying of `CONNECT`, only `http`/`https` schemes.
- Service-owned headers (`x-sb-egress-*`, `host`, `content-length`) cannot be forged through to the upstream.
- The tunnel head is capped (64 KiB), typed frames capped (1 MiB), open tunnels capped (256), port 25 refused.
- Malformed input never kills the process: bad JSON in a tunnel head gets an error frame; a panicking connection task is
  isolated by tokio.

### 6.6 Findings (status after D1 to D6)

- **F1 (Bun, availability, `tcp.ts` on sproutboat-packages main).** A `tcp.open` frame whose JSON is malformed but contains
  the text `"op":"tcp.open"` throws an uncaught `SyntaxError` inside the listener and the egress process exits. No token is
  needed (the head is parsed before the token check) and sprouts share loopback, so a sprout could take egress down for every
  app. Rust answers an error frame. Not in the released 0.21.4 (no tunnel there yet): fix before it ships.
- **F2 (closed, D1).** Teredo, SIIT, `3fff::/20`, `5f00::/16`, `192.88.99.0/24` and the other old anycast / AS112 blocks were
  reachable by `fetch()` in the Bun service. Now blocked in both.
- **F3.** 6to4 `2002::/16` and NAT64 `64:ff9b::/96` with a **public** embedded IPv4 are allowed; correct, but it means a
  public-looking IPv6 may be translated to a different network by the host's resolver or routing. Only matters on hosts with
  a NAT64/6to4 gateway.
- **F4 (port 25 closed, D2).** `fetch()` still has no wider destination-port policy: an app can reach any other port of a public
  address. Workers refuses a set of ports.
- **F5 (closed, D4).** Allow entries were exact text.
- **F6 (closed, D3).** The request body of non-GET methods was buffered whole (up to 128 MiB) before vetting in the Bun
  service. Rust holds at most 256 KiB per request and vets first. A loopback caller holding the token can still stream up to
  128 MiB per request through (it does not sit in memory).
- **F7 (closed, D4).** The allow-list used the resolver's text, which depended on how a libc prints an address. Entries and answers
  are now compared as parsed addresses.

## 7. How it is tested

- `cargo test` (unit): every address class in 6.1 (private, CGNAT, loopback, link-local, metadata, `0.0.0.0`, broadcast,
  multicast, IPv6 loopback, ULA, link-local, IPv4-mapped, IPv4-compatible, 6to4 and NAT64 embedding, decimal / octal / hex /
  percent-encoded / fullwidth host forms), the parser, the refusal text, allow-list parsing (spellings, CIDR, invalid entries), the added ranges and the `SB_EGRESS_STRICT=0` opt-out.
- `cargo test` (service): rebinding, mixed answers, address forms through the resolver, fall-through, pooling, token and URL
  errors, port 25, vetting before the body is read, body streaming and the cap, no default user agent, CIDR allow, the added
  ranges, connect timeout, tunnel relay and refusal.
- `tools/egress-diff/run.ts`: the same requests to the Bun and the Rust service, compared on status, headers, body, what the
  upstream saw, refusal texts and DNS lookup counts.
- `tools/egress-diff/ts-suite.test.ts`: the service tests of `@sproutboat/wire`'s `egress.test.ts` against the Rust binary.

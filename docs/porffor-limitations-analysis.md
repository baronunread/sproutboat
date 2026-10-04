# Porffor limitations in native HTTP apps

Measured 2026-09-27. Plain Porffor can run a small native HTTP/JSON success path with a very small footprint, but compiling an application does not establish that its behavior is correct. The most consequential findings are silent wrong answers, invalid HTTP/JSON output, and async responses that never settle. Missing host APIs are a separate, largely documented boundary.

This analysis compares Sproutboat's exact upstream compiler pin, `de4eb588264885b3a1596f75010e371a2052033f`, with upstream main resolved to `08ac7ee1077c05da2bec18dcca15197051e87b62` on 2026-09-27. These are immutable snapshots, not claims about future releases. Both are pristine verified archives with one transport-only change: bind the native listener to loopback. No Sproutboat runtime or compiler compatibility patches are present.

All four sync/async binaries compiled. We selected 45 focused semantic probes and ran each in three independently started native processes per version: 270 independent executions. Both versions passed the same 18 probes and failed the same 27. This is a deliberately targeted investigation of web-app boundaries, not a JavaScript compatibility percentage. The complete matrix below records every probe; the raw artifact includes expected values, actual responses, raw bytes, process exit status, recovery checks, and compiler/binary hashes.

## Missing APIs versus incorrect behavior

| Category                           | Observed boundary                                                                                                                                  | Practical consequence                                                                                                              |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Declared host surface              | No client fetch, Web Crypto operations, URLSearchParams, ReadableStream, AbortController, structuredClone, or Node process in these native servers | A Node/Workers app needs its host dependencies checked before migration. Missing APIs cannot be treated as slower implementations. |
| Implemented but incorrect behavior | Proxy traps ignored, incomplete Unicode codecs, JSON errors, array-like typed-array conversion and timezone parsing                                | A successful build and HTTP 200 can still contain an incorrect answer. These need semantic assertions.                             |
| HTTP protocol                      | Four valid status codes produced malformed status lines                                                                                            | Validation and error responses can fail before clients can inspect their body.                                                     |
| Async response settlement          | Returning an inner async call timed out; explicitly awaiting it worked                                                                             | Ordinary wrapper/helper composition can hang despite simple async handlers working.                                                |
| Unhandled synchronous failure      | Three probes terminated the native process with exit status 1                                                                                      | A route failure can stop the application, not just fail one response. Exception containment needs testing.                         |

Upstream's [runtime surface documentation](https://porffor.dev/docs/runtime.html) explicitly describes the smaller host API surface and the Proxy stub. Absence of `process` is a Node-host contrast, not a Workers compatibility defect. Our capability probe returns `undefined` for all eight inspected names/properties. In particular, the native bootstrap defines an empty crypto object, not a working Web Crypto implementation.

## HTTP status serialization

The same `new Response('ok', {status})` probe succeeded for 200, 201, 400, 401, 404, 405, 413, 429, 500, 501, 502 and 503. Codes 418, 422, 425 and 507 produced an empty status field: the client saw `HTTP/1.1` followed by a blank status and raised a protocol error. Each failed in all three fresh processes at both commits; the server remained healthy afterward.

The cause is directly visible in `compiler/uwebsockets.js`: `lookup_status_line` has a finite switch and its default returns an empty string. This explains the previous fixture's two HTTP 422 failures. It is a serializer limitation, not failure to calculate the order result. Other unlisted codes were not individually tested.

A numeric fallback status line is a small, localized fix and is already present in Sproutboat's compiler integration. It should be tested with an actual HTTP parser, not only a unit assertion on a status value.

## Unicode ingress, encoding and response bytes

The earlier unsigned Unicode order passed because its bytes survived a round trip. The new probes inspect the application's string semantics:

- `request.text()` on `caffè-🚤` reported length 11 and code units `[99,97,102,102,195,168,45,240,159,154,164]`. JavaScript's decoded UTF-16 string has length 8 and code units `[99,97,102,102,232,45,55357,56996]`.
- `request.json()` produced the same byte-valued string for its `id` field. It did not repair ingress decoding.
- `TextEncoder.encode('caffè')` passed. Emoji encoding returned `[237,160,189,237,186,164]`, a six-byte CESU-8 sequence instead of UTF-8 `[240,159,154,164]`.
- Encoding a runtime-generated lone high surrogate returned `[237,160,128]` instead of replacement-character bytes `[239,191,189]`.
- `encodeInto('🚤', new Uint8Array(3))` returned `{read:2,written:3}` and wrote half the surrogate-pair encoding. Correct UTF-8 cannot fit the scalar into that destination: both counts should be zero and the destination should remain zeroed.
- Decoding the valid four-byte emoji sequence produced code units `[2010,256]`, not `[55357,56996]`. Decoding byte `FF` produced code unit 61440 rather than replacement character 65533.
- `new Response('🚤')` emitted raw bytes `ed a0 bd ed ba a4`; a strict UTF-8 client rejected them.

These are distinct layers. Fixing ingress alone does not fix TextEncoder, JSON or the response writer. The raw text ingress and native codecs are visibly byte-oriented or handle only one-, two- and three-byte sequences. Their tests need scalar values, surrogate pairs, replacement semantics and destination-boundary cases.

Sproutboat's local Unicode changes cover ingress, JSON serialization/parsing, TextEncoder and native response encoding, with independent native vectors already validated. TextDecoder's separate limitations remain outside that patch. Do not describe Sproutboat as having fixed every Unicode API.

## JSON correctness and exception behavior

An escaped BMP key (`caff\u00e8`) passed. These valid or invalid JSON cases expose other boundaries:

| Probe                                             | Expected                               | Observed                                                         |
| ------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------- |
| Parse `{"id":"\ud83d\udea4"}`                     | A string with two surrogate code units | Uncaught SyntaxError: Expected string key; native server exits 1 |
| Stringify an object with key `a"b`                | `{"a\"b":1}`                           | `{"a"b":1}`, invalid JSON                                        |
| Stringify a runtime-generated lone high surrogate | An escaped `"\ud800"` string           | Bytes `22 00 22`, a quoted literal NUL                           |
| Parse `{"x":1} garbage`                           | Reject trailing non-whitespace         | Accepts the input                                                |

The serialization probes return the raw stringified body, avoiding a second JSON serialization hiding which layer failed. Surrogates are generated at runtime with `String.fromCharCode(55296)` so UTF-8 source-file encoding cannot replace the test input before it runs.

The synchronous query-access and static `Response.json` probes also exited with uncaught TypeError and process status 1. Their root cause begins with missing API surface; process termination is the observed error behavior. Valid escaped JSON triggering an uncaught SyntaxError is a parser defect. Those categories should remain separate.

The JSON source uses byte-oriented output storage in these snapshots. Escaping of object keys, well-formed surrogate serialization and rejection of trailing data require their own tests. Broad claims about all JSON parsing, crash causes below the parser, or memory safety are not established here.

## Async helpers and promise adoption

The following control paths passed in three fresh processes at each version:

- An async handler returning a Response directly.
- An async handler explicitly awaiting an inner async helper before returning its Response.
- Catching an exception from an explicitly awaited rejecting helper.

Returning the inner helper's promise without await timed out after two seconds in every repetition. Returning a rejecting helper's promise also timed out. Subsequent health checks still succeeded, so this was an unresolved response rather than a server-wide stall.

The single-route reduction uses this shape, with a separate health route for readiness:

```js
async function inner() {
  return new Response("ok");
}
export default {
  port: 18082,
  async fetch(request) {
    if (new URL(request.url).pathname === "/health") return new Response("ok");
    return inner();
  },
};
```

The standalone reduction confirmed the same result at both commits in three fresh processes each: all six plain-return requests timed out, and all six explicit-await controls succeeded. Its artifacts are retained in `results/porffor-promises-minimal-1790515769058/`. Changing the last line to `return await inner()` is the explicit-await control. Standard JavaScript async functions should adopt the returned promise in both forms.

This also sharpens the previous fixture interpretation. The missing-signature path did not need crypto to fail: it returned through nested async functions. The direct missing-crypto probe returned a recoverable HTTP 500, while the previous nested signed route timed out. A direct outbound-call probe returned the router's fallback body `missing`; it did not perform the expected upstream call. There is no supported client fetch implementation in the declared native host surface. The exact lowering responsible for that unexpected fallback was not bisected.

The promise built-in source already contains a promise-adoption branch. It would be premature to claim that the algorithm is simply absent. The failure is established at the native handler boundary; locating the precise compiler/event-loop fault needs further instrumentation. It is also distinct from the older prototype-walk livelock investigation, which described a server-wide CPU wedge.

## Silent language and library incompatibilities

A Proxy with a getter trap returned the target's original value 1, with zero trap calls, instead of value 2 and one call. This matches the documented stub. It is a particularly difficult migration failure because no exception announces the incorrect behavior.

`Uint8Array.from({0:7,1:8,length:2})` produced `[]` instead of `[7,8]`. The surrounding `Array.from` conversion works in the BMP encoder control, so that empty result is not just an unsupported output conversion.

`Date.parse('2026-09-01T12:00:00+02:00')` returned 1788264120000 instead of 1788256800000. We verified this one offset case, not every Date parser branch. Sproutboat already has a localized date-parser patch and array-like TypedArray.from patch.

A mutable closure returned `[5,6]` correctly in both versions. This is useful positive evidence: it would be inaccurate to turn these failures into a claim that closures, all async functions, or ordinary JavaScript cannot work.

We did not rerun the complete test262 suite or entire framework stacks, Zod, Better Auth, arbitrary imports, decorators, dynamic code generation, filesystem APIs, or Atomics. Historical package failures should not be presented as newly verified against current upstream.

## What this means for Sproutboat

Sproutboat supplies host capabilities and compatibility patches around Porffor; it does not replace the language engine. The earlier shared application passed 23/23 checks with the unreleased local runtime/toolchain, including signed Unicode orders and upstream traffic. That is stronger than a successful build, but it does not prove every probe in this matrix works under Sproutboat.

| Boundary                                            | Existing downstream handling                                        | Remaining claim limit                                                                       |
| --------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| HTTP status fallback                                | Compiler integration supplies a numeric fallback                    | Plain upstream still failed the tested unlisted codes                                       |
| Request decoding, JSON, TextEncoder, response UTF-8 | Local runtime/toolchain fixes with native regression vectors        | TextDecoder is not covered by those changes                                                 |
| Query helpers and static Response.json              | Runtime supplies compatibility helpers                              | A subset of the full Web API contract                                                       |
| Crypto and outbound HTTP                            | Runtime/transport provides supported operations                     | Not complete Web Crypto or streaming Fetch semantics                                        |
| Proxy traps                                         | Sproutboat rejects Proxy use instead of silently accepting the stub | General Proxy behavior is not supplied                                                      |
| Array-like typed arrays and date offsets            | Local compiler patches                                              | No broad ECMAScript conformance guarantee                                                   |
| Nested async return pattern                         | Full-app fixtures work in the wrapped integration                   | This exact reduced matrix has not been run through Sproutboat; do not claim a universal fix |

For remediation, prioritize valid HTTP status output, JSON correctness and UTF-8 semantics, then native promise settlement and exception containment. Those failures affect routine application behavior. Treat missing host APIs as explicit capability requirements. Treat Proxy as an engine limitation that requires either correct interception support or a clear build rejection.

For website material, show a named app, its capabilities, exact compiler/runtime versions, correctness results, and resource measurements only for validated workloads. The small plain-Porffor footprint is real for the measured success path. Calling unsupported routes slow, publishing a 45-probe support percentage, or claiming Sproutboat fixes every engine limitation would be misleading.

## Artifacts and reproduction

The durable sources live in `sproutboat-cli/examples/runtime-comparison/limitations/`: `cases.ts`, `prepare.ts`, `run.py`, `oracle.ts`, `report.py` and the single-route reducer. The final raw matrix is retained locally under `results/porffor-limitations-1790515345641/`. The preceding sequential prototype is retained for audit, but the analysis uses the fresh-process repetitions.

Each native process was capped at CPUQuota=100%, MemoryMax=512M and CPU affinity 0. The generator and fixed loopback upstream used CPU 1 on the shared two-CPU Linux host. This is a correctness investigation, not a load or maximum-capacity result. Fatal cases logged ordinary uncaught exceptions with process status 1; they are not attributed to OOM. Existing services remained running.

Independent Bun reference checks passed all 36 selected synchronous semantic cases. The decoded Request facade intentionally does not test the asynchronous standard body-method contract. Required repository verification passed 102 CLI tests, 28 broker conformance checks, 30 standalone conformance checks and all 12 examples. No upstream issues were filed and no website claims were published.

## Complete targeted matrix

Each cell reports correct responses from three independently started native processes. The 45 selected probes emphasize known web-app boundaries. These counts are not an overall JavaScript compatibility score.

| Probe                | Group                     | Pinned commit | Current upstream | First observed output/error                                                                                                                                        |
| -------------------- | ------------------------- | ------------: | ---------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| status-200           | HTTP status serialization |           3/3 |              3/3 | `"ok"`                                                                                                                                                             |
| status-201           | HTTP status serialization |           3/3 |              3/3 | `"ok"`                                                                                                                                                             |
| status-400           | HTTP status serialization |           3/3 |              3/3 | `"ok"`                                                                                                                                                             |
| status-401           | HTTP status serialization |           3/3 |              3/3 | `"ok"`                                                                                                                                                             |
| status-404           | HTTP status serialization |           3/3 |              3/3 | `"ok"`                                                                                                                                                             |
| status-405           | HTTP status serialization |           3/3 |              3/3 | `"ok"`                                                                                                                                                             |
| status-413           | HTTP status serialization |           3/3 |              3/3 | `"ok"`                                                                                                                                                             |
| status-418           | HTTP status serialization |           0/3 |              0/3 | `"HTTP/1.1 \r\n"`                                                                                                                                                  |
| status-422           | HTTP status serialization |           0/3 |              0/3 | `"HTTP/1.1 \r\n"`                                                                                                                                                  |
| status-425           | HTTP status serialization |           0/3 |              0/3 | `"HTTP/1.1 \r\n"`                                                                                                                                                  |
| status-429           | HTTP status serialization |           3/3 |              3/3 | `"ok"`                                                                                                                                                             |
| status-500           | HTTP status serialization |           3/3 |              3/3 | `"ok"`                                                                                                                                                             |
| status-501           | HTTP status serialization |           3/3 |              3/3 | `"ok"`                                                                                                                                                             |
| status-502           | HTTP status serialization |           3/3 |              3/3 | `"ok"`                                                                                                                                                             |
| status-503           | HTTP status serialization |           3/3 |              3/3 | `"ok"`                                                                                                                                                             |
| status-507           | HTTP status serialization |           0/3 |              0/3 | `"HTTP/1.1 \r\n"`                                                                                                                                                  |
| host-capabilities    | Host API surface          |           0/3 |              0/3 | `{"urlSearchParams": "undefined", "cryptoSubtle": "undefined", "clientFetch": "undefined", "responseJson": "undefined", "readableStream": "undefined", "abortC...` |
| url-query            | URL                       |           0/3 |              0/3 | `"Remote end closed connection without response"`                                                                                                                  |
| response-json        | Response                  |           0/3 |              0/3 | `"Remote end closed connection without response"`                                                                                                                  |
| request-text         | Ingress UTF-8             |           0/3 |              0/3 | `{"length": 11, "codes": [99, 97, 102, 102, 195, 168, 45, 240, 159, 154, 164]}`                                                                                    |
| request-json         | Ingress UTF-8             |           0/3 |              0/3 | `{"length": 11, "codes": [99, 97, 102, 102, 195, 168, 45, 240, 159, 154, 164]}`                                                                                    |
| body-shape           | Request streaming         |           0/3 |              0/3 | `{"bodyType": "string", "getReader": "undefined", "textThen": "undefined"}`                                                                                        |
| encoder-bmp          | TextEncoder               |           3/3 |              3/3 | `[99, 97, 102, 102, 195, 168]`                                                                                                                                     |
| encoder-astral       | TextEncoder               |           0/3 |              0/3 | `[237, 160, 189, 237, 186, 164]`                                                                                                                                   |
| encoder-lone         | TextEncoder               |           0/3 |              0/3 | `[237, 160, 128]`                                                                                                                                                  |
| encodeinto-short     | TextEncoder               |           0/3 |              0/3 | `{"read": 2, "written": 3, "bytes": [237, 160, 189]}`                                                                                                              |
| decoder-astral       | TextDecoder               |           0/3 |              0/3 | `{"length": 2, "codes": [2010, 256]}`                                                                                                                              |
| decoder-malformed    | TextDecoder               |           0/3 |              0/3 | `{"length": 1, "code": 61440}`                                                                                                                                     |
| json-unicode         | JSON                      |           0/3 |              0/3 | `"Remote end closed connection without response"`                                                                                                                  |
| json-key             | JSON                      |           3/3 |              3/3 | `42`                                                                                                                                                               |
| json-quoted-key      | JSON                      |           0/3 |              0/3 | `"{\"a\"b\":1}"`                                                                                                                                                   |
| json-lone            | JSON                      |           0/3 |              0/3 | `"\"\u0000\""`                                                                                                                                                     |
| json-trailing        | JSON                      |           0/3 |              0/3 | `false`                                                                                                                                                            |
| proxy-traps          | Language semantics        |           0/3 |              0/3 | `{"value": 1, "calls": 0}`                                                                                                                                         |
| typedarray-arraylike | Language semantics        |           0/3 |              0/3 | `[]`                                                                                                                                                               |
| closure              | Language semantics        |           3/3 |              3/3 | `[5, 6]`                                                                                                                                                           |
| date-offset          | Language semantics        |           0/3 |              0/3 | `1788264120000`                                                                                                                                                    |
| response-astral      | Response UTF-8            |           0/3 |              0/3 | `"'utf-8' codec can't decode byte 0xed in position 0: invalid continuation byte"`                                                                                  |
| async-direct         | Promise settlement        |           3/3 |              3/3 | `"ok"`                                                                                                                                                             |
| async-return-inner   | Promise settlement        |           0/3 |              0/3 | `"timed out"`                                                                                                                                                      |
| async-await-inner    | Promise settlement        |           3/3 |              3/3 | `"ok"`                                                                                                                                                             |
| async-throw-inner    | Promise settlement        |           0/3 |              0/3 | `"timed out"`                                                                                                                                                      |
| async-catch-await    | Promise settlement        |           3/3 |              3/3 | `"caught"`                                                                                                                                                         |
| async-crypto         | Web Crypto                |           0/3 |              0/3 | `"native fetch promise rejected"`                                                                                                                                  |
| async-fetch          | Outbound HTTP             |           0/3 |              0/3 | `"missing"`                                                                                                                                                        |

All four binaries compiled successfully. Each version passed the same 18 probes and failed the same 27 selected probes in all three independent repetitions. Source hashes, expected outputs, process exit status, health recovery, compiler archive/binary identities and raw response hex are retained in results.json. Host-capabilities includes process only as a Node-host contrast; its absence is not a Workers compatibility bug.

The host was Linux x86_64 with existing services. Each native process used CPU affinity 0, CPUQuota=100%, MemoryMax=512M; the generator and a fixed loopback upstream used CPU 1. Each probe had a two-second deadline. This matrix measures semantic behavior, not throughput or startup performance.

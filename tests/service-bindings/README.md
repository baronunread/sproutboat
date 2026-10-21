# Service-binding conformance and reliability suite

One caller and one callee, bound to each other, run unchanged on workerd and on the
platform. The caller runs each case against `env.PEER` and reports what it observed;
`compare.ts` matches the two runs case by case. The driver times the reliability checks
from outside.

| File                     | What it is                                                                  |
| ------------------------ | --------------------------------------------------------------------------- |
| `caller/`, `callee/`     | The two apps (`sproutboat.jsonc` declares the bindings)                     |
| `workerd.capnp`          | The same two apps on workerd, for the reference                             |
| `driver.ts`              | Runs every case and reliability check against a running caller, writes JSON |
| `platform.ts`            | Starts a local edge with both built apps, runs the driver, stops the edge   |
| `compare.ts`             | Scores a platform run against `reference-workerd.json`                      |
| `reference-workerd.json` | The reference run, workerd 2026-09-27                                       |

## Run it

```sh
(cd tests/service-bindings/callee && sproutboat build --target host)
(cd tests/service-bindings/caller && sproutboat build --target host)
bun tests/service-bindings/platform.ts /tmp/svc-platform.json
bun tests/service-bindings/compare.ts tests/service-bindings/reference-workerd.json /tmp/svc-platform.json
```

The whole run takes about three minutes; the recursion and never-answering checks
each wait up to 60 seconds.

To refresh the reference, run `workerd serve workerd.capnp` from this directory, then
`bun driver.ts http://127.0.0.1:18431 reference-workerd.json`.

## Reliability checks

| Check                  | Passes when                                                                   |
| ---------------------- | ----------------------------------------------------------------------------- |
| `responsiveDuringCall` | `/ping` answers in under 500 ms while another request waits 3 s on the callee |
| `concurrent8x500ms`    | Eight 500 ms calls at once all succeed in under 1.5 s                         |
| `selfRecursion`        | 50 levels of the caller calling itself through `SELF` complete                |
| `mutualRecursion`      | caller → callee → caller completes                                            |
| `calleeNeverAnswers`   | A callee that never answers either waits like workerd or fails with a 5xx     |

## Score, 2026-10-21 (CLI 0.19.0, runtime 0.19.2)

Cases 6/22, reliability 0/5.

| Gap                                                                                                               | Cases                              |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| The callee sees `http://<deployment host>/…` instead of the URL the caller passed                                 | every echo case                    |
| `fetch()` returns a `Response`, not a promise, and blocks the caller's event loop                                 | `promise`, all reliability checks  |
| A `URL` object as input fails (`SyntaxError`)                                                                     | `urlObject`                        |
| `fetch(request, init)` drops the request's body                                                                   | `requestPlusInit`                  |
| A `ReadableStream` request body is sent as the text `[object ReadableStream]`                                     | `postStream`                       |
| Responses over 10 MiB fail with 502                                                                               | `bigResponse`                      |
| Repeated `Set-Cookie` headers collapse to the last one                                                            | `cookies`                          |
| Redirects are not followed by default                                                                             | `redirectDefault`                  |
| A callee that throws gives the caller a 500 response, not an exception                                            | `calleeThrows`                     |
| Responses gain `content-type` where workerd sends none, and `x-sb-raw-body` / `x-sb-remote-addr` leak to the apps | `redirectManual`, `streamResponse` |

Reliability, in detail:

- A call blocks the caller's whole sprout. `/ping` waited 2.7 s behind a 3 s call,
  and eight concurrent 500 ms calls took 4.1 s. The same eight requests sent straight
  to the callee took 517 ms, so the serialization comes from the binding alone.
- Self and mutual recursion deadlock: the blocked sprout cannot answer the call back
  to itself. Each level waits out the edge's 30 s request timeout, and the queued
  levels kept the caller unavailable for more than five minutes after the test.
- The edge sets no `idleTimeout`, so Bun closes any response slower than 10 s with an
  empty reply. Clients never see the edge's own 30 s `request timed out` 504.

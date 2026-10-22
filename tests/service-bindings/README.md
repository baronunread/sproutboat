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

### Score a local packages branch

To see what a `sproutboat-packages` branch changes before it is released, run the
edge on that branch's `wire` and `runtime` with `tools/with-local-packages.ts`, from
a worktree of this repo (it refuses a main checkout with uncommitted changes):

```sh
bun tools/with-local-packages.ts ../sproutboat-packages -- \
  bun tests/service-bindings/platform.ts /tmp/svc-branch.json
bun tests/service-bindings/compare.ts tests/service-bindings/reference-workerd.json /tmp/svc-branch.json
```

That covers the edge and the broker. The two apps are compiled by the CLI, which
has its own `@sproutboat/*` dependencies: when the branch changes the runtime or
the toolchain, build `caller/` and `callee/` with a CLI checkout whose packages
point at the same branch, or the sprouts still carry the released runtime.

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

## Progress

The apps use compatibility date `2026-10-23`, so they measure the newest behaviour. The callee
is a `WorkerEntrypoint`, so a caller can also call its methods over RPC. The suite gained
cases as the work reached them (streaming at 24, RPC at 30, Request fidelity at 53), so
earlier rows count fewer.

| Change                                                                        | Cases | Reliability |
| ----------------------------------------------------------------------------- | ----- | ----------- |
| 0.19.2 (first score, below)                                                   | 6/22  | 0/5         |
| + async calls (sproutboat-packages#126)                                       | 8/22  | 4/5         |
| + redirects, no invented content type (sproutboat-packages#127)               | 10/22 | 4/5         |
| + edge vouches for calls: caller's URL, rethrown errors (#295, packages#130)  | 21/22 | 4/5         |
| + streamed responses (sproutboat-packages#131)                                | 22/24 | 4/5         |
| + edge timeout and disconnects (#294), 512 MiB response limit (#296)          | 23/24 | 5/5         |
| + Workers RPC, atob/btoa fix (sproutboat-packages#132)                        | 29/30 | 5/5         |
| Request fidelity cases added (runtime 0.22.0, date 2026-10-22)                | 36/53 | 5/5         |
| + `fetch(Request)`, `new Request(request, init)` as in workerd (packages#143) | 52/53 | 5/5         |

One case still differs from workerd: `streamRequestBody`. The native server reads a whole
request body before the handler runs, so a callee cannot see a streamed upload in parts.

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

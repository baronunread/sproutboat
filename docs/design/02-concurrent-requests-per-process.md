# Design 02: Concurrent requests per process

Status: proposal. Research only; nothing here was built or benchmarked.
Sources: sproutd `wt-sproutd-perreq` (6c9e9e5), packages `wt-pkgs-reqcost` (9d03b10, `packages/runtime/src/`, shortened to `rt/` below), Porffor `wt-sproutd-perreq/out/porffor-upstream/compiler/`.

## Summary

The premise "a process handles one request at a time" is half stale. sproutd already sends up to 8 requests to one worker and the worker already interleaves them while they wait on timers or `fetch()` (B18). What still serialises is anything that holds the one JS thread: CPU work, and every D1/KV/R2/DO binding call, which is a synchronous call in the loop. The p99 ceiling is therefore "one handler's synchronous time", not "one request". There is also no `AsyncLocalStorage`, and several pieces of per-request state are process-global, so interleaving is correct today only by luck of simple apps.

Recommendation: do not add threads or isolates. Harden and certify the existing single-thread interleaving (context, ALS, CPU accounting, GC), make bindings yield on the broker transport, and keep embedded SQLite synchronous but bounded.

## Current state

How workerd does it (Cloudflare docs, fetched 2026-10-28): "a single Workers instance may handle multiple requests including concurrent requests in a single-threaded event loop" (how-workers-works); 128 MB per isolate, shared by all its requests; "up to six connections simultaneously waiting for response headers" per invocation, a seventh queues (platform/limits); `AsyncLocalStorage` supported minus `enterWith()`/`disable()`, with `snapshot()` and `bind()`; `nodejs_compat` is on by default from 2026-08-04. I did not read workerd's IoContext source; I rely on the docs only.

sproutd (frontend):
- Up to `MAX_INFLIGHT=8` requests per worker, replies in any order, by id: `src/native-host.cpp:1166-1171`, dispatch loop `:1459-1464`. Queue cap 32 requests / 8 MiB: `:1680`. The comment at `:49` ("one in-flight call per app ... measure before adding multiplexing") is stale.
- Per-request wall deadline, but the CPU budget is per process: `cpu_of(pid)-progress_cpu > spec.cpu` (`:1526`), and `progress_cpu` resets only when nothing is in flight (`:1462`). Under overlap, one spinner kills its neighbours (concurrency-smoke checks "spinner killed, neighbour keeps serving", `test/concurrency-smoke.py` header).
- Blue/green swap waits for `inflight.empty()` (`:1320`, `:1660`).

Worker bridge and shim:
- `dispatch()` calls the handler, drains microtasks, and if the promise is pending attaches a reaction and returns (`src/native-host-bridge.c:293-313`). Each request has its own `Pending` with GC roots (`:53`). So the bridge is not a one-at-a-time lock.
- `body_current` is a single static slot for the streamed request body handed to the next `dispatch` (`:129`, `:138`, `:296`): correct only because frames are processed in order.
- Every reply runs a full `porf_native_fetch_collect_normal_from` (`:104`), even while others are in flight; `quiet()` collects only when `!inflight` (`:319`).
- Standalone shim (`uwebsockets.js:673-860`) also keeps a `PendingResponse` per request and collects after each. Standalone without an async host leaves `fetch()` synchronous (`rt/transport-embedded.js` `sb_async_enabled`, `__sbHttpAsyncEnabled`).
- Porffor: `await` compiles to a coroutine `Await` (`compiler/codegen.js:3975-3979`); top-level await drains jobs synchronously. GC is conservative over the C stack with a native root table over one linear heap (`compiler/render.js:2061-2071`). A single jobs queue is drained by `porf_native_fetch_drain_microtasks` (`render.js:2077`).

Prelude (`rt/native-fetch-prelude.js`):
- The CPU stamp uses process CPU time and says so: "One fetch turn per process (serial) ... ponytail: serial-turn assumption" (`:9395-9398`, `__sbCpuMs` `:3095`). With overlap, `x-sb-cpu-ms` counts neighbours' work.
- Compat date and env are process globals set once (`:3-18`), fine (per app, not per request). `__sbReqId` is a global counter (`:5154`), fine. Per-request lists (`__sbTasks`, `ctx`) are locals (`:9400-9404`), fine.
- ALS: `rg AsyncLocalStorage|async_hooks` over runtime, toolchain and Porffor `compiler/` found nothing. I did not test whether `node:async_hooks` imports fail at build or at run time.
- Durable Object input gate exists from 2026-10-28 (`:7321-7370`), per object, via `setTimeout` hold. It is the only existing per-context scheduling primitive.

Compat dates and blocking:
- D1 strict shape from 2026-10-24 (`:5293`), KV promises from 2026-10-25 (`:5169`), R2 2026-10-26 (`:5632`), fetch promises 2026-10-22 (`:6820`). Embedded transport: `fetch` is async at every date (`__sbAsyncAtAnyDate` true, `rt/transport-embedded.js:4188`).
- The date changes the return shape, not the blocking. D1 strict wraps a synchronous core in `Promise.resolve` (`:5405-5410`, core `:5326-5337`, `__sbCallDirect` into in-process SQLite). So on sproutd every binding call blocks the loop at every date; `busy_timeout=5000` (`rt/transport-embedded.js:1244`) can stall it up to 5 s if another copy holds the WAL write lock.
- Broker transport: binding ops go through `__sbRpc` -> `__sbCall` (`:5141-5146`), a blocking exchange; only `fetch`/upstream is async, and only from 2026-10-22 (`rt/transport-broker.js:1055`).
- I found no single "D1/KV compat date" that gates blocking; the 10-24/10-25 dates gate API shape only.

## Design

Keep one thread, one heap, cooperative interleaving at `await`. Make it correct and measurable.

1. Request context. Introduce `__sbCtx` (request id, `ctx`, tasks, CPU timer, deadline) created in `__sbEntry` and carried through every continuation by an AsyncContext-style "current frame" variable saved/restored on each promise job, timer fire and I/O callback. Porffor's job queue is the one place that needs a hook: capture `current` when a reaction is created, set it around its run. Cost is one pointer per reaction; confirm it in a Porffor patch (`patch.ts`) before committing.
2. AsyncLocalStorage. Build `node:async_hooks` `AsyncLocalStorage` (`run`, `getStore`, `exit`, `bind`, `snapshot`; no `enterWith`, matching Workers) on that same current-frame mechanism. Ship behind a new compat date.
3. I/O ownership. Every outbound handle (async fetch job, outbound WebSocket, stream, body id) records its owning request id; abort or deadline on a request cancels its handles. Replace the `body_current` slot with an explicit id in the dispatch frame.
4. Scheduling. FIFO per worker, up to N in flight (N=8 now; make it a per-app limit). A request running synchronous JS is not preemptible; the CPU budget kills the process. Change the budget to per-request CPU measured only across that request's slices (accumulate `CLOCK_THREAD_CPUTIME_ID` deltas in the frame switch), so `x-sb-cpu-ms` and kill decisions stop blaming neighbours. Until then, keep process-wide CPU as the safety net.
5. Bindings policy. (a) Broker transport: add async variants of `__sbRpc` over the existing async exchange so D1/KV/R2 yield; the sync shape stays for pre-date apps by blocking (they were written for sync results anyway). (b) Embedded SQLite: stays synchronous at all dates. Add a per-statement time cap (SQLite progress handler) and lower the effective `busy_timeout` to something near the request deadline slice; document that a slow query delays co-resident requests. Pre-compat-date apps already serialise; no behaviour change. Optional later: run SQLite on a helper thread like the egress threads (`ASYNC-IO.md`), which would make it yield; thread count is bounded by `pids.max`.
6. GC. Do not run a full collect per reply while others are in flight; collect on heap-growth or when `inflight` drops to 0, with a cap on interval. Conservative stack scan plus native roots already keeps pending requests alive (`Pending.roots`). Extra memory per in-flight request is not measured; expect request/response objects plus any retained closures plus the 8-thread stack only while fetching.
7. Isolation of faults. A synchronous throw already becomes a 500 (`:9418-9420`). An unhandled rejection kills only that request (`docs/bindings.md:146`). Keep that.

Staged rollout: (1) correctness without behaviour change: per-request CPU, `body_current` fix, GC policy, tests; (2) context frame and ALS behind a compat date; (3) async broker bindings; (4) optional SQLite helper thread, decided on measurements.

## Alternatives considered

- More processes per app (fork K copies): simplest, true parallelism, no ALS needed. Cost: ~1.5 MiB per process times K, which breaks 1,000 apps in 1536M if applied broadly; per-app state (SQLite WAL, DO instances, WebSockets, sticky storage; `patch.ts` comments assume "one worker per app") needs routing. Reasonable only as an opt-in for hot apps.
- Worker thread pool in one process: Porffor has one linear heap and global runtime state; threads would need per-thread heaps. Large, unproven.
- Queueing in sproutd only (current behaviour, bounded 32): cheap, but a slow handler still blocks the fast one when the slow one is CPU- or binding-bound.
- Do nothing: fine for I/O-bound apps, which already interleave.

## Risks

- Cross-request leakage through process-global state not yet inventoried (`body_current`, the `Request._cd` static in `__sbSetCompat`, module-level caches in apps themselves). Apps written for workerd assume this works and test nothing for it.
- Hangs from Porffor promise adoption (documented earlier failure: returned inner promise never settled, `docs/porffor-limitations-analysis.md:62-89`; measured on an older Porffor, current status unverified). Interleaving multiplies exposure.
- GC pauses grow with heap and apply to all in-flight requests; conservative scan may retain data (coin-flip gates noted in memory).
- Per-request CPU accounting by slices adds a syscall per switch; unmeasured.
- A Porffor patch on the job queue must survive upgrades (`PORFFOR-UPGRADE.md`).

## Effort

Roughly 4 to 6 engineer-weeks, one engineer with Porffor knowledge. M1 (1 wk): inventory of globals, interleaving and leakage tests, CPU slicing, GC policy. M2 (1.5 wk): context frame and ALS with tests. M3 (1.5 wk): async broker bindings. M4 (1 wk): SQLite cap, optional helper thread decision. Qualification passes (requal tiers) add calendar time, not engineering time.

## How to measure success

- Interleaving tests (extend `test/concurrency-smoke.py`): N handlers with staggered timers and fetches must each see their own request, headers and ALS store at every await; deterministic orderings of reply and fire.
- Slow+fast p99: one app, a handler that does 200 ms of D1/CPU work plus a fast `/ping`; report `/ping` p50/p99 with 0, 1 and 8 slow requests in flight, before and after. Success criterion: I/O-bound slow handler leaves fast p99 within 2x of idle; CPU-bound case documented, not promised.
- Cross-request leakage: random-id requests writing to `globalThis`, ALS, `ctx.waitUntil`, headers and cookies, with response and log checked for another request's id; run under GC stress.
- Memory per in-flight request: hold K in {1,2,4,8} sleeping handlers on one worker; measure anon RSS delta (not file cache; page-cache artifacts misled twice before) and slope per request. Gate against the 1,000-app 1536M budget.
- CPU accounting: a spinner next to a fast neighbour; neighbour's `x-sb-cpu-ms` and success unaffected.
- Regression: existing requal tier suites, unhandled-rejection, stream, ws smokes.

## Open questions for the user (product decisions, ranked)

1. Is the target "I/O-bound apps interleave well" (mostly shipped) or "CPU-bound handlers must not hurt neighbours" (needs opt-in extra processes or threads and costs memory)?
2. Should `AsyncLocalStorage` ship as a new compat date, or at every date since it was previously absent?
3. For embedded D1/KV, is a documented "binding calls block neighbours, capped at X ms" acceptable, or should SQLite run off-thread (extra threads per app, more memory)?
4. What default per-app in-flight limit, and should it be configurable per app or per plan?
5. Opt-in "N processes for this app" for hot apps: wanted as a paid or advanced feature, given storage and DO affinity restrictions?

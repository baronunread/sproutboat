# Node, workerd, and Sproutboat: benchmark specification

Status: proposed tests, no new comparative measurements. Prepared 2026-09-27.

## Question

What does the same small HTTP application cost to ship and run on one Linux
server, and how does it behave as traffic grows? Measure memory, startup,
latency, useful throughput, and build costs independently. Do not collapse
them into an overall score or assume Sproutboat will win.

The intended application class is small APIs, webhook validators, and buffered
HTTP responses. This is not a comparison of all-purpose runtimes, Cloudflare's
global network, or feature-equivalent hosting products.

## What we inspected

- Platform checkout: `80357bc`; CLI: `ea81f77`; packages: `304a563`.
- `sproutboat-docs/docs/concepts/{handler,compatibility,architecture}.mdx` and
  `docs/platform/limits.mdx`: compiled handlers, partial Web APIs, synchronous
  bindings, one executing request per process, no streams or WebSockets.
- `services/supervisor/src/run.ts`: managed deployments may have a separate
  Bun broker. Its memory and CPU belong in deployed-app measurements.
- `sproutboat-cli/examples/stress/{bench.ts,BASELINE.md}`: existing standalone
  regression benchmark, not a measured Node/workerd comparison.
- `standalone-app/BENCHMARK.md`: useful prior experiment, but the PocketBase
  mockup has fewer features than PocketBase and is not our comparison fixture.
- `sproutboat-site/AGENTS.md`: published numbers must come from the CLI stress
  baseline and flow through `web/src/data/bindings.ts`.

The local workstation is macOS arm64; workerd is not on PATH. Use it for
fixture development, not headline Linux capacity or memory results. Pin the
actual installed package versions and artifact hashes in each run: checkout
revisions alone do not establish which runtime code a build uses.

## Comparison tracks

| Track          | Node                                                           | workerd                                                                 | Sproutboat                                            | Meaning                                                               |
| -------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------- |
| A: direct app  | `node:http`, one process                                       | `workerd serve`, one worker                                             | standalone native binary                              | App serving and footprint, without a hosting platform                 |
| B: public app  | Caddy to Node                                                  | Caddy to workerd                                                        | Caddy to edge to sandboxed sprout and optional broker | Concrete self-hosted deployments, including their different overheads |
| C: app density | Separate processes; shared routing process as a second variant | Separate processes; multiple workers in one process as a second variant | Managed deployments, with and without brokers         | Total server cost for many distinct apps                              |

Never put A and B in the same ranking. Track B measures these configurations,
not a universal runtime difference. Shared workerd workers are an important
deployment option; a process-per-app test alone would conceal that advantage.
Also show Node's shared-process option, labelled as sharing an event loop and
process failure domain. These are trusted benchmark apps; no security-equivalence
claim follows from the density experiment.

## Application fixtures

Keep one deterministic business-logic module and fixed request corpus. Thin
adapters handle the different request/body/env contracts. Native Node APIs
may be used for hosting; do not force Node through a third-party Workers shim.
Avoid framework overhead in the primary comparison. Framework-specific tests
can follow, with exact package versions and tested operations stated.

| ID  | Concrete work per request                                                                                        | Inputs                                                              | What it tests                                              |
| --- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------- |
| H0  | Return fixed `ok` response                                                                                       | GET, two-byte body                                                  | HTTP floor; diagnostic, not the headline                   |
| H1  | Validate and transform an order webhook: required fields, integer bounds, sum line items, emit fixed JSON fields | Valid and invalid fixtures; about 1 KiB and 16 KiB; ASCII and UTF-8 | Representative small API work                              |
| H2  | Verify HMAC-SHA256 over raw body, then run H1                                                                    | Same fixtures, valid/invalid signatures, fixed test key             | Authenticated webhook using native crypto in every runtime |
| H3  | Route on pathname/query, construct fixed HTML from request values with identical escaping                        | About 8 KiB response; pinned request corpus                         | Small dynamic page, without a framework                    |
| H4  | Fetch deterministic upstream, fully buffer and transform its response                                            | 4 KiB response; controlled delays of 0, 10, 50, 200 ms              | Waiting on I/O and head-of-line blocking                   |
| H5  | Return identical buffered bytes generated during initialization                                                  | 4 KiB, 64 KiB, 512 KiB                                              | Response buffering, throughput, memory                     |

H1 invalid traffic is a separate run with a fixed 10% invalid mix, not part of
valid-request throughput. An expected validation rejection counts as correct
work; a timeout or incorrect response does not. H2 runs are separate valid and
invalid signature cases. Use test secrets only.

H4 uses normal asynchronous fetch on Node/workerd and the documented
Sproutboat fetch path. Equivalent results do not require equivalent internal
concurrency. Run pure H4 traffic, then a mixed run with 90% H1 and 10% delayed
H4; report H1 latency separately. Do not artificially serialize competitors.
The upstream lives on separate reserved resources, has ample concurrency,
and logs observed delay and response counts. Run both standalone and broker
paths where available; never label one as the other.

If a fixture cannot compile or returns different results on Sproutboat, record
the failure and omit its performance ranking until fixed. Do not silently
weaken the workload for just one runtime.

## Measurable experiments

| Experiment              | Procedure                                                                                                                      | Report                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Correctness gate        | Execute full corpus on all three, including malformed JSON, UTF-8, missing fields, wrong signatures, and upstream errors       | Status, selected headers, exact bytes or explicitly canonicalized JSON; failed cases                          |
| Shipping footprint      | Build pinned fixture; inventory deployable files                                                                               | App payload bytes; required runtime/shared files separately; total installed bytes; compressed transfer bytes |
| Build turnaround        | Ten clean-project builds and ten incremental builds with dependencies already installed; fresh toolchain installation separate | Median and range, CPU time, peak memory; identify cache state                                                 |
| Initialized idle memory | Start app, verify a real response, idle for 60 seconds; sample at 100 ms intervals                                             | Process RSS/PSS and total cgroup memory, idle CPU; all children included                                      |
| Active memory           | Run H1/H2/H4/H5 at fixed load, then idle for 60 seconds                                                                        | Settled and peak memory, CPU seconds per 1,000 correct responses, post-load memory                            |
| Process startup         | New process to first fully received correct HTTP response; 100 repetitions with warm filesystem cache                          | p50/p95, min/max, failures; runtime initialization included                                                   |
| First boot              | Dedicated fresh host/VM boot and first app request, at least ten repetitions                                                   | Separate boot/startup result with exact cache assumptions                                                     |
| Managed activation      | HTTP request to an evicted managed app, verified absent before each run                                                        | Client-observed first-response latency; broker/sandbox included; startup breakdown secondary                  |
| Warm service            | H0-H5, low load and saturation sweep                                                                                           | p50/p95/p99, correct responses/s, offered load, errors, timeouts, CPU, memory                                 |
| Scale                   | One and four app-serving processes under equal one-core and four-core budgets                                                  | Useful throughput and latency; actual routing/replication config                                              |
| Density                 | 1, 10, 50, 100 distinct apps, initialized and resident; 1 req/s/app, then 10 req/s/app                                         | Total server memory/CPU, latency, failures; maximum passing count at fixed budget                             |
| Soak                    | H1 for 30 minutes at 60% of measured sustainable load, then 60 seconds idle                                                    | Time series, memory growth, latency drift, errors, restarts                                                   |

Do not compare a Sproutboat executable to only a Node JS entry file or only a
workerd worker bundle. Conversely, do not charge a whole shared runtime to
every app. Report base installation and incremental app cost separately.

No inference that a first exec has a cold page cache without controlling or
measuring that condition. Existing startup scripts probe socket acceptance;
the new comparison must verify the first response, fail on startup timeout,
and retain failed trials. Use monotonic clocks for durations. Managed
activation is not equivalent to a warm workerd isolate request.

Density counts distinct routed apps, not concurrent requests to one app. Keep
HTTP-only sprouts resident by choosing an explicit idle window longer than
the test and verify live process counts. Broker-backed density is a separate
variant using one small KV read per request. That variant is a platform cost
measurement, not a binding-speed ranking against unrelated storage engines.

## Load and fairness protocol

1. Dedicated native Linux x86-64 target, initially 4 vCPUs and 8 GiB RAM.
   Record CPU model, kernel, virtualization, disk, governor, limits and network.
   Reserve resources for routing and measurement. Run only one candidate at a
   time. Use a separate load-generator host and verify it is not saturated.
2. Pin Node release, workerd release and compatibility date/flags, CLI,
   Porffor, Zig, native compiler, platform and package versions. Use release
   builds and normal optimizations. No profilers in headline runs.
3. Equal app-serving CPU/memory budgets: primary one core and 512 MiB,
   secondary four cores and 2 GiB. Record CPU throttling and OOM events.
   Deployment comparisons also report the unrestricted total overhead of
   Caddy, edge, supervisors and brokers on reserved resources.
4. Direct track uses HTTP/1.1 keep-alive, no compression, matching body limits,
   no response caches, redirects or per-request logging. Public track uses the
   same Caddy/TLS policy. Keep observability settings equivalent where possible
   and document unavoidable differences. Use stable upstream connections and
   record HTTP-client pooling settings.
5. Run a closed concurrency sweep at 1, 2, 4, 8, 16, 32, 64 clients as a
   diagnostic. For the headline capacity result, use an open arrival-rate
   generator: scheduling must not slow down when the server slows down.
6. Discover the saturation region, then test common offered rates around it.
   Each cell gets 30 seconds warmup and 120 seconds measurement, five repeated
   trials in randomized, recorded order. Repeat finalists on a second host or
   day. Record the seed. If measurements remain unstable, investigate or
   increase duration before publishing.
7. Define sustainable capacity before running: highest tested arrival rate
   where every repeated trial has p99 <= 50 ms for H1-H3/H5, >= 99.9% correct
   responses, no OOM or restart, and no generator shortfall. H4 uses a separate
   budget of configured upstream delay + 50 ms. Report the tested step size;
   this is a bound, not an exact maximum. Include a fixed-rate comparison all
   candidates can sustain so latency is not compared at unequal workloads.
8. Verify response status/body during load. Precomputed expected values make
   this cheap. Include scheduled-but-unissued requests, transport errors,
   incorrect responses and timeouts in accounting, not only successful
   latency samples. Use a fixed five-second request deadline and report
   unfinished work at test end. Overload results are part of the report.
9. Retain per-trial histograms and resource time series. Show median and range
   of trial results; never average p99s into a claimed pooled p99. Do not
   treat millions of requests in one run as independent experiment repeats.

Memory figures use Linux PSS for summed process attribution and cgroup totals
for operational footprint, with anonymous memory and file cache shown
separately. Shared pages make summed RSS misleading in density tests.

## Storage extension, after the core comparison

Raw workerd does not automatically make Sproutboat's embedded SQLite/KV/R2
implementations equivalent to hosted Cloudflare bindings. Keep storage out of
the first headline.

For a portable storage test, place one pinned HTTP storage service on reserved
resources. All apps use the same service, dataset, payloads, operations and
durability policy. Test a key lookup and a write with verification across
restart. Report end-to-end app-plus-service cost. This measures storage-backed
application paths, including Sproutboat's outbound mechanism.

A separate native-binding case study can use SQLite CRUD with equal schema,
indices, transactions, journal/synchronous settings, seeded rows and pagination.
Specify an actually supported workerd storage adapter first. Label it a
comparison of those integrations; do not compare unsynced local writes to
durable remote writes or call it a universal D1 result.

## Reproducible output

Add a dedicated comparison directory in the CLI repo rather than expanding
the existing single-runtime script into an opaque mixed benchmark:

```text
examples/runtime-comparison/
  fixtures/                 common logic, corpus, expected outputs
  adapters/{node,workerd,sproutboat}/
  upstream/                 deterministic delayed responses
  load/                     correctness and open-rate scenarios
  run.ts                    build, launch, sample, load, stop, report
  methodology.md
  results/<run-id>/          manifest, trials, histograms, resource samples
```

Each result manifest records versions, source/artifact hashes, exact commands,
hardware, topology, limits, cache state, fixture, offered load, deadlines,
correct/incorrect/error counts, percentiles, resource attribution and trial
order. Reports must be generated from raw results. Failed or unsupported runs
get explicit statuses, not zero scores or missing bars.

## Execution order and website deliverables

1. Implement adapters and corpus; prove H1-H3/H5 behavior on all three.
2. Linux pilot: startup, shipping size, idle/loaded footprint and H1 latency
   versus arrival rate. Tune only the harness, then freeze the protocol.
3. Full repeated H0-H5 suite, mixed delayed-upstream test and soak.
4. Managed overhead, process scaling and density. Include brokers and shared
   runtime variants before making a many-apps claim.
5. Generate the comparative summary into the CLI stress baseline, with links
   to methodology and raw results; consume verified figures through the
   site's existing central data module. Update its schema for provenance.

Useful website presentations:

- **Same webhook, three implementations:** correct responses/s within the
  stated p99 budget, plus total active memory at the same offered load.
- **What a small app costs:** base installation, incremental payload, idle
  memory and first correct response time, each with scope and cache labels.
- **Many small apps on one server:** total memory versus distinct resident app
  count, including shared workerd/Node configurations and broker variants.
- **Where the current profile fits:** H1 latency under mixed upstream waits,
  alongside the no-streaming/no-WebSocket limitation.

These are candidate stories, not predetermined claims. Publish results where
Sproutboat loses, trial variation, errors and unsupported operations. Every
chart needs runtime versions, workload, hardware, topology, date and a raw
data link. No price-per-request headline until a dated, explicit deployment
cost model exists. No production-readiness or sandbox-strength conclusion
from performance results.

## Primary external references

- [workerd repository](https://github.com/cloudflare/workerd): self-hosted
  runtime, worker composition, compatibility dates and deployment scope.
- [Node HTTP API](https://nodejs.org/api/http.html): native server adapter.
- [k6 open and closed models](https://grafana.com/docs/k6/latest/using-k6/scenarios/concepts/open-vs-closed/):
  why arrival rate must be independent of response time for overload tests.

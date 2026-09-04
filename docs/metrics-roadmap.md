# Metrics roadmap

Target: the Cloudflare Workers **Analytics / Observability** tab, adapted to a
single-server Porffor platform. Umbrella issue: **#36**.

## Shipped

One JSON object per request on `SPROUTBOAT_LOG_PATH`, aggregated by
`aggregateLogs()` over the bounded 1 MiB tail scan (no new storage):

| Field / metric                                                                                                                            | Where                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `method`, `status`, `durationMs`                                                                                                          | edge log record                                             |
| `ttfbMs` — edge → first upstream byte                                                                                                     | edge log record                                             |
| `reqBytes` / `resBytes` — body bytes from Content-Length                                                                                  | edge log record                                             |
| `coldStart` — request had to spawn the sprout                                                                                             | supervisor `endpoint()` → edge                              |
| `startupMs` — spawn → listening wait, per cold start                                                                                      | `WorkerServer.startupMs`                                    |
| `errorKind` — `no-route` / `sprout-unavailable` / `proxy` / `upstream-5xx`                                                                | edge                                                        |
| Request + 5xx time series (24 buckets)                                                                                                    | `Metrics.buckets`                                           |
| Status-class + method distribution                                                                                                        | `Metrics.statusDistribution` / `methodDistribution`         |
| Latency / TTFB / **startup** p50·p90·p99                                                                                                  | `Metrics.latencyMs` / `ttfbMs` / `startupMs`                |
| Cold-start count + per-bucket cold starts                                                                                                 | `Metrics.coldStarts`, `buckets[].coldStarts`                |
| Bytes in / out totals                                                                                                                     | `Metrics.bytesIn` / `bytesOut`                              |
| Invocation-status distribution (`ok` / `timed-out` / `response-too-large` / `sprout-unavailable` / `proxy` / `upstream-5xx` / `no-route`) | `Metrics.invocationStatus` — the observable side of #25/#29 |

Dashboard: `apps/web/src/traffic-charts.tsx` renders request bars, status codes,
methods, latency, TTFB, cold starts + startup percentiles, and transfer.

## Deferred — tracked as issues

| #   | Item                                                             | Note                                                                                                                               |
| --- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| #28 | Per-invocation CPU time                                          | needs the sprout to report its own CPU (ABI hook)                                                                                  |
| #29 | Invocation-status breakdown                                      | `timed-out` / `response-too-large` **shipped**; `exceeded-cpu` / `exceeded-memory` still blocked on per-sprout cgroup limits (#25) |
| #30 | Runtime-lifecycle gauges (RSS, live count, restarts, OOM, ports) | supervisor stats surface, not the request log                                                                                      |
| #31 | Full request duration (body end, not just TTFB)                  | streamed body — needs a `TransformStream` flush hook                                                                               |
| #32 | Rollup store beyond the 1 MiB tail window                        | SQLite `metrics_rollup` + a 1-minute folder                                                                                        |
| #33 | Cloudflare-style metric cards (Δ vs previous period, sparkline)  | front-end only; data is ready                                                                                                      |
| #34 | Edge response cache + cache-hit-rate metric                      | feature first, metric second                                                                                                       |
| #35 | Local build timing + binary-size trend                           | the local analog of "build minutes"                                                                                                |

## Not applicable

- **Subrequests** — a `http-sync-v0` handler has no outbound `fetch`; hard
  capability boundary, not "yet". Tied to #17.
- **Requests by colo / region** — single server. The analog is "requests by
  node", which only exists if sproutboat-cloud#1 happens.

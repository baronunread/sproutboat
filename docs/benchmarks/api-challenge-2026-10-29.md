# The $12 API challenge app on workerd, sproutd and a standalone binary, 2026-10-29

One app (`sb-12dollar/src/index.js`: D1 `.raw()` reads, HS256 JWT through `crypto.subtle`, hand-built JSON), one 250 MB seed
(500,000 posts, about 2 M likes), the same pinned core, three runtimes. Raw outputs are in
`api-challenge-2026-10-29/raw/`, the harness in `api-challenge-2026-10-29/scripts/` (the two worker files and `agg.ts` carry a `.txt` suffix so the repo linter skips them; strip it to run them).

## Setup

Server as the transient unit `bench12` (`AllowedCPUs=1`, `MemoryMax=1536M`, `MemorySwapMax=0`), fresh copy of the seed per run
on `/tmp`. Open-loop load generator (`GOMAXPROCS=1`) on the other core. CPU is the unit's cgroup `user_usec + system_usec`,
so it includes every process of the target (node and workerd, or the sproutd daemon, fork server and worker). Every session
held both othello locks with bench12 idle.

| Target | What serves it |
| --- | --- |
| **standalone** | `sproutboat` CLI 0.42.0 (newest published), `build --standalone`, linux-x86_64 |
| **sproutd** | `native-host serve` of the promoted generation 8154c609 (runtime 0.35.0, toolchain 0.20.0; sproutd main 892fdbe), the app compiled with `compile-app.ts` from the same 0.42.0 build (admitted, ABI 8154c609). A bench instance in the bench12 unit: sproutd's own HTTP front end (the part that receives HTTP) and the per-app worker with `cgroup on`, Landlock and seccomp. Not behind Caddy or the edge, no per-app uid (needs CAP_SETUID), `limits feed memory-mb 1024` instead of the 32 MiB default |
| **workerd (miniflare D1)** | workerd 1.20260927.1 (`tools/workerd`), compat date 2026-09-27, run through Miniflare 4.20260730.0 (what `wrangler dev --local` runs) under node 26.5.1. D1 is workerd's D1 client binding over Miniflare's D1 Durable Object (SQLite storage), seed file placed at the DO's path. The app is unchanged except that `env` comes from the `fetch(request, env)` argument |
| **workerd-bare** | The same, with the socket pointed at the user worker instead of Miniflare's entry worker (one line in `serializeConfig`, `MF_BARE_SOCKET`). Removes about 0.5 ms per request of entry-worker hop |
| **workerd-do** | Not D1: the app's two calls (`prepare().bind().raw()` / `.run().meta.changes`) go to a SQLite-backed Durable Object over RPC doing `sql.exec`. The leanest SQLite setup I could build on workerd; app code is otherwise unchanged. Still local disk, no network |

There is no stock workerd D1. Miniflare's shim does three extra queries per statement (`total_changes()` twice, database size
twice), a Zod parse and a JSON hop, which is where most of the workerd-D1 cost goes. Real Cloudflare D1 is a remote service
whose server-side cost is not charged to the worker, so none of the workerd rows say what Workers cost in production.

Bytes: `verify.sh` (feed plus nine post ids plus a 404) gives identical bodies and status codes on all five
(`body+status` md5 e3782ab264d0). Headers differ only in case and order (workerd `Content-Type`), and sproutd omits the reason
phrase (`HTTP/1.1 200`).

## Results

CPU µs per request (user+sys, whole unit), median of 3 interleaved trials, 12 s each, fresh unit and seed per cell, 0 errors.
feed, post and create at 250 req/s; like at 100 req/s on 32 connections (at 100 req/s on 512 connections workerd resets
idle keep-alive connections and 43% of requests fail, which would taint the number).

| | standalone | sproutd | workerd (D1) | workerd-bare | workerd-do |
| --- | ---: | ---: | ---: | ---: | ---: |
| GET /feed | 649 | 1,269 | 3,439 | 2,987 | 1,677 |
| GET /posts/:id | 469 | 710 | 3,157 | 2,891 | 1,506 |
| POST /posts/:id/like | 775 | 1,009 | 5,574 | 5,027 | 2,248 |
| POST /posts | 768 | 882 | 3,622 | 2,882 | 1,759 |

workerd-do ran in sessions interleaved with a standalone control, which read 617 / 438 / 658 / 594 there (5 to 15% under the
standalone column), so compare workerd-do with the control, not across sessions. Rate matters: the mix at 3,300 req/s costs
about 235 µs per request on standalone, so these are low-rate figures for the fast targets.

Mix (the challenge's 1 feed : 1 post : 0.15 like : 0.02 create), 30 s per run, two runs per rate. Bar: p95 < 500 ms, p99 < 1 s,
errors < 1%, achieved at least 99% of offered.

| | highest rate held in both runs | first rate with a miss | CPU µs/req at the held rate | notes |
| --- | ---: | ---: | ---: | --- |
| standalone | 4,600 | 5,000 (p95 1.3 to 2.5 s) | 210 | 3,300 to 4,600 all held, both runs |
| sproutd | 1,600 | 1,200 and 1,800 (one run each) | 510 | misses are 503 "app queue full" (errors 1.4% at 1,200 run 1, 4.9% at 1,800 run 1); 2,400 req/s: 13% errors |
| workerd (D1) | 350 | 400 (p95 1.8 to 2.9 s) | 2,750 | 250 had one miss (2.4% reset connections) |
| workerd-bare | 450 | 500 (p95 430 to 450 ms, p99 550 to 760 ms) | 2,170 | |
| workerd-do | 1,000 (1,200 held in both runs too, 1,100 missed once) | 1,600 | 790 to 910 | |

Memory and start. RSS summed over the unit's processes (PSS in brackets), after start; cold start is unit start to the first
`/health` 200 (includes node and Miniflare for workerd); medians of 5.

| | standalone | sproutd | workerd (D1) | workerd-bare | workerd-do |
| --- | ---: | ---: | ---: | ---: | ---: |
| idle RSS MiB (PSS) | 7 (7) | 21 (10) | 191 (185) | 191 (185) | 186 (181) |
| after mix at 2,000 req/s, MiB (PSS) | 11 (11) | 24 (13) | 1,089 (1,084), backlog | 927 (921), backlog | 450 (444), backlog |
| cold start to /health, ms | 139 | 185 | 1,566 | 1,450 | 1,609 |
| first / second GET /feed, ms | 2.1 / 1.1 | 1.9 / 1.1 | 6.1 / 6.7 | 4.8 / 5.5 | 3.2 / 3.4 |
| idle CPU | 0 | 1 ms/s | 0 | 0 | 0 |

The workerd 2,000 req/s figures are queue growth under overload (achieved 356 to 1,091 req/s), not a working set.

## Analysis

**Where workerd wins.** Nothing in this app's CPU, throughput, memory or start numbers, and that is the setup's doing as much
as workerd's: local D1 on workerd is Miniflare's shim, 2 to 5 ms per request, and even the lean Durable Object variant costs
1.5 to 2.2 ms. Production D1 would not charge that CPU to the worker, and I did not measure it. What workerd keeps is no
queue cap (it queues instead of failing) and no 503s: on workerd every miss is latency, on sproutd it is errors.

**Where we win.** Standalone is 4.7 to 7.2 times cheaper than workerd-with-D1 and 2.3 to 3.2 times cheaper than the lean
workerd-do on every endpoint, holds 4,600 req/s against 350 (13x) and 1,000 (4.6x), idles at 7 MiB against 190, and starts in
0.14 s against 1.5 s. sproutd is 2.7 to 5.5 times cheaper than workerd-with-D1 and 1.3 to 2.2 times cheaper than workerd-do per
request, holds 1,600 against 350 and 1,000 (workerd-do ties it on the bar, 1,000 to 1,200, with a different failure mode), at
10 to 13 MiB PSS.

**Biggest single gap on our side.** sproutd, not standalone: it holds 1,600 req/s where the same app holds 4,600 standalone,
and the misses are errors, not latency. Two causes, both measured. (1) Cost: sproutd is 1.9x standalone on `/feed` (1,269 against
649 µs) and 1.5x on post, so the core saturates at about 2,000 req/s. (2) Its per-app queue is 32 requests deep
(`queue.size()+inflight.size() >= 32` in `native-host.cpp`, answered with 503 "app queue full"); 512 open-loop connections
overflow it in bursts well below CPU saturation (a side sampler at 2,400 req/s saw 11% 503s). `/feed` is the worst endpoint
(20 rows of D1 row building and JSON). The queue cap is a product decision, not a bug I would change here; I did not test a
larger one.

## Caveats

- One host, one run window (about 5 h, with other agents' work interleaved between sessions, locks honoured). The standalone
  control moved 5 to 15% between sessions.
- Held-rate "two runs per rate" is the harness's noise floor: sproutd missed 1,200 once and held 1,800 once, workerd-do missed
  1,100 once while holding 1,200 twice. The table reports the highest rate that held in both runs.
- workerd rows use Miniflare's persistence, a DO SQLite file of the same seed. The 100 req/s workerd runs on 512 connections
  were discarded for the connection resets noted above.
- sproutd was not tested behind Caddy or the production edge, and without per-app uids.
- The 0.42.0 standalone binary and the sproutd module come from the same 0.42.0 generated source.

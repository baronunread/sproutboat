# Alpha-16 performance check

Porffor alpha-15 versus alpha-16, October 10, 2026, on the local macOS arm64 host using the same standalone app and final CLI build path. Both kitchen-sink conformance runs passed. The harness ran five alternating builds per pin and 30,000 GET requests per throughput sample at concurrency 8. Results are medians, with [raw console samples](porffor-alpha16-performance.txt) and [summary JSON](porffor-alpha16-performance.json).

| Metric                     |     Alpha-15 |     Alpha-16 | Change |
| -------------------------- | -----------: | -----------: | -----: |
| App binary                 |      2.56 MB |      2.57 MB |  +0.6% |
| Compile time               |       10.0 s |        9.3 s |  -7.8% |
| Cold start                 |     187.5 ms |     200.2 ms |  +6.8% |
| GET /api/health throughput | 20,120 req/s | 21,768 req/s |  +8.2% |

All deltas are within the harness review thresholds. An earlier three-sample run with only 3,000 requests flagged throughput; the longer rerun did not reproduce that regression. The raw results show substantial host timing variation, including the first baseline sample. These measurements establish no clear performance regression on this fixture and do not establish a production speedup. The stable result is the 0.6% binary-size increase.

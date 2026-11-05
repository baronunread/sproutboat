# Edge behaviour inventory (Bun edge, for the Rust rewrite)

Subject: `services/edge/src/{main,websocket,cache,activation,asset-cache-control,asset-rules,idle-timeout}.ts` plus
`services/supervisor/src/run.ts` (the pool the edge embeds), `@sproutboat/assets` (the helpers the edge calls), and the
control-plane code that writes `routes.json` and reads the request log.

Evidence tags: **[V]** verified by running the Bun edge (Bun 1.4.4 on macOS arm64; production pins Bun 1.4.0 in
`install.sh`, so Bun-specific details can differ slightly on the box). **[S]** read from source only.
Probe harness lived in `/tmp/edge-probe` (fake sprouts via `Bun.serve`/raw TCP, raw-socket clients, `curl`);
it is not part of the repo.

## Inventory summary

1. One Bun process is edge + supervisor: it routes by `Host` from `routes.json`, serves static assets itself, runs a tiny GET cache, and spawns/owns every sprout (+ broker) via the in-process `SproutPool`. A Rust edge must port or delegate the pool, not just the proxy (section 7.4, 11).
2. Request order: `/__sb/pool` (any host, no log) -> Host lookup (404 "unknown deployment" / apex 302) -> assets (redirect, 304, 200) -> GET cache -> pool.endpoint -> WebSocket relay or fetch proxy.
3. The request log is one JSON object per line, `at` first and `path` last, undefined fields omitted; it is what control builds logs, `tail` and every metric from. Several paths deliberately do not log (pool, apex 302, 413, hung-up clients, mid-stream failures).
4. `routes.json` is an array validated all-or-nothing; reload = mtime poll (strictly newer only), per-request stat (250 ms throttle), SIGHUP. Bad file at runtime keeps old routes; bad file at boot or on SIGHUP crashes the process (exit 1).
5. Timed bindings (`bindings.json` with queues/crons/do) pin a sprout resident: reconciled at boot and every swap, two wakes at a time, exponential backoff.
6. The cache is per-process: anonymous GETs only, `public` + max-age/s-maxage required, no Vary/Set-Cookie/Age, statuses 200/203/301/404/410, 500 entries / 64 MiB / 512 KiB per entry, FIFO eviction, purged per host on route change.
7. The proxy forwards headers verbatim minus four `x-sb-*` internals, drops `x-sb-uncaught` (except for vouched binding calls), re-renders `x-sb-cpu-ms` with 3 decimals, adds `sb-cache` for GET, and enforces a 30 s deadline (which also cuts streaming bodies) and a 512 MiB response cap.
8. Bun-isms that leak into behaviour: HTML dev error page (50 KB, with cwd) on handler exceptions (malformed `%`, missing Host, missing asset file), `Date` missing on HEAD, auto-decompression with stale `Content-Encoding`, Range on asset GETs, 413 at the server layer, coarse idle timeouts.
9. Deploy surface: `sproutboat-edge.service` (`ExecStart=bun services/edge/src/main.ts`, `ExecReload=kill -HUP`), Caddy `reverse_proxy 127.0.0.1:8080`, installer rsyncs source (no build step for the edge); a Rust binary needs a build/ship path plus a pinned bun path for brokers (`process.execPath`).
10. Tests that pin the surface: startup line regex `listening on http://IP:PORT`, `PORT=0`, `/__sb/pool` JSON, unit/installer strings (`tests/contracts.test.ts`), the activation spool files, and the log field set read by `apps/control/src/logs.ts` and `tail.ts`.

---

## 1. Configuration and environment

### 1.1 Edge process

| Variable                         | Default                                                     | Parsing / notes                                                                                                                                                                                                                  | Tag |
| -------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| `PORT`                           | `8080`                                                      | `Number(process.env.PORT \|\| 8080)`. `""` -> 8080. `0` -> ephemeral. Non-numeric (`abc`) or >65535: crash at boot, exit 1 (`RangeError: options.port`). Port taken: `error: Failed to start server. Is port N in use?`, exit 1. | V   |
| `SPROUTBOAT_BIND_HOST`           | `127.0.0.1`                                                 | Passed as `hostname` to `Bun.serve`. Printed in the startup line.                                                                                                                                                                | V   |
| `SPROUTBOAT_ROUTE_SNAPSHOT`      | `routes.json` (resolved against cwd)                        | Unit sets `/var/lib/sproutboat/routes.json`.                                                                                                                                                                                     | S   |
| `SPROUTBOAT_LOG_PATH`            | unset = no request log                                      | Empty string = no log, no file created. Parent dir created recursively (`mkdir -p`); on failure (`EROFS` etc.) logs `request log init failed: <msg>` and keeps running without a log. File opened once, append, `flags: "a"`.    | V   |
| `SPROUTBOAT_REQUEST_TIMEOUT_MS`  | `30000`                                                     | `Number(x) \|\| 30000`: `0`, `""`, NaN all fall back (V for `abc`). The code accepts negative/fractional values unchecked.                                                                                                       | V/S |
| `SPROUTBOAT_TRANSFER_TIMEOUT_MS` | `600000`                                                    | Same parsing. Deadline for direct-transfer requests only.                                                                                                                                                                        | S   |
| `SPROUTBOAT_RESPONSE_MAX_BYTES`  | `536870912` (512 MiB)                                       | `Number(x) \|\| default`. Unit sets the same value.                                                                                                                                                                              | S   |
| `SPROUTBOAT_EDGE_MAX_BODY_BYTES` | `5368709120` (5 GiB)                                        | Used only if safe integer > 0, else default. Enforced by Bun's server before the handler.                                                                                                                                        | V   |
| `SPROUTBOAT_EDGE_CACHE`          | on                                                          | Only the exact string `off` disables (then every GET is `sb-cache: BYPASS`, cacheStatus `bypass`).                                                                                                                               | S   |
| `SPROUTBOAT_DEPLOYMENT_DOMAIN`   | `sproutboat.local`                                          | Lowercased. A request whose Host equals it and has no route -> 302.                                                                                                                                                              | V   |
| `SPROUTBOAT_DASHBOARD_URL`       | `https://dashboard.<domain>`                                | One trailing `/` stripped, then `Response.redirect` re-normalises (bare origins gain a `/`): `Location: https://dashboard.sb.test/`.                                                                                             | V   |
| `SPROUTBOAT_ACTIVATION_DIR`      | unset = no activation polling                               | See section 10.                                                                                                                                                                                                                  | V   |
| `SPROUTBOAT_EDGE_URL`            | set by the edge if unset: `http://127.0.0.1:<actual port>/` | `                                                                                                                                                                                                                                |     | =` after the listener is up, before any sprout spawns. Brokers use it for service-binding calls. Always 127.0.0.1 regardless of bind host. | S   |
| `NODE_ENV`                       | not set by the unit                                         | Bun's `development` mode stays on, which is why handler exceptions render the HTML dev error page (section 12).                                                                                                                  | V   |

Not configurable (hard-coded): route stat throttle 250 ms; route poll 1 s; evict timer 60 s; activation poll 100 ms; keep-alive touch 30 s; WS connect timeout 10 s; WS max payload 32 MiB; WS client idle 120 s; cache 500 entries / 64 MiB / 512 KiB; transfer deadline slack +1 s; pool idle window 600 s; sprout ready timeout 10 s; pool port range 40000-49999. [S]

Idle timeout of Bun connections: `min(255, ceil(requestTimeoutMs/1000) + 5)` seconds (35 s by default). With `REQUEST_TIMEOUT_MS=1000` (setting 6 s) Bun closed an idle connection after about 12 s, so Bun's granularity is coarse (about 4 s ticks, up to 2x). [V]

### 1.2 Env consumed by the embedded supervisor (same process, inherited by brokers)

| Variable                                                                                          | Default                                                        | Use                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SPROUTBOAT_BROKER_STATE_DIR`                                                                     | `dirname(LOG_PATH)/brokers`, else the artifact dir             | Per-deployment broker state `<dir>/<artifact digest>/{state.sqlite,d1/}`. Unit sets `/var/lib/sproutboat/brokers`.                                                                |
| `SPROUTBOAT_RESOURCE_DIR`                                                                         | `dirname(LOG_PATH)/resources`, else `<stateBase>/../resources` | Shared KV/R2/queue/D1 resources and DO sqlite (`<doStoreId>.sqlite`).                                                                                                             |
| `SPROUTBOAT_R2_QUOTA_BYTES` / `SPROUTBOAT_R2_MIN_FREE_BYTES`                                      | 10 GiB / 5 GiB                                                 | Broker args, only when the route has an `ownerId`.                                                                                                                                |
| `SPROUTBOAT_SPROUT_SANDBOX`                                                                       | `bwrap` on Linux, `none` elsewhere                             | `bwrap` runs `infra/sandbox/sprout-sandbox.sh <sprout>`; `none` refuses on Linux unless `SPROUTBOAT_UNSAFE_NO_SANDBOX=1`. `SPROUTBOAT_SPROUT_SANDBOX_CMD` overrides the launcher. |
| `SPROUTBOAT_SPROUT_SECCOMP`, `SPROUTBOAT_SPROUT_CGROUP`(+`_MEMORY_MAX`,`_CPU_QUOTA`,`_TASKS_MAX`) | unit: seccomp bpf path, cgroup `off`                           | Read by the sandbox launcher / cgroup wrapper.                                                                                                                                    |
| `SB_EGRESS_URL`, `SB_EGRESS_TOKEN`                                                                | unit: `http://127.0.0.1:8070`, token from `egress.env`         | Not read by the edge; they ride in the environment to brokers (sprouts run `--clearenv`).                                                                                         |
| `SPROUTBOAT_DEPLOYMENT_DOMAIN`, `SPROUTBOAT_DASHBOARD_URL`                                        | from `/etc/sproutboat/sproutboat.env` (installer)              | Edge reads both.                                                                                                                                                                  |

Environment passed to children: broker gets the full edge env plus `SB_EDGE_SECRET`; sprout gets the full edge env plus `PORT`, `SB_STARTUP_FILE`, `SB_EDGE_TOKEN`, and (with bindings) `SB_BROKER_PORT`, `SB_BROKER_TOKEN`. [S]

---

## 2. Process lifecycle

### 2.1 Startup order [S unless marked]

1. Read env constants; build cache; compute dashboard URL.
2. `stat(routes)`: ENOENT -> empty route table, edge starts anyway [V: no `routes.json` is fine]. Present (even 0 bytes) -> `loadRoutes`; any throw is an uncaught top-level error: **nothing on stdout, stack on stderr, exit code 1** [V for invalid JSON, empty file, non-array, bad entry].
3. Open the log stream (section 9).
4. `Bun.serve({ port, hostname, maxRequestBodySize, idleTimeout, websocket })`.
5. `SPROUTBOAT_EDGE_URL ||= http://127.0.0.1:<port>/`.
6. `reconcileTimed(routes)` (timed sprouts start before the edge prints the startup line).
7. `console.log("Sproutboat edge router listening on http://<bindHost>:<port>")` [V exact text, one line, stdout]. Consumers parse it with `/listening on http:\/\/[\d.]+:(\d+)/` (`tests/tail.e2e.test.ts`, `tests/service-bindings/platform.ts`), so keep the text and the dotted-IPv4 host.
8. Timers: evict every 60 s; route poll every 1 s; activation poll every 100 ms (only with the env).
9. Signal handlers.

### 2.2 Signals and shutdown

| Signal                               | Behaviour                                                                                                                                                                                                                                                                                                                                                                                              | Tag                               |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| `SIGTERM`, `SIGINT` (`process.once`) | `shutdown()`: clear the three timers, `logStream.end()`, `pool.disposeAll()` (SIGKILL every sprout and broker, cancel timed wakes), `server.stop()`. Exit code **0**, within ms, with no drain: Bun answered an in-flight request 502 "sprout failed" at once (it killed the sprout) and lost its log line (stream already ended). A second SIGTERM would hit the default action (handler was `once`). | V (first part), S (second signal) |
| `SIGHUP` (`process.on`)              | stat routes; missing file -> empty map (all routes cleared, sprouts disposed) [V]; else `loadRoutes`; `swapRoutes` regardless of mtime; prints `route snapshot reloaded` to stdout on success [V]. **A parse/validation failure is an unhandled rejection and kills the process, exit 1** [V]. Only sender is `ExecReload=/bin/kill -HUP $MAINPID`; control never signals the edge [S].                | V                                 |
| crash (any reason)                   | Sprouts are not killed by the edge; one orphaned sprout survived a crash in testing (production relies on bwrap `--die-with-parent`).                                                                                                                                                                                                                                                                  | V                                 |

Exit code after a normal SIGTERM/SIGINT is 0; in a process that had earlier produced a Bun handler-exception 500 (section 12) the same signals exited with **1** [V, twice]. Treat exit code as unspecified when matching.

### 2.3 Timers

| Timer                           | Period                    | Action                                                                                                |
| ------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------- |
| evict                           | 60 s                      | `pool.evictIdle()`: dispose every sprout with `lastUsedAt` older than 600 s unless it is a timed one. |
| route refresh                   | 1 s                       | `refreshRoutes()` (mtime check); errors logged `route snapshot reload failed: <msg>`.                 |
| activation                      | 100 ms                    | `serveActivations` (re-entrancy guarded by a `busy` flag).                                            |
| ws / direct-transfer keep-alive | 30 s each                 | `pool.touch(...)` sets `lastUsedAt`.                                                                  |
| transfer deadline               | `transferTimeoutMs + 1 s` | stops the keep-alive.                                                                                 |

---

## 3. routes.json

### 3.1 Schema (what the edge reads)

Top level: a JSON array. Anything else (object, string, ...) throws `invalid route snapshot` [V]. Empty array is valid [V].

| Field           | Type / rule                                                                                                   | Result when violated                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `hostname`      | string matching `^[a-z0-9.-]+$` (lowercase only; no `_`, no port, no `*`)                                     | **Whole snapshot rejected** [V: uppercase, underscore, port, missing]                                              |
| `sproutPath`    | string starting with `/`                                                                                      | **Whole snapshot rejected** [V]; legacy `workerPath` is not read [V]                                               |
| `secretsPath`   | string starting with `/`                                                                                      | else `null` (silently)                                                                                             |
| `secretsHash`   | any string                                                                                                    | else `null`                                                                                                        |
| `services`      | object; each pair kept only if key matches `^[A-Z][A-Z0-9_]*$` and value is a string matching `^[a-z0-9.-]+$` | bad pairs dropped; no pairs left -> `null` [V: starts]                                                             |
| `ownerId`       | string, length <= 256, no NUL                                                                                 | else `r2 = null` and the edge ignores `r2ResourceIds`/`doStoreId` [V: starts]                                      |
| `r2ResourceIds` | array; entries kept if string matching `^r2_[a-f0-9]{24}$`                                                    | non-array -> `[]`                                                                                                  |
| `doStoreId`     | string matching `^do_[a-f0-9]{24}$`                                                                           | else omitted from `r2`                                                                                             |
| anything else   | ignored                                                                                                       | e.g. `junk` field accepted [V]; a `backend` field is one of these: the edge has no route kind but the supervisor's |

Duplicate hostnames: later entry wins (`Map.set`) [V starts; S for winner]. The edge does not require sorted entries. Per-route state kept: `sproutPath, secretsPath, secretsHash, services, r2:{ownerId,resourceIds,doStoreId?}|null`.

Example emitted by control (supervisor route with everything):

```json
{
  "hostname": "blog.alice.fn.example.com",
  "sproutPath": "/var/lib/sproutboat/artifacts/<64hex>/sprout",
  "ownerId": "<better-auth id|bootstrap:name>",
  "r2ResourceIds": ["r2_<24hex>"],
  "doStoreId": "do_<24hex>",
  "secretsPath": "/var/lib/sproutboat/secrets/<owner>__<project>.json",
  "secretsHash": "<16hex>",
  "services": { "BINDING": "other.alice.fn.example.com" }
}
```

### 3.2 How control writes it [S: `apps/control/src/store.ts`]

- Path `SPROUTBOAT_ROUTE_SNAPSHOT` (default `/var/lib/sproutboat/routes.json`); written to `<path>.<uuid>.tmp` (mode 0640, `JSON.stringify(routes, null, 2)` + newline) then `rename`: atomic and always a fresh mtime. The writer serialises calls.
- Rows = active deployments (generated `<project>.<user>.<domain>` hosts) UNION verified custom domains (#331: `custom_domains.verified_at IS NOT NULL`, attached to the project's active deployment, so a custom hostname shares `sproutPath` with the generated one), excluding banned owners, `ORDER BY hostname`.
- `secretsHash` = first 16 hex of sha256 of the deterministic JSON; `services` only when non-empty and resolved to same-owner active hostnames; `doStoreId` = `do_` + first 24 hex of sha256(`owner\0project`).
- Stages a candidate (#141) through `candidateRoute()` = same entry shape (section 10).

### 3.3 Reload triggers [S unless tagged]

| Trigger      | Condition                                                                                                                                                                                                                                            |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| per request  | `refreshRoutes()` at the top of every request: skipped if <250 ms since last check; then `stat`; reload only if `mtimeMs > routesMtimeMs` (strictly newer). Errors (other than ENOENT, treated as mtime 0) are caught and logged, request continues. |
| 1 s interval | same function, same throttle; independent of traffic.                                                                                                                                                                                                |
| SIGHUP       | unconditional reload (no mtime compare, no throttle).                                                                                                                                                                                                |

**Known Bun bug (intentionally fixed in the Rust edge, see `services/edge-rs/DEVIATIONS.md` 8).** The strictly-newer test misses a rewrite that lands in the same filesystem timestamp tick as the previous write (identical mtime to the nanosecond; about 4 ms on Linux): polling keeps the old routes, only SIGHUP reloads. The Rust edge also compares inode, size and ctime, and a content hash while the loaded snapshot is within 2 s of its mtime; it still ignores an older mtime and a deleted file. The same applies to the per-sprout asset manifest, which is only dropped when its route changes.

Observed [V]: the edge picks up an atomically swapped newer file; **the edge ignores a replacement file with an older mtime**; **the edge ignores deletion of the file at runtime** (old routes kept; only SIGHUP clears them); an invalid file at runtime keeps the old routes and logs `route snapshot reload failed: <msg>` on stderr again on every tick (3 lines in 2.6 s) because the mtime does not advance.

### 3.4 Swap semantics (`swapRoutes`)

Run for each hostname in the OLD map, in order, then the edge replaces the table wholesale and records the new mtime:

1. If the host is gone, or `sproutPath`, `secretsHash`, or `JSON.stringify(r2)` changed -> `pool.dispose(old.sproutPath)` (kills **every** runtime context spawned from that artifact path, including other hostnames sharing it; they cold-start on the next request), `assetManifests.delete(sproutPath)`, `cache.purgeHost(host)`. A change in `services` alone does **not** dispose (the process stays stale until the pool evicts it) [S].
2. New hostnames need nothing (lazy). Sprouts are never pre-spawned for HTTP-only routes.
3. `reconcileTimed(newRoutes)` (async; failure -> stderr `timed route reconcile failed: <msg>`).
4. Route objects are re-created on every load, so an in-flight cache fill that completes after **any** reload sees `routes.get(host) !== route` and the edge discards the fill (even for unchanged hosts). Unchanged hosts keep their existing cache entries.

Verified [V]: after swapping `app.test` to another artifact and dropping `gone.test`, `gone.test` returned 404, the new artifact served `app.test`, and pool stats showed `spawns 3, restarts 1, live 2`.

### 3.5 Timed bindings reconcile [S unless tagged]

- `hasTimedBindings(sproutPath)`: sync read of `<dirname(sproutPath)>/bindings.json`; true if any of `queues`, `crons`, `do` is a non-empty array; any read/parse error is false.
- Candidates = every route whose artifact has timed bindings.
- One entry per route `{sproutPath, secretsPath, services, r2}`; the pool dedupes by runtime key `resolve(sproutPath) \0 secretsPath \0 JSON(sorted service pairs) \0 ownerId \0 sorted resourceIds \0 doStoreId`.
- Pool `reconcileTimed` runs serially through one promise chain: removes timed keys no longer present (and disposes their server), stores the new set, calls `enableDispatch()` (SIGUSR1 to the broker) for each live timed runtime, then wakes with **two workers** (pop from the end of the list) via `endpoint()`.
- Wake failure: `timedWakeFailures++`, stderr `timed sprout <path> did not start: <msg>`, retry with delay `min(30000, 250 * 2^min(attempt-1, 7))` ms; a sprout/broker crash reschedules too. Timed runtimes are exempt from idle eviction.
- Verified [V]: at boot with no request, a route whose `bindings.json` has `crons` gave `timedConfigured 1, timedLive 1, spawns 1` within 2.5 s.

---

## 4. Request pipeline (in order)

Notation: "log" means a request-log line is written (section 9). Status/body strings are exact.

| #   | Step                                                                                                                                                   | Outcome                                                                                                                                                                                                                                                                                                                                 | Log                                                | Tag |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | --- |
| 0   | Bun server layer, before the handler: body larger than `maxRequestBodySize`                                                                            | `413 Request Entity Too Large` for Content-Length bodies, `413 Payload Too Large` for chunked bodies; no headers (no Date), no body; handler never runs (also for `/__sb/pool`). Limit is inclusive (100 allowed at limit 100).                                                                                                         | none                                               | V   |
| 1   | `started`, `reqBytes = Number(content-length) \|\| 0` (chunked requests count 0), `reqPath = new URL(url).pathname.slice(0,512)`                       |                                                                                                                                                                                                                                                                                                                                         |                                                    | V   |
| 2   | `refreshRoutes()`                                                                                                                                      | errors swallowed + stderr                                                                                                                                                                                                                                                                                                               |                                                    | V   |
| 3   | `new URL(request.url).pathname === "/__sb/pool"`                                                                                                       | `200 application/json;charset=utf-8` body `pool.stats()`; any method, any Host, any query, no auth; precedes host routing. `/__sb/pool/` (trailing slash) is not matched. Key order: `live, spawns, restarts, readyFailures, idleEvictions, portsInUse, portPoolSize, timedConfigured, timedLive, timedWakeFailures, foreignListeners`. | none                                               | V   |
| 3b  | `request.url` unparsable (HTTP/1.0 without Host, or empty `Host:`)                                                                                     | The `new URL` throws before routing -> Bun's HTML dev error page, 500, ~50 KB, contains `cwd` and source excerpts (section 12). The `!host` branch of step 5 is therefore unreachable in practice.                                                                                                                                      | none                                               | V   |
| 4   | `host = Host.split(":")[0].toLowerCase()`; `routes.get(host)`                                                                                          | Port stripped, lowercased [V]. IPv6 `[::1]:80` -> host `[` -> no route [V]. Trailing dot `app.test.` -> no route [V].                                                                                                                                                                                                                   |                                                    | V   |
| 5a  | No route and `host === deploymentDomain`                                                                                                               | `302`, `Location: <dashboardUrl>`, empty body, `Content-Length: 0`; any method; no log (also for HEAD)                                                                                                                                                                                                                                  | none                                               | V   |
| 5b  | No route otherwise                                                                                                                                     | `404`, `content-type: text/plain;charset=utf-8`, body `unknown deployment` (18 bytes)                                                                                                                                                                                                                                                   | `errorKind:"no-route"`, hostname = host            | V   |
| 7   | `directTransfer = /^\/__sb\/r2\/transfer\/[A-Z][A-Z0-9_]*\/[0-9a-f]{24}$/.test(rawPathname)`; if true `server.timeout(request, 0)` (idle timeout off). | Direct transfers skip assets, cache, WS, and the declared-size cap.                                                                                                                                                                                                                                                                     |                                                    | S   |
| 8   | GET/HEAD and not directTransfer: assets (section 5)                                                                                                    | redirect / 304 / 200                                                                                                                                                                                                                                                                                                                    | yes, `cacheStatus:"asset"`                         | V   |
| 9   | Cache lookup if `cache && !directTransfer && cacheRequestEligible` (section 6)                                                                         | hit -> response, no sprout                                                                                                                                                                                                                                                                                                              | `cacheStatus:"hit"`                                | V   |
| 10  | `pool.endpoint(sproutPath, secretsPath, services, r2)`                                                                                                 | failure -> `502`, body `sprout failed`, stderr `sprout unavailable for <host>: <msg>`                                                                                                                                                                                                                                                   | yes (section 9, `sprout-unavailable`)              | S   |
| 10b | directTransfer and `endpoint.transferUrl` missing (no `bindings.json` beside the sprout)                                                               | `503`, body `direct transfers unavailable`, text/plain                                                                                                                                                                                                                                                                                  | **none** (returned inside the try, before logging) | V   |
| 10c | directTransfer: base = `transferUrl` (`http://127.0.0.1:<port-10000>`); 30 s keep-alive `touch`; deadline timer; keep-alive stopped on abort/end       |                                                                                                                                                                                                                                                                                                                                         |                                                    | S   |
| 11  | Header preparation (section 7.3) and service-binding vouching                                                                                          |                                                                                                                                                                                                                                                                                                                                         |                                                    | S   |
| 12  | `!directTransfer && isWebSocketUpgrade` -> WebSocket relay (section 8)                                                                                 | `101` (handler returns undefined) / `502` / `400`                                                                                                                                                                                                                                                                                       | yes                                                | V   |
| 13  | `fetch(base + rawPathname + search, {method, headers, body, redirect:"manual", signal})`                                                               | proxy (section 7.1)                                                                                                                                                                                                                                                                                                                     | on body end                                        | V   |

Notes:

- Steps 8 and 9 run before the edge touches the sprout, so asset or cache hits never start a cold sprout.
- The WebSocket check is after assets: a WS upgrade GET whose path resolves to an asset gets the asset as the answer [S].
- Status/body table for edge-generated responses:

| Status | Body                                      | Content-Type               | When                                           | Logged  |
| ------ | ----------------------------------------- | -------------------------- | ---------------------------------------------- | ------- |
| 302    | empty                                     |                            | apex domain without route                      | no      |
| 404    | `unknown deployment`                      | `text/plain;charset=utf-8` | no route                                       | yes     |
| 413    | none                                      | none                       | Bun body limit                                 | no      |
| 499    | none (null body)                          |                            | client aborted before upstream headers         | yes     |
| 500    | Bun HTML dev error page                   | `text/html;charset=utf-8`  | uncaught handler exception                     | no      |
| 502    | `sprout failed`                           | text/plain                 | endpoint failure, or proxy error (non-timeout) | yes     |
| 502    | `response too large`                      | text/plain                 | declared Content-Length > cap                  | yes     |
| 502    | `the sprout did not accept the WebSocket` | text/plain                 | upstream WS refused/closed/timeout             | yes     |
| 400    | `WebSocket upgrade failed`                | text/plain                 | `server.upgrade()` returned false              | yes (S) |
| 503    | `direct transfers unavailable`            | text/plain                 | transfer without bindings                      | no      |
| 504    | `request timed out`                       | text/plain                 | deadline before upstream headers               | yes     |

---

## 5. Static assets

Only for `GET`/`HEAD` on supervisor routes that are not direct transfers.

### 5.1 Manifest [S unless tagged]

- File: `<dirname(sproutPath)>/assets.json`; files under `<dirname(sproutPath)>/assets/<key>` (key = `/path`, appended with `join`). Loaded lazily at the first request and cached in `assetManifests` by `sproutPath` **forever (null included)** until a route swap disposes it, so an `assets.json` that appears later is not seen. Parse failure -> stderr `asset manifest load failed for <sproutPath>: <msg>`, manifest cached as `null` (everything goes to the sprout). A parseable but wrong-shaped manifest (no `files`) throws on lookup -> dev 500 page.
- Shape (`@sproutboat/assets`): `{notFound: "none"|"single-page-application"|"404-page", runSproutFirst: boolean|string[], files: {"/abs/path": {hash, size, type}}, headers?: [{pattern, set:[[name,value]], unset:[name]}], redirects?: [{from,to,status}]}`. `hash` = sha256 hex of the file, `type` = full content-type string. `notFound` is not read by the edge (the broker uses it for `env.ASSETS.fetch`).

### 5.2 Algorithm

1. `pathname = decodeURIComponent(url.pathname)`. **A malformed escape (`/%E0%A4%A`) throws `URIError`, giving the dev 500 page and no log** [V]. Non-GET/HEAD requests are not decoded and pass through [V].
2. Redirect rules, in file order, first match wins, **even over an existing file** [V]: `matchRedirect(rule, pathname)`:
   - `from` containing `*`: literal prefix match up to the `*`, `:splat` in `to` replaced by the remainder (so `/blog/*` matches `/blog/` -> `/posts/` but not `/blog`) [V].
   - else segment match (empty segments dropped, `:name` captures, same segment count); `to` has `:name` replaced by captured text (no encoding).
   - Response: `status = rule.status` (not validated by the edge), `Location: <to>`, no body; GET shows `Content-Length: 0`, HEAD shows lowercase `content-length: 0` and no `Date` [V]. Query string is not carried unless the rule's `to` has it.
   - Logged (status = rule status, `resBytes:0`, `cacheStatus:"asset"`).
3. `assetKey = resolveAssetKey(pathname, has)`:
   - path ending `/` -> `<path>index.html` if present else none;
   - exact key wins;
   - if the last segment has no `.`: `<path>.html`, then `<path>/index.html`;
   - else none. Case-sensitive [V: `/INDEX.HTML` goes to the sprout]. Query ignored [V]. URL parsing normalises dot segments first, including `%2e%2e` [V].
4. The edge uses `entry` only if `!isSproutFirst(runSproutFirst, assetKey)` (evaluated on the resolved key, not the request path): `true` -> never; array -> last matching pattern wins, `!` negates; glob: `*` within a segment, `**` across, anchored [V: `/api/*` goes to the sprout].
5. No entry -> fall through to cache/sprout [V].
6. `etag = "\"" + entry.hash + "\""`. If `If-None-Match` equals `etag` **string-exactly** -> `304` with only `etag` (+ Date), no cache-control, no `_headers` rules; logged `status 304, resBytes 0`. Weak (`W/"..."`), lists and `*` do not match and yield 200 [V]. HEAD also gets the 304 [V].
7. 200: body = `Bun.file(<dir>/assets/<key>)` (streamed from disk; `null` for HEAD). Headers in this order: `content-type: entry.type`, `etag`, `content-length: entry.size`, `cache-control: cacheControlFor(key)`, then `_headers` rules (below). Bun adds `Date` (not for HEAD) [V].
   - Log is written **before** the response is built: `status 200`, `resBytes = entry.size` [V]. Consequences [V]: a manifest entry whose file is missing on disk logs 200 then returns the dev 500 page; a `Range` request returns `206` (Bun.file honours ranges: `content-range: bytes 0-3/13`, `accept-ranges: bytes`) but the log line says 200 with the full size; the edge ignores `Accept-Encoding` (never compressed).
8. `_headers` rules, `matchHeaders(headers, pathname)` filters rules in file order, then for each: delete names in `unset`, then `headers.set(name, value)` for `set` (replaces defaults, including `cache-control`, `content-type`, `content-length`). Matching: pattern and path split on `/` dropping empty segments; a pattern segment exactly `*` matches everything remaining (splat); otherwise equal-length and segment-equal. Only a whole-segment `*`; no `:name`. [V: `/*` added `X-Frame-Options`; a `/logo.png` rule replaced `cache-control` and removed `etag`.]

### 5.3 Cache-Control rule (`cacheControlFor(assetKey)`) [V via run for default and fingerprint; tests in `asset-cache-control.test.ts`]

- `isFingerprinted`: last path segment split on `[.\-_]`; any token with length >= 8 containing at least one digit and at least one ASCII letter -> `public, max-age=31536000, immutable`.
- else `public, max-age=86400`.
- Examples that must hold: `index.Ke7awTe2.css`, `index-a1b2c3d4.js`, `main.8f3a2b1c.chunk.js`, `main.a1b2c3d4.js`, `0.b2c3d4e5.js`, `entry.c3d4e5f6.js` immutable; `bricolage-grotesque-latin.woff2`, `favicon.svg`, `home.png`, `robots.txt` day-long.

---

## 6. GET cache (`cache.ts`)

Per-process, in-memory, supervisor routes only.

### 6.1 Request eligibility (`cacheRequestEligible`)

`method === "GET"`; no `Authorization`, no `Cookie`; none of `Cache-Control`, `Pragma`, `If-Match`, `If-Modified-Since`, `If-None-Match`, `If-Unmodified-Since`, `Range` (presence only). Ineligible GETs get `sb-cache: BYPASS` [V for cookie, range, authorization, if-none-match]. HEAD/POST/etc. get no `sb-cache` header and no `cacheStatus` field [V]. Direct transfers are never eligible. With the cache disabled every GET is BYPASS [S].

### 6.2 Key

`"GET " + host + " " + rawPathname + search` (host lowercased without port; path NOT decoded, NOT normalised beyond URL parsing; query part of the key, order-sensitive). `?x=1` is a distinct entry [V]; `APP.test` and `app.test` share [V].

### 6.3 Response eligibility (`cacheResponseEligible`) and fill

- `Cache-Control` must contain the token `public` (regex `(^|,)\s*public\s*(?:,|$)`, case-insensitive) [V: `max-age=5` alone is `DYNAMIC`].
- Reject if the response has `Vary`, `Set-Cookie` or `Age` [V: vary, set-cookie -> `DYNAMIC`].
- `cacheableForSeconds`: lowercased; reject `no-store`, `private`, `no-cache` (with optional `=value`); `s-maxage`, `max-age` must each appear once and be digits only (`10junk`, duplicates -> reject); `s-maxage` takes precedence; value must be > 0.
- `Date` header: parsed; unparsable or in the future -> reject; absent -> now. `expiresAt = date + seconds*1000` must be > now. The edge measures freshness from origin `Date`, not from arrival.
- Stored only if status in `{200, 203, 301, 404, 410}` and body <= 512 KiB. A 500 with public max-age is `MISS` but never stored [V]; 404 stored [V].
- Content-Length known and > 512 KiB -> the edge does not buffer it, still `MISS` [V: 600 KiB]. Unknown length: the edge retains chunks while the running total fits and drops them as soon as it does not (the real byte count is authoritative).
- The fill happens when the response stream finishes; stored only if the route is still the same object and `now < expiresAt`; TTL arg = `ceil((expiresAt-now)/1000)`; `ageAtStore = floor((now - responseDate)/1000)`.
- Stored headers: all response headers after edge rewriting, **minus `sb-cache` and `x-sb-cpu-ms`** (after `x-sb-uncaught` removal).

### 6.4 Hit

`Response(body, {status, headers: stored + age + sb-cache: HIT})` with `age = ageAtStore + floor((now - storedAt)/1000)` [V: `Age: 0` then `1`]. Stored `Date` is the origin's (stale) [V]. No sprout contact, no `x-sb-cpu-ms`. Log: `status`, `resBytes = body bytes`, `cacheStatus:"hit"`, **no** ttfbMs/coldStart/startupMs/bootMs/cpuMs [V].

### 6.5 Miss path headers

`sb-cache` value for GET: `HIT | MISS | BYPASS | DYNAMIC` upper-cased [V]; `cacheStatus` log value lower-case (`hit|miss|bypass|dynamic`, plus `asset`). `DYNAMIC` = eligible request, response not cacheable; `MISS` = cacheable policy (even if not stored, e.g. 500 or too large).

### 6.6 Store

Map keyed by string; `get` deletes an expired entry lazily (no sweeper). `set` rejects bad status/oversize, subtracts an existing entry's bytes, **re-inserting a key keeps its original Map position** (so "oldest" = first inserted), then evicts from the front while `size > 500` or `bytes > 64 MiB`. `purgeHost` splits the key on a space and compares field 1. [S, unit-tested in `cache.test.ts`]

---

## 7. Proxying

### 7.1 Supervisor sprout (step 13) [V unless tagged]

- URL: `base + url.pathname + url.search` where `url = new URL(request.url)`: the WHATWG normalisation applies: dot segments collapsed (`/a/../b/./c` -> `/b/c`), `%2e%2e` treated as `..`, `//x//y` kept, `%2F` kept, absolute-form request targets use only path+query, the edge drops the fragment. It forwards percent-encoding raw (no decode), including malformed (`/%E0%A4%A` on POST goes through).
- `method` passed through unchanged (any token, e.g. `PURGE`, `OPTIONS`); `redirect: "manual"` (3xx forwarded as-is); body = `request.body` stream for non-GET/HEAD (GET/HEAD never carry a body, even if the client sent `Content-Length: 0`, which the edge forwards as a header). Body limit is the server-layer limit above.
- Signal: `AbortSignal.any([request.signal, AbortSignal.timeout(requestTimeoutMs)])` (direct transfers: `transferTimeoutMs`). The timeout covers the **whole** body, not only headers: a trickling response was cut at the deadline with no terminal chunk and **no log line**, with a `TimeoutError` dump on stderr [V]. SSE longer than 30 s is therefore killed.
- Request headers sent: all client headers except the internal four, **Host unchanged including the port** (e.g. `app.test`, `sd.test:443`). Bun's `fetch` adds when absent: `accept: */*`, `accept-encoding: gzip, deflate, br, zstd`, `user-agent: Bun/<version>`. The edge forwards client `connection`, `te`, `upgrade-insecure-requests`, `cookie`, `x-forwarded-*`, `transfer-encoding: chunked` as sent. [V]
- Response: status verbatim; headers copied from the upstream response with:
  - `x-sb-uncaught` deleted unless the request was a vouched binding call;
  - `x-sb-cpu-ms` deleted and, if the original parsed as a finite number, re-set with `Number.toFixed(3)` (`1.23456` -> `1.235`; `abc` -> header removed, `cpuMs: null`) [V];
  - `sb-cache` added for GET (section 6);
  - everything else stays, including hop-by-hop `Connection`, response `x-sb-edge-token`, and `set-cookie` as separate lines (`x-multi: 1, 2` merged by fetch) [V].
- The edge invents no content-type when the upstream sends none (a raw sprout reply without one reaches the client without one) [V]. (The Bun-based fake sprouts add their own.)
- Declared-length guard: if `content-length` is a finite number > `responseMaxBytes` (and not a direct transfer) -> `502 response too large` before streaming [V]. The edge counts a body with no/unknown length while streaming; on exceeding the cap the edge errors the stream: client gets the bytes up to the chunk that crossed the cap (here 500 of 1000), **no terminating chunk**, stderr `response body cap (<n>B) exceeded for <host>` and a stack; the log line IS written (status = the upstream status, e.g. 200, `resBytes` = running total including the offending chunk, e.g. 600) [V].
- Upstream failures: mid-stream upstream error (short body) -> client sees headers then connection close; **no log** [V]. Upstream connection error before headers (`ECONNRESET`, process died) -> `502 sprout failed`, log `error:"sprout failure"`, `errorKind:"proxy"`, stderr `sprout failure for <host>: <msg>`; the pool then respawns on the next request (`coldStart:true`, `restarts+1`) [V].
- Timeout before headers -> `504 request timed out`, `errorKind:"timed-out"`, stderr `sprout timed out for <host>: <msg>`; classification is `error.name` in `{TimeoutError, AbortError}` [V]. Client gone before headers (`request.signal.aborted`, checked first) -> `499` null body, `errorKind:"client-closed"` [V].
- `uncaught` flag (log): `x-sb-uncaught` header present, OR (`status === 500` AND no `content-type` header AND `content-length === "21"`) -> `uncaught: true` [V both]. A 500 with a content-type and 21 bytes is not uncaught [V]; the edge strips the header from the client response (unless binding call).
- `errorKind: "upstream-5xx"` whenever upstream status >= 500, the status is still forwarded [V].
- The sprout's response body length: when the upstream length is known and the body completes in one read, Bun answered with `Content-Length`; bigger/slow bodies went out `Transfer-Encoding: chunked` [V]. Not semantically relevant, do not match byte-for-byte.

### 7.3 Header preparation and service-binding vouching (supervisor routes) [S]

```
bindingCall = verifyBindingCall(request.headers.get("x-sb-edge-secret"), host)
            // = a live scoped credential whose broker's `services` map contains `host`   (#339: sha256 lookup, per broker, revoked at broker exit)
            // `host` = the Host header, port stripped, lower case; a repeated header is joined with ", " (never matches)
forwarded   = copy of request headers minus {x-sb-edge-secret, x-sb-edge-token, x-sb-binding-call, x-sb-url}
if bindingCall && endpoint.edgeToken:
    forwarded["x-sb-binding-call"] = "1"
    forwarded["x-sb-edge-token"]   = endpoint.edgeToken      // 24 random bytes hex, per spawn, == sprout env SB_EDGE_TOKEN
    if request["x-sb-url"]: forwarded["x-sb-url"] = that value  // the caller's URL
```

- Credentials go only to brokers as `SB_EDGE_SECRET`; clients cannot learn them, so a client can never be a binding call. Stripping works [V: client-sent `x-sb-*` never reached the sprout]. Each broker gets 24 random bytes (hex) valid only for the hostnames in its own `services` map and dropped when it exits. A credential that is wrong, expired or used for another host makes the request an ordinary public one (nothing vouched, headers stripped, `x-sb-uncaught` hidden); it is not an error. [V: tools/edge-diff `binding-*` cases]
- Rust edge: the check is `POST /verify-binding-call {credential, host}` on the sidecar for every request carrying the header, uncached because a credential can be revoked.
- Binding calls travel broker -> `SPROUTBOAT_EDGE_URL` -> same listener, `Host` = target hostname (from `services`), and so pass through the entire pipeline (assets, cache, sprout).
- Response side: for a binding call `x-sb-uncaught` is kept (the caller's broker reads the callee's error), otherwise deleted.

### 7.4 The pool contract the edge depends on (what Rust must provide or call) [S]

| API                                                                                                                                         | Semantics                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `endpoint(sproutPath, secretsPath, services, r2, dispatchDisabled=false)` -> `{url, transferUrl?, coldStart, startupMs, bootMs, edgeToken}` | Key = runtime key (section 3.5). Missing/closed -> spawn: pick a port in 40000-49999 (random start, probe-bind both `0.0.0.0` and `127.0.0.1`; with `bindings.json` also needs `port>10000` and port+10000 / port-10000 bindable); `coldStart=true`; `restarts++` if the key ran before. Awaits readiness (TCP connect poll on 127.0.0.1, backoff 1->20 ms, timeout 10 s). Errors: `sprout exited before it began listening`, `sprout did not listen on :<port> within 10000ms`; a failed ready disposes the server and `readyFailures++`; an unexecutable binary logs `sprout <path> could not be executed: <msg>` and surfaces as the first error [V via activation]. `url = http://127.0.0.1:<port>`; `transferUrl = http://127.0.0.1:<port-10000>` only if `bindings.json` exists beside the sprout; `startupMs`/`bootMs` are 0 on a warm hit (the edge logs null unless cold); `bootMs` read from `.startup-<port>` in the artifact dir, clamped to `[0, startupMs]`. Concurrent callers share one ready promise. |
| `touch(...)`                                                                                                                                | `lastUsedAt = now` if live.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `dispose(sproutPath)`                                                                                                                       | kill every server whose artifact path matches, drop timed entries/wakes. SIGKILL.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `disposeAll()`                                                                                                                              | as above for all.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `evictIdle()`                                                                                                                               | idle >= 600 s and not timed -> dispose; `idleEvictions += n`. Runs every 60 s.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `reconcileTimed(list)`                                                                                                                      | section 3.5.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `stats()`                                                                                                                                   | the 10-key JSON; `portPoolSize = 10000`. [V]                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `verifyBindingCall(v, host)`                                                                                                                | section 7.3.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

Spawn recipe: with `bindings.json`, start the broker first (`<bun> --smol <@sproutboat/wire/broker entry> --port <port+10000> --transfer-port <port-10000> --token <24B hex> --db <stateDir>/state.sqlite --data-dir <stateDir>/d1 --resource-dir ... --bindings ... --sprout-url http://127.0.0.1:<port>/ [--owner-id ... --r2-resource-ids ... --secrets ... --services <json> --edge-url ... --assets-dir ... --do-db ... --dispatch-disabled]`, `SB_EDGE_SECRET` in env), wait up to 5 s for broker and transfer ports; then start the sprout through `sproutCommand` (sandbox launcher) with `PORT`, `SB_STARTUP_FILE`, `SB_EDGE_TOKEN`, `SB_BROKER_PORT`, `SB_BROKER_TOKEN`. Output of both goes to `<dirname(LOG_PATH)>/sprouts/<artifact digest>.log` (truncated per spawn; this is what `tail --sprout` reads). Either exiting kills the other. `dispose` = SIGKILL both. [S: `services/supervisor/src/run.ts`]

---

## 8. WebSocket

- `isWebSocketUpgrade`: method **GET**, `Upgrade` lower-cased equals `websocket`, `Connection` split on `,` has a trimmed token `upgrade` (case-insensitive). The edge proxies a POST with the same headers as plain HTTP and the sprout's own answer comes back [V].
- Order (supervisor): after assets and cache lookup and after `pool.endpoint` (so the cold start already happened and the edge logs its fields), edge opens its own WebSocket **to the sprout first**: URL `base` with `http`->`ws` + path + query; headers = forwarded headers minus `connection, upgrade, sec-websocket-key, sec-websocket-version, sec-websocket-extensions, sec-websocket-protocol, content-length, transfer-encoding`; protocols = the client's `Sec-WebSocket-Protocol` list; `binaryType arraybuffer`; **10 s connect timeout**. Open -> continue; error/close/timeout -> `502 the sprout did not accept the WebSocket` (log `error:"websocket refused"`, `errorKind:"websocket-refused"`). The sprout's own HTTP refusal (e.g. 403/426) is not relayed, the client sees the 502 [V].
- Then `server.upgrade(request, {data, headers: {sec-websocket-protocol: upstream.protocol} if any})`; false -> close upstream, `400 WebSocket upgrade failed` [S]. 101 headers seen [V]: `Upgrade: websocket`, `Connection: Upgrade`, `Sec-WebSocket-Accept`, `Date`. Extension negotiation not observed (not verified).
- Relay: text stays text, binary stays binary; the edge buffers messages from the sprout before the client's socket opens (`early`) and flushes them on open; it drops client -> sprout silently if the upstream is not OPEN; no backpressure handling. Close mapping: either side closing closes the other with `sendableCloseCode(code)` valid set `1000, 1001-1003, 1007-1014, 3000-4999` (anything else -> close without a code) and the reason; sprout error -> client `1011 "the sprout's WebSocket failed"`; client opens after the sprout already closed -> `1011 "the sprout's WebSocket closed"`. Observed [V]: subprotocol echoed, `4001 bye` carried, text echo.
- Limits: client socket `maxPayloadLength` 32 MiB, `idleTimeout` 120 s; keep-alive `touch` every 30 s while open.
- Logging: one line at upgrade time (`status 101`, `durationMs` = handshake only; the request that started the sprout adds `coldStart, startupMs, bootMs`); refusal line with 502/400; **nothing at close** [V]. Hung-up/closing sockets are never logged.

---

## 9. Request log

### 9.1 Mechanics [V unless tagged]

- One `JSON.stringify` per line + `\n`, written with `createWriteStream(path, {flags:"a"})` (buffered, fire-and-forget, no flush on crash; stream errors logged `request log stream error: <msg>`). No rotation or size cap exists anywhere in the repo (`rg logrotate` empty).
- Object = `{ at, ...event, path }`: **`at` is first, `path` last**, event keys in the order the code lists them; `JSON.stringify` drops `undefined` values and keeps `null`.
- `at` = `new Date().toISOString()` at the moment `log()` runs (end of the response body for proxied requests, not the start). `durationMs` = `Math.round(performance.now() - started)` at that moment.
- `path` = `new URL(request.url).pathname.slice(0, 512)`, never the query string (tokens), raw (percent-encoded as sent, dot segments already collapsed); omitted if the URL does not parse.
- `hostname` = lowercased Host without port (or `null` when the host is missing).
- Under systemd `UMask=0007` the file is 0660, dir `logs/` is `0770 sproutboat-edge:sproutboat`; control reads through the group. [S]

### 9.2 Emission by path (key order shown, `path` last on every line)

| Path                           | Fields                                                                                                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| no route (404)                 | `hostname, method, status:404, durationMs, reqBytes, errorKind:"no-route"` [V]                                                                                                             |
| asset redirect / 304 / 200     | `hostname, method, status, durationMs, reqBytes, resBytes (0 / 0 / entry.size), cacheStatus:"asset"` [V]                                                                                   |
| cache hit                      | `hostname, method:"GET", status, durationMs, reqBytes, resBytes, cacheStatus:"hit"` [V]                                                                                                    |
| endpoint failure (502)         | `hostname, method, status:502, durationMs, reqBytes, ttfbMs:null, error:"sprout unavailable", errorKind:"sprout-unavailable"` [S]                                                          |
| WS upgraded                    | `hostname, method, status:101, durationMs, reqBytes, coldStart, startupMs, bootMs` [V]                                                                                                     |
| WS refused                     | as above `status` = 502/400, plus `error:"websocket refused", errorKind:"websocket-refused"` [V]                                                                                           |
| declared too large             | `hostname, method, status:502, durationMs (= ttfbMs), ttfbMs, reqBytes, resBytes:<declared>, coldStart, startupMs, bootMs, error:"response too large", errorKind:"response-too-large"` [V] |
| normal proxied (body finished) | `hostname, method, status, durationMs, ttfbMs, reqBytes, resBytes, coldStart, startupMs, bootMs, cpuMs, errorKind?, uncaught?, cacheStatus?` [V]                                           |
| client closed before headers   | `hostname, method, status:499, durationMs, reqBytes, ttfbMs:null, coldStart, startupMs, bootMs, error:"client closed the request", errorKind:"client-closed"` [V]                          |
| proxy error / timeout          | `hostname, method, status:502                                                                                                                                                              | 504, durationMs, reqBytes, ttfbMs:null, coldStart, startupMs, bootMs, error:"sprout failure" | "request timed out", errorKind:"proxy" | "timed-out"` [V] |

Field semantics:

| Field                 | Type         | Present                                                    | Meaning                                                                                                                                                       |
| --------------------- | ------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `at`                  | ISO string   | always                                                     |                                                                                                                                                               |
| `hostname`            | string\|null | every line                                                 | lowercased Host sans port; `null` only when Host is missing (unreachable in practice)                                                                         |
| `method`              | string       | always                                                     | request method; `"GET"` literal on cache hit                                                                                                                  |
| `status`              | int          | always                                                     | as sent to the client, except assets (planned status) and cap-overflow (status was sent before the abort)                                                     |
| `durationMs`          | int          | always                                                     | full duration (end of body)                                                                                                                                   |
| `ttfbMs`              | int\|null    | proxied paths                                              | time to upstream headers (`elapsed()` after fetch resolves); `null` on failures                                                                               |
| `reqBytes`            | int          | every line                                                 | `Number(content-length)\|\|0` (chunked = 0)                                                                                                                   |
| `resBytes`            | int\|null    | success paths                                              | declared Content-Length if finite else counted bytes (HEAD reports declared length; gzip upstream reports compressed length [V]); absent on 499/502-proxy/504 |
| `coldStart`           | bool         | supervisor proxied/ws/errors after endpoint                | true when this request spawned the sprout; `false` on warm [V]                                                                                                |
| `startupMs`, `bootMs` | int\|null    | same                                                       | `null` unless cold; `bootMs` may be 0 [V]                                                                                                                     |
| `cpuMs`               | number\|null | normal proxied                                             | parsed from `x-sb-cpu-ms` (raw value, not rounded: `1.23456` [V]); `null` if absent/NaN                                                                       |
| `error`               | string       | failures                                                   | exact strings above                                                                                                                                           |
| `errorKind`           | string       | failures + any upstream >= 500 (`upstream-5xx`) + no-route | taxonomy: `no-route, sprout-unavailable, proxy, timed-out, response-too-large, upstream-5xx, client-closed, websocket-refused`                                |
| `uncaught`            | `true`       | only when true                                             | supervisor only                                                                                                                                               |
| `cacheStatus`         | string       | GET proxied (`hit                                          | miss                                                                                                                                                          | dynamic | bypass`), assets (`asset`); absent for non-GET |     |

### 9.3 Paths that do NOT log [V unless tagged]

- `/__sb/pool` (any method).
- Apex-domain 302.
- Bun 413 (body too large).
- Bun 500 dev-error page: missing/empty Host, malformed `%` on GET/HEAD for supervisor routes (asset decode), and a missing asset file (the earlier "asset 200" line _was_ written, see 5.2).
- 503 `direct transfers unavailable`.
- Client hang-up after the response headers were sent (body still streaming) [V trickle] and upstream failures mid-body [V], deadline hitting mid-body [V].
- Requests finishing after SIGTERM (stream ended) [V].
- WebSocket closes.
- Sprout activation (section 10), route reloads.
- The edge reports a failed write to the log stream only on stderr.

### 9.4 How control consumes the log [S: `apps/control/src/logs.ts`, `tail.ts`, `deployments.ts`, `admin.ts`]

- File: `SPROUTBOAT_LOG_PATH` (default `/var/lib/sproutboat/logs/requests.ndjson`), the scan reads only the last 1 MiB (it drops a partial first line, `windowTruncated`). Live tail polls every 1 s, reads complete lines only, handles truncation (`size < offset` -> reset). So lines must be newline-terminated and one write per line should stay atomic (no interleaving); the file must remain append-only.
- The scan drops a line unless: JSON object, `hostname` a string in the project's host set (generated + verified custom domains, exact lowercase match), `at` a string, `status` and `durationMs` finite numbers. Everything else optional, type-checked (`num()` -> null if not a finite number; `coldStart === true`, `uncaught === true` strictly).
- Derived: `failure = error ?? (status>=500 ? "upstream error" : errorKind==="no-route" ? "no route" : null)`; `statusClass` by hundreds.
- Consumers:

| Field                   | Consumer                                                                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `hostname`              | host-set filter; per-route traffic; tail url `https://<hostname><path>`                                                             |
| `at`                    | ordering (`localeCompare`/string compare for `before`), 24-bucket windows via `Date.parse`, tail `eventTimestamp = at - durationMs` |
| `method`                | logs table + method filter; `methodDistribution`; tail `request.method` (default GET)                                               |
| `path`                  | tail url path (`record.path ?? ""`), text search (`q` matches the raw line)                                                         |
| `status`                | status class filter/distribution; errors = `>= 500`; success = 2xx/3xx (routeTraffic); tail `response.status`                       |
| `durationMs`            | latency p50/p90/p99, `previous.latencyP50`, min-duration filter, tail `wallTime`                                                    |
| `ttfbMs`                | `ttfbMs` percentiles (nulls skipped)                                                                                                |
| `reqBytes` / `resBytes` | `bytesIn` / `bytesOut` sums (nulls skipped)                                                                                         |
| `coldStart`             | cold-start counts/buckets, cold filter; gates `startupMs`/`bootMs` percentiles                                                      |
| `cpuMs`                 | `cpuMs` percentiles, tail `cpuTime`                                                                                                 |
| `error`                 | `failure` text shown and searchable                                                                                                 |
| `errorKind`             | `invocationStatus` key = `errorKind ?? (status>=500 ? "upstream-5xx" : "ok")`; tail outcome                                         |
| `uncaught`              | tail outcome `exception`                                                                                                            |
| `cacheStatus`           | only `"hit"` and `"miss"` count toward `cacheHitRate`; `asset`, `dynamic`, `bypass` do not count (assets still count as requests)   |

- Tail outcome (`outcomeOf`): `uncaught` -> `exception`; `errorKind` (except `upstream-5xx`) mapped via `timed-out -> exceededWallTime`, `client-closed -> canceled`, `sprout-unavailable -> unavailable`, `no-route -> noRoute`, `proxy -> proxyError`, `response-too-large -> responseTooLarge`, `websocket-refused -> websocketRefused`, `cpu-limit|exceeded-cpu -> exceededCpu`, unknown kinds pass through; else `ok` (a handler's own 500 is `ok`).
- Admin overview reads `GET <SPROUTBOAT_EDGE_INTERNAL_URL or http://127.0.0.1:8080>/__sb/pool` (1.5 s timeout), expects `response.ok` and a flat number map. Keep that route and its keys. [S]

---

## 10. Activation protocol (#141) [V]

- Enabled only when `SPROUTBOAT_ACTIVATION_DIR` is set. Directory: `/var/lib/sproutboat/activation`, mode `2770 sproutboat-control:sproutboat`.
- Control writes `<uuid>.request.json.tmp` (mode 0640), renames to `<uuid>.request.json`; the content is a **one-entry route snapshot** `[route]` (`candidateRoute()` shape). Control polls `<uuid>.reply.json` every 50 ms for up to `SPROUTBOAT_ACTIVATION_TIMEOUT_MS` (20 s), then removes request first, then reply.
- Edge every 100 ms: `readdir`; for each name ending `.request.json` (any other file ignored [V]), skip if `<id>.reply.json` already exists [V: left untouched]; else run `start(requestPath)`:
  1. `loadRoutes(requestPath)` (full validation, same rules; invalid -> `invalid route snapshot`; bad JSON -> the parser message, e.g. `JSON Parse error: Expected '}'`);
  2. take the first entry (`empty activation request` if none) [V]; later entries ignored [V];
  3. `pool.endpoint(sproutPath, secretsPath, services, r2, dispatchDisabled=true)` (broker timers held until the route appears in a snapshot and `reconcileTimed` enables dispatch). Errors surface their message, e.g. `sprout exited before it began listening` for an unexecutable path [V].
- Reply: `<id>.reply.json.tmp` mode 0640 then rename; content exactly `{"ok":true}` or `{"ok":false,"error":"<message>"}` [V]. After writing, if the request file disappeared meanwhile, the code removes the reply.
- The edge never deletes the request file; control does. One request at a time (`busy` flag); a candidate that never listens blocks the queue for the 10 s ready timeout. The activated runtime serves nothing until the route is in `routes.json` [V: host still 404].

---

## 11. Deployment integration

### 11.1 systemd unit `infra/systemd/sproutboat-edge.service` [S]

- `User=sproutboat-edge`, `Group=sproutboat`, `WorkingDirectory=/opt/sproutboat`, `Type=simple` (no `sd_notify`), `Restart=always`, `RestartSec=2`.
- Bun edge (as inventoried): `ExecStart=/opt/sproutboat/bun/bin/bun services/edge/src/main.ts`; the base unit now runs `/usr/local/lib/sproutboat/bin/sproutboat-edge` and the Bun line comes from the `sb-engine` fallback drop-in. `ExecReload=/bin/kill -HUP $MAINPID`.
- Environment: `PORT=8080`, `SPROUTBOAT_ROUTE_SNAPSHOT`, `SPROUTBOAT_LOG_PATH`, `SPROUTBOAT_BROKER_STATE_DIR`, `SPROUTBOAT_RESOURCE_DIR`, `SPROUTBOAT_ACTIVATION_DIR`, `SPROUTBOAT_REQUEST_TIMEOUT_MS=30000`, `SPROUTBOAT_RESPONSE_MAX_BYTES=536870912`, `SPROUTBOAT_BIND_HOST=127.0.0.1`, `SPROUTBOAT_SPROUT_SANDBOX=bwrap`, `SPROUTBOAT_SPROUT_SECCOMP=/etc/sproutboat/worker-seccomp.bpf`, `SPROUTBOAT_SPROUT_CGROUP=off`, `SB_EGRESS_URL=http://127.0.0.1:8070`; `EnvironmentFile=-/etc/sproutboat/sproutboat.env` (deployment domain, dashboard URL) and `-/etc/sproutboat/egress.env` (`SB_EGRESS_TOKEN`, optional `SB_EGRESS_ALLOW`).
- Hardening that the binary must live with: `NoNewPrivileges`, `PrivateTmp`, `ProtectHome`, `ProtectSystem=strict`, `ReadWritePaths=/var/lib/sproutboat`, `UMask=0007`, `MemoryMax=2500M`, `MemorySwapMax=0`, `CPUQuota=200%`, `TasksMax=2048` (cgroup covers every sprout, broker and bwrap), `IPAddressDeny=any` + `IPAddressAllow=localhost`, `RestrictNamespaces=user pid ipc uts mnt cgroup` (bubblewrap needs user namespaces). `After=`/`Wants=` `sproutboat-egress.service`.
- `tests/contracts.test.ts` pins `UMask=0007`, `SPROUTBOAT_ACTIVATION_DIR=...`, `SB_EGRESS_URL=http://127.0.0.1:<egress port>`, `EnvironmentFile=-/etc/sproutboat/egress.env`, `IPAddressDeny=any`. The restart line is `systemctl restart sproutboat-control sproutboat-egress sproutboat-edge` and `SERVICES=(sproutboat-control sproutboat-egress sproutboat-edge caddy)`.

### 11.2 Caddy [S]

`infra/caddy/Caddyfile` (installer generates the real one): `https:// { tls { on_demand } reverse_proxy 127.0.0.1:8080 }` where on-demand cert issuance asks control (`ask http://127.0.0.1:8787/internal/tls/allow`). Caddy keeps the original `Host` and adds `X-Forwarded-For/-Proto/-Host` (default `reverse_proxy` behaviour), which the edge forwards to sprouts. Because the edge answers the pool route for any Host before routing, **`/__sb/pool` is reachable through Caddy from the public internet** on any host that holds a certificate (gauges only, no secrets). Caddy handles TLS, HTTP/2 and HTTP/3; the edge only speaks HTTP/1.1 on loopback.

### 11.3 Installer, updater, sbctl [S]

- `install.sh`: creates users `sproutboat-control`/`sproutboat-edge` and group `sproutboat`; dirs `logs` (0770 edge), `brokers` and `resources` (2770 edge), `activation` (2770 control); rsyncs the checkout to `/opt/sproutboat` excluding `.git node_modules /bun /apps/web/dist ...`; installs pinned Bun (`BUN_VERSION="1.4.4"` -> `/opt/sproutboat/bun/bin/bun`); `bun install --frozen-lockfile`; builds the dashboard; writes `/etc/sproutboat/{sproutboat,control,egress,caddy,update}.env`; copies units, `sbctl`, `sb-update` and `sb-engine`; downloads the Rust engines (see 11.4); `systemctl restart sproutboat-control sproutboat-egress sproutboat-edge`; `reload-or-restart caddy`; the edge has no build step (Bun runs the TypeScript), no Rust/compiler on the host, apt/dnf installs `bubblewrap curl git patch rsync unzip ...`.
- `sbctl update` -> `infra/sb-update` (installed to `/usr/local/lib/sproutboat/update`): `git fetch --depth 1` of the latest `v*` tag (or pinned ref) into a private stage dir, then runs that checkout's `install.sh --upgrade` (env `SB_UPDATE=1 SB_PULL=0 ...`). It never names the edge. Prod moves only on `v*` tags.
- `sbctl restart|up|down|logs edge|restore`: plain `systemctl`/`journalctl` on `sproutboat-edge`; `restore` stops control + edge + backup timer, restores, chowns `brokers`/`resources` to `sproutboat-edge:sproutboat`.
- Other harnesses that spawn the edge: `tests/tail.e2e.test.ts` (control + edge + stand-in sprout, expects `x-sb-cpu-ms`, uncaught signature, `x-sb-uncaught` marker, log fields), `tests/service-bindings/platform.ts` (`bun services/edge/src/main.ts` with `PORT=0`, `SPROUTBOAT_EDGE_CACHE=off`, optional `SB_SUITE_EDGE_ROOT`), `tools/dev-local.ts` (`bun run edge` behind portless).

### 11.4 What must change to ship a Rust binary

Done: the Rust edge and egress are the default engines. Summary of the mechanism (operator view in `infra/README.md`, section Engines):

- **Delivery:** `.github/workflows/release.yml` builds both musl binaries on a `v*` tag and attaches them with `SHA256SUMS` to the GitHub Release. `install.sh` (`install_engines`) downloads and verifies them for the exact tag (or takes `SB_ENGINE_DIR`) and installs them under `/usr/local/lib/sproutboat/bin`, outside the rsync `--delete` tree (which also excludes `/bin`).
- **Unit:** `ExecStart=/usr/local/lib/sproutboat/bin/sproutboat-edge`, `Environment=SPROUTBOAT_BUN=/opt/sproutboat/bun/bin/bun` (the sidecar needs Bun and the unit hardens PATH); the rest of the unit is unchanged, including `ExecReload`.
- **Fallback:** `/etc/sproutboat/engine.env` (`SB_EDGE`, `SB_EGRESS`) selects `rust` or `bun`; `infra/sb-engine` writes or removes `10-engine.conf` drop-ins that restore the Bun `ExecStart`. `sbctl engine [rust|bun]` drives it.
- **Still true:** Bun is required at runtime (sidecar, control, preflight); the restart line stays greppable; the request-log shape, `routes.json`, activation files, `/__sb/pool` and the startup line stay compatible with control.
- **Dev loop:** `bun run edge`, `tools/dev-local.ts` and the e2e harnesses still run the Bun edge; they are not changed by this.

---

## 12. Subtle points and Bun-specific behaviours

Each item says what Bun did and what a faithful rewrite should decide. [V] unless tagged.

1. **Dev error page.** Any exception thrown out of `fetch()` (missing/empty Host -> `new URL` failure; malformed percent in an asset-eligible GET/HEAD; missing asset file; malformed manifest [S]) produces `500` with `content-type: text/html;charset=utf-8`, a ~50 KB HTML page embedding `{"message":"GET - /%E0%A4%A failed","cwd":"/Users/..."}` and source excerpts, because `NODE_ENV` is not `production`. No log line. Clients and control never rely on it; a Rust edge should answer a small 400/404/500 instead, and the diff tool should whitelist this class. The stderr gets the TypeError/URIError stack plus `GET - <path> failed`.
2. **Malformed percent-encoding** only trips the asset decode on **GET/HEAD to supervisor routes**; POST etc. pass the raw path (verified). `decodeURIComponent` is JS-strict (lone `%`, bad UTF-8 sequences like `%E0%A4%A`, throw; `%2F` decodes to `/` for key lookup).
3. **Header casing.** Edge-generated responses show `content-type` lowercase and `Date`, `Content-Length` title-cased; proxied upstream headers keep the casing Bun's client reported (`X-Mixed-Case` kept, `Content-Type`, `Cache-Control`, `Location`, `ETag`, `Age` title-cased, `sb-cache` and `x-sb-*` lowercase). HEAD/no-body paths emit lowercase `content-length`. HTTP header names are case-insensitive; do not match casing.
4. **Automatic headers.** Bun adds `Date` to every response except HEAD responses (proxied, asset and redirect HEAD all lacked it; curl -I confirmed). It adds `Content-Type: text/plain;charset=utf-8` for string bodies it generates (404, 502, 504, 503 bodies) and `application/json;charset=utf-8` for `/__sb/pool`; it does not invent a content-type for proxied bodies [V raw sprout]. `Content-Length` appears when the whole body is known at first read, otherwise `Transfer-Encoding: chunked`. 204/304 carry no body or length.
5. **`fetch` auto-decompression bug.** The edge forwards the client's `Accept-Encoding`. If a sprout answers with `Content-Encoding: gzip` the Bun edge sends the **decompressed** body with the original `Content-Encoding: gzip` header and a recomputed `Content-Length` (23 vs the original 28), which is a corrupt response for clients. Test fixture: gzip body of `hello hello hello hello`. Log `resBytes` showed the compressed declared length (28). Real Porffor sprouts do not compress today; a Rust proxy that passes bytes and headers through untouched is the correct behaviour and equals Bun's for uncompressed responses. Fetch also adds `Accept-Encoding: gzip, deflate, br, zstd` when the client sent none.
6. **Content-Length handling.** Request `Content-Length` is read only for `reqBytes` (garbage -> 0); chunked requests log 0. The edge trusts the declared response length for the size guard (`declared > cap` -> 502) and for `resBytes`, but fetch bounds a lying upstream: CL 5 with 10 bytes sent -> client got 5 bytes; CL 50 with 3 bytes then close -> client got headers and a dropped connection, no log [V].
7. **HEAD.** Proxied to the sprout as HEAD (no cache, no `cacheStatus`, no `sb-cache`); log `resBytes` = declared length; asset HEAD has `content-length` set but no body and no `Date`.
8. **Body size limit.** Enforced by Bun before the handler: CL over limit -> `413 Request Entity Too Large`, chunked over limit -> `413 Payload Too Large`; both with no headers and no log, even on `/__sb/pool`. The per-upload limit for direct transfers lives in the broker.
9. **Idle timeouts.** Server `idleTimeout` seconds = `min(255, ceil(reqTimeout/1000)+5)`; granularity coarse (6 s configured closed at ~12 s). `server.timeout(request, 0)` disables it per request for direct transfers. WS client idle 120 s. The request deadline (30 s) is separate and also cuts streaming bodies (see 7.1).
10. **Request deadline vs streaming.** `AbortSignal.timeout` stays attached to the upstream body, so every response, SSE included, dies at 30 s with a truncated stream and no log. Decide deliberately in Rust (match, or exempt after headers) and document the divergence.
11. **URL normalisation.** `new URL(request.url)` collapses dot segments, treats `%2e`/`%2E` as dots, keeps `//`, keeps `%2F`, drops fragments, lower-cases nothing in the path; absolute-form targets work via Bun. These apply to cache keys, asset lookup, redirect matching and the path forwarded upstream.
12. **Range on assets.** `Bun.file` bodies get `206`/`content-range`/`accept-ranges` for GET with `Range`; log still says 200 with full size. Cache-eligible proxied GETs with `Range` are BYPASS.
13. **Host parsing.** `Host.split(":")[0]`: IPv6 literals break, `app.test.` does not match, uppercase becomes lowercase. The edge forwards a `Host` with a port upstream with the port.
14. **Exit codes.** Boot failure and SIGHUP-with-bad-file exit 1; SIGTERM/SIGINT exit 0 unless the process had logged a handler exception (then 1).
15. **Request headers added by `fetch`:** `accept`, `accept-encoding`, `user-agent: Bun/<version>` when missing. A Rust proxy need not reproduce them.
16. **Redirect/`Response.redirect`** normalises the dashboard URL (adds the trailing slash on bare origins) and emits `Content-Length: 0`.
17. **Unhandled rejection in `process.on("SIGHUP", async ...)`** is fatal in Bun; nothing in production sends SIGHUP except `systemctl reload`, so a bad `routes.json` plus `systemctl reload sproutboat-edge` kills the edge, and `Restart=always` then crash-loops at boot until the file is fixed.
18. **Stale route objects** after any reload discard in-flight cache fills (3.4).
19. **Log written before the work for assets** (5.2) and **after** for proxied bodies; the two give different notions of `durationMs`.
20. **Bun version drift.** Local runs used 1.4.4; the box pins 1.4.4 (same as local). Header casing, idle-timer granularity and dev error pages are Bun internals and may differ by patch version.

## 13. Intentional differences (Rust fixes Bun bugs)

Decision: Bun gets no hotfix; the Rust edge fixes these instead of copying them. The diff tool should whitelist exactly these. Bun column = observed behaviour.

| #   | Bun (observed)                                                                                                                                                                                                                                                                                                                     | Rust (new behaviour)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Tag                  |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| 1   | the edge answers `/__sb/pool` for any method and any Host before routing, so it is reachable through Caddy on any certified hostname (section 4 step 3). Verified: served with `Host: whatever`, `Host: sb.test` (apex) and `Host: app.test`.                                                                                      | Answer only when the TCP peer is loopback **and** the Host is `localhost`, `127.0.0.1` or `[::1]` (port allowed). Anything else falls through to normal routing (404 "unknown deployment" or the app). Control's `SPROUTBOAT_EDGE_INTERNAL_URL` default (`http://127.0.0.1:8080`) still works; staging uses `http://127.0.0.1:18080`. Keep the 10 JSON keys.                                                                                                                                                                                                                                                                                                                                                    | V                    |
| 2   | Handler exceptions render Bun's HTML dev error page: 500, ~50 KB, contains `cwd` and source excerpts, no log line. Triggers: missing/empty `Host`, malformed `%` in a GET/HEAD path on a supervisor route (`decodeURIComponent`), manifest entry whose file is missing.                                                            | Small plain-text responses, no paths or source: missing/empty/unparsable Host -> `400 bad request`; malformed percent-encoding on an asset-eligible request -> `400 bad request` (treat the path as not an asset is also acceptable but pick one and document it in code); missing asset file -> `500 internal error`. Each is **logged** (status, `errorKind`, `error`; fields as section 9).                                                                                                                                                                                                                                                                                                                  | V                    |
| 3   | Bun `fetch` decodes a gzip body but keeps `Content-Encoding: gzip`; Bun recomputed `Content-Length` (23 vs original 28), so clients receive a corrupt response.                                                                                                                                                                    | Pass the encoded bytes, `Content-Encoding` and `Content-Length` through unchanged; never decode. `resBytes` stays the declared (wire) length.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | V                    |
| 4   | The 30 s `AbortSignal.timeout` stays attached to the upstream body: a trickling response was cut at the deadline (no terminal chunk, no log), which breaks SSE. WS client idle is fixed 120 s; the Bun connection idle timer is coarse (6 s setting closed at ~12 s).                                                              | Deadline applies until the **response headers** arrive; after that only client disconnect, the byte cap, or a (generous, configurable) body idle gap ends the stream. WebSockets get a documented idle default (keep 120 s with ping/pong so live sockets are not cut; pick the exact value in the Rust config table). Request timeout stays 30 s before headers (`504 request timed out`).                                                                                                                                                                                                                                                                                                                     | V (body cut), S (WS) |
| 5   | `SIGHUP` with an invalid `routes.json` is an unhandled rejection and the process exits 1 (then `Restart=always` crash-loops at boot).                                                                                                                                                                                              | Keep the old routes, log `route snapshot reload failed: <msg>` to stderr, stay up; SIGHUP with a missing file still clears routes (unchanged). Boot with an invalid file may still exit non-zero (activation and boot semantics unchanged).                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | V                    |
| 6   | Not logged by Bun: apex 302, Bun 413, client hang-ups after headers, mid-body upstream errors, deadline mid-body, `503 direct transfers unavailable`, WebSocket closes, requests finishing after SIGTERM. Asset lines are written before the response: Range requests logged 200 with full size, missing file logged 200 then 500. | Log all of them with the same field set (new `errorKind` values allowed, e.g. `redirect`, `payload-too-large`, `upstream-aborted`; tail's `outcomeOf` passes unknown kinds through). Asset lines carry the real status (206 for ranges, 304, 200) and the real byte count, written when the body ends. The edge logs a WS close once, as a second line for the same path: status 101, whole-socket `durationMs`, payload bytes in `reqBytes` / `resBytes`, plus `closedBy` and `closeCode`. The 413 line carries `path`. The edge logs a client that hangs up during a cold start as 499 once the start finishes, as in Bun, and the start itself carries on for the next request. `/__sb/pool` stays unlogged. | V                    |
| 7   | A change in `services` alone does not dispose the running sprout. Verified: swapping `services` and sending a request gave `live=2 spawns=2` (the stale process lingers until idle eviction, the edge spawns a new one under the new runtime key).                                                                                 | Compare `services` in the swap decision (like `secretsHash` and `r2`) and dispose the old runtime.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | V                    |
| 8   | A request path that starts with `//` (`//seen//x`) reaches the app as `/seen//x`: Bun drops the first slash when it forwards (the log still shows `//seen//x`).                                                                                                                                                                    | Route, cache, log and forward the path exactly as received (`//seen//x`); it is never read as an authority.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | V                    |

Everything else in sections 3-12 stays the contract. Items in section 12 that describe Bun-only artefacts (header casing, `Date` missing on HEAD, `User-Agent: Bun/x`, chunked vs Content-Length choice, idle-timer granularity) are likewise not required to match.

## Appendix A. Verified-by-run checklist

Probe coverage: startup/exit/signals, routing and Host edge cases, apex 302, pool endpoint, header forwarding/stripping, uncaught signature and marker, cpu header, cookies, status passthrough, HEAD/OPTIONS/custom methods, path normalisation, malformed percent-encoding, body limit (CL and chunked), declared and streamed response caps, deadline (headers and body), client abort (before headers and mid-stream), upstream crash and respawn, cache matrix (hit/miss/bypass/dynamic, statuses, size, expiry, key), assets (redirects, etag/304, HEAD, range, headers rules, sprout-first, missing file), reload matrix (swap, older mtime, deleted, invalid, SIGHUP), route validation matrix (26 cases), WebSocket (relay, refusal, POST not upgrade, 101 headers), timed bindings, activation spool, idle timeout, log-path failure modes, env parsing, port conflicts, shutdown with an in-flight request.

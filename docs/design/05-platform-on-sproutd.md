# Design 05: The platform on sproutd

Status: proposal. Research only; nothing here was built, and no benchmark was run for this document. Every number is quoted from a file or PR named next to it. Anything I could not check is marked **unverified**, and the list is collected in the last section.

Sources (read at these heads): platform `sproutboat` origin/main 121dbf1; `sproutd` origin/main 7565343 (README.md, STAGE-A.md, PARITY.md, docs/operations.md, docs/bindings.md, src/native-host.cpp, build/requalify.sh, build/compile-app.ts, inputs/expected.json, test/requal-expected.json); `sproutboat-packages` origin/main fbeafde (`packages/wire/src/broker.ts`, `packages/runtime/src/transport-*.js`); `sproutboat-cli` origin/main de5afd6 (`CONTRACTS.md`, `src/standalone-build.ts`). Production on othello (v0.12.1 by `/opt/sproutboat/package.json`) was inspected read-only: `ls /opt/sproutboat`, `systemctl list-units`, `systemctl cat sproutboat-edge.service`, `ps`. Nothing was restarted, written or run through `sbctl`; `/var/lib/sproutboat` and `/etc/sproutboat` are not readable by the inspecting user, so production data and env files were not seen.

## Summary

Today every deployment is one native sprout process under bubblewrap, plus (when the artifact ships `bindings.json`) one Bun broker process, all supervised by the edge. sproutd runs many apps as `app.so` modules forked from one shared, pre-initialised runtime, with the bindings served inside each app's own worker. Moving the platform onto it removes the broker and the per-deployment process pair, gives the platform a real blue/green, versions and rollback implementation in the host, and, by sproutd's own measurements, a much lower idle memory floor per app.

It costs four things the platform does not pay today, in rough order of size:

1. **The generation problem.** An `app.so` is only valid against the runtime generation it was compiled for, and sproutd promoted 13 generations between 2026-10-24 and 2026-10-29 (`inputs/expected.json`, note). Today's artifact is an immutable binary that the platform promises to run "arbitrarily long ago" (`sproutboat-cli/CONTRACTS.md`). These two do not fit without a scheme (section 3).
2. **Throughput.** sproutd holds 2,600 req/s on the API challenge app after #67 (open), where the same app holds 4,600 standalone (section 4).
3. **Missing platform features in sproutd:** service bindings between apps, account-level shared resources (#74), a backup API, CPU cgroup limits, `connect()`, full `crypto.subtle`.
4. **Security posture.** sproutd's own gate says untrusted code must not run before the Stage C review, and neither the red-team pass (C7) nor the external review (E2) has happened.

This document does not recommend going or not going. It lays out the change, the gaps with evidence, a migration that can be undone per project, and the decisions only the user can make (section 7). One cheaper alternative is included because it changes the comparison: switching the existing supervisor path to `--standalone` artifacts (embedded bindings, no broker) captures part of the benefit without sproutd (section 1.3).

## 1. Today versus target

### 1.1 Today

```
                       Internet
                          |
                    +-----v-----+   TLS, on-demand certs (asks control /internal/tls/allow)
                    |   Caddy   |   serves apps/web/dist (dashboard) from disk
                    +--+-----+--+
          control.<d> |     | <project>.<admin>.<d>
              +-------v+   +v-----------------------------------------+
              | control|   | edge (Bun, 127.0.0.1:8080)               |
              | :8787  |   |  routes.json (SIGHUP)  asset serving     |
              | SQLite |   |  GET cache  WS relay  request ndjson     |
              +---+----+   |  supervisor: spawns, idles, restarts     |
   stageCandidate |        +---+------------------+-------------------+
   (spool dir)    +----------->|                  |
                                |  per deployment  |
                    +-----------v--+      +--------v---------+
                    | bwrap        |<---->| Bun broker       |  loopback TCP, framed JSON
                    |  sprout      |      |  KV D1 R2 queues |  one per deployment
                    |  (native)    |      |  DO assets svc   |  (only if bindings.json)
                    +--------------+      +----+--------+----+
                                               |        |
                      sproutboat-egress :8070 <+        +> /var/lib/sproutboat/{brokers,resources}
                      (separate unit, token, vets IPs)     SQLite files, VACUUM INTO nightly
   sproutboat-backup.timer -> backups.ts -> sproutboat-<date>.tar.gz (+ optional S3)
```

Facts behind the diagram:

- One sprout per deployment, started through `infra/sandbox/sprout-sandbox.sh` (bubblewrap: user, pid, mount, ipc, uts namespaces, uid 65534, optional seccomp file); idle sprouts are reaped after `idleMs` (600,000 by default) (`services/supervisor/src/run.ts`).
- The broker is spawned only when the artifact has `bindings.json` (`spawnWithBroker`, `run.ts:283`), on port `workerPort + 10000`, with `bun --smol`.
- The edge unit caps the edge plus every sprout and broker it spawns: `MemoryMax=2500M`, `CPUQuota=200%`, `TasksMax=2048`; per-sprout cgroups are off (`SPROUTBOAT_SPROUT_CGROUP=off` in `infra/systemd/sproutboat-edge.service`; the unit on othello shows the same three caps).
- Because sprouts and brokers are children of the edge, restarting the edge (which `sbctl update` does) ends every sprout (`--die-with-parent`) and the next request cold-starts it. This follows from the code; I did not restart anything to observe it.
- On othello at inspection: caddy, control, edge, egress, the backup timer, one visible sprout, one visible broker (35.6 MiB RSS in a single `ps`), next to benchmark processes (`workerd`, `rsync` into `sproutboat-bench`). The broker figure is one snapshot, not a benchmark.

### 1.2 Target

```
                       Internet
                          |
                    +-----v-----+
                    |   Caddy   |   unchanged: TLS, dashboard static files
                    +--+-----+--+
          control.<d> |     | app hostnames
              +-------v+    |   (option A: via edge; option B: straight to sproutd, section 2.3)
              | control|    v
              | SQLite |  +------+   admin socket (0600): deploy, rollback, split, limits, tail, ...
              |        +->| edge |------------------------------------+
              +---+----+  +--+---+  (thin: cache, assets, metrics)    |
   compile      |             |                                        |
   service  <---+      +------v-----------------------------------+   |
   (generated.js        | sproutd, one daemon per generation       |<--+
    -> app.so)          |  frontend: routes by Host, queues, no    |
                        |            privileges, egress threads    |
                        |  fork server: runtime pre-loaded, never  |
                        |            runs app code                 |
                        |   worker per app: own uid, cgroup,       |
                        |   Landlock, seccomp, embedded bindings   |
                        +-----+------------+-----------+-----------+
                              |            |           |
                           [app A]      [app B]     [app C]   STATE/<id>/{store.sqlite,d1/,r2-blobs/}
```

What changes in the picture: the supervisor, the bubblewrap wrapper and the broker disappear for migrated projects; the per-deployment loopback ports disappear; the egress unit is not needed by them (sproutd's frontend resolves, vets and connects, then passes the open socket to the worker, TLS stays in the worker; `sproutd/README.md`, "How apps are kept apart"). Control, Caddy, the dashboard, the backup timer and the edge (in option A) stay.

### 1.3 The cheaper alternative: standalone artifacts under the existing supervisor

`sproutboat build --standalone` already produces one executable with SQLite compiled in and "no broker process" (`sproutboat-cli/src/surface.ts`). The supervisor could run those under bubblewrap as it runs sprouts today. Measured for the API challenge app (`docs/benchmarks/api-challenge-2026-10-29.md`): standalone holds 4,600 req/s at 210 CPU us/request, idles at 7 MiB RSS, cold-starts in 139 ms (unit start to `/health`, includes the process, not a fork). It keeps the immutable-binary contract and has no generation problem. It does not give sproutd's shared runtime pages, the in-host versions and rollback, or scale-to-zero by fork (sproutd cold start for real apps is 5 to 7.6 ms, `sproutd/README.md`). It also rejects service bindings at build time (`standalone-build.ts`: "service bindings call another deployment through an edge, which a standalone binary has none of"). Whether this covers enough of the goal is decision 1 in section 7.

## 2. What changes in each component

### 2.1 The artifact

|          | Today                                                                                                                                   | On sproutd                                                                                                                                                                                                                              |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Upload   | `manifest.json` + executable `worker` + `bindings.json`, `assets.json`, `assets/`; "never contains source code" (`docs/artifact-v1.md`) | An `app.so` for one generation, or the generated JS that the server compiles (section 3)                                                                                                                                                |
| Built by | The CLI on the user's machine (Porffor + Zig)                                                                                           | Today: `bun build/compile-app.ts GENERATION PROJECT OUT.so` after `sproutboat build --standalone`, "about 4 seconds", checks the app does not change the runtime's shared code (`abi_rejected`, `compile_failed`) (`sproutd/README.md`) |
| Validity | Valid until the host's CPU/libc stop running it; the broker "must speak to every prelude ever compiled" (`CONTRACTS.md`)                | Valid against one generation (`abi` digest in `inputs/expected.json`)                                                                                                                                                                   |
| Assets   | `assets/` on disk, served by the edge first (`services/edge/src/main.ts`), SPA fallback via `env.ASSETS` through the broker             | Baked into the module by the build (`transport-embedded.js`, `assets.get` reads `globalThis.__sbAssets`); module size grows with assets; edge-first serving can stay in option A                                                        |
| Trust    | A user-built native binary runs under bubblewrap                                                                                        | `D3` in sproutd issue #1 leans to "the platform only compiles; users upload JS, never native modules (a native constructor runs code at load time)"                                                                                     |

Two things to note. First, the build input for sproutd is `sprout.generated.js` (the output of `sproutboat build --standalone --emit-only`), which is bundled user code, so "an upload never contains source code" does not hold for the server-compile path; the artifact contract would need a documented second shape (`CONTRACTS.md` allows this only additively, with two minor releases of overlap, `docs/versioning.md`). Second, admission can say no: of the 52 Cloudflare example apps in A5, 49 admit and 3 fail to build (`test/requal-expected.json`, `a5`). The platform needs a defined behaviour for a project that does not admit (fall back to the supervisor path, or refuse).

I found no check of the `abi` digest at load time in `native-host.cpp`; the host checks only `api->version` and `api->size` (`:2162`). Whether the module itself embeds a digest is **unverified**. Control would need to record the generation in each deployment row and refuse mismatches itself.

### 2.2 Control: deploy, rollback, blue/green

Today (`apps/control/src/deployments.ts`, `activation.ts`, `store.ts`):

1. `deployArtifact` validates the upload, stores it content-addressed, records a `deployments` row.
2. `stageCandidate` drops a request into the activation spool; the edge starts the exact candidate with timers held (`dispatchDisabled`), replies ok or the start error.
3. Control activates the row and rewrites `routes.json`; the edge reloads on SIGHUP; old versions are pruned to `SPROUTBOAT_MAX_VERSIONS_PER_PROJECT` (25).

On sproutd the host owns steps 2 and 3:

| Control action              | sproutd verb (`sproutd/README.md`, `docs/operations.md`)                                                                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| deploy                      | `deploy ID MODULE [SECRETS]`: blue/green between requests; "if it fails to load the old one keeps serving"; the module is copied to `STATE/ID.versions/VID.so`, VID is the first 16 hex digits of its SHA-256 |
| activate / rollback         | `rollback ID [VID]` (through the same blue/green path, keeps limits)                                                                                                                                          |
| gradual deploy              | `split ID VID PERCENT` (new capability; `Cloudflare-Workers-Version-Key` affinity)                                                                                                                            |
| candidate that cannot start | the deploy reply is `error ...`; no separate stage step                                                                                                                                                       |
| timers held until routed    | the daemon runs crons, queues and alarms itself and they stay with the active version                                                                                                                         |
| prune                       | `versions-keep N` (default 10); `0` stores nothing and loads modules in place                                                                                                                                 |

Control stays the source of truth (deployments, owners, quotas, audit); it becomes an admin-socket client with a mapping `deployment id <-> VID` and a reconcile pass at startup (`list`, `versions ID`) because sproutd also keeps its own state in `STATE/.sproutd/apps` and restores it after a restart. Differences to design around:

- Retention: control keeps 25 versions, sproutd 10 by default. A rollback target that sproutd pruned must be re-deployed from control's copy; the simplest rule is control keeps the modules and sproutd runs with `versions-keep 0` or a matching number (decision, section 7).
- Rollback to a version compiled for an older generation is the generation problem again (section 3).
- The admin socket is mode 0600 with "no auth beyond file mode" (`docs/operations.md`, "Who calls this"). Control runs as `sproutboat-control`, sproutd as its own user, so either the socket mode or a small adapter has to change. The socket is also the root of every tenant's deployment, so the adapter, not the CLI user, must enforce ownership (decision).
- Nothing in `sproutboat` or `sproutboat-cli` talks to sproutd yet (`docs/operations.md`, "Who calls this"). `deployments.ts` already has the user-facing shapes sproutd's design note names (deployments with one active, `activate`, logs/recent, SSE tail).
- Blue/green with LTX capture on is unsupported (`docs/bindings.md`, "LTX capture"): the new worker fails to start capture while the old holds the lock. Any backup design that relies on capture inherits this.

### 2.3 Edge and routing

What the edge does today and where each piece goes:

| Edge responsibility                                                     | On sproutd                                                                                                                                                  |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host to deployment (`routes.json`, custom domains)                      | `host ID HOSTNAME` / `unhost HOSTNAME`; control already knows the table                                                                                     |
| Static assets, edge first, redirect rules, cache-control                | Not in sproutd's frontend; the app serves them from the baked bundle                                                                                        |
| GET response cache (`EdgeCache`, `sb-cache` header)                     | None in sproutd (not found in README or `operations.md`)                                                                                                    |
| WebSocket relay                                                         | sproutd serves WebSockets itself from compat date 2026-10-30, hibernation from 2026-11-01 (`PARITY.md`)                                                     |
| Request log (`requests.ndjson`) feeding dashboard metrics               | Tail `request` events; fewer fields (below)                                                                                                                 |
| Service-binding vouching (`SB_EDGE_SECRET`, per-callee `SB_EDGE_TOKEN`) | Nothing; not implemented between sproutd apps (`PARITY.md`, "Service bindings, RPC")                                                                        |
| Cold-start and startup metrics                                          | Not exposed per request                                                                                                                                     |
| Activation spool                                                        | Replaced by `deploy`                                                                                                                                        |
| Response size cap (512 MiB), 30 s request timeout, idle timeout         | sproutd: 30 s wall per request by default, 1 MiB in / 100 MiB streamed body rules per compat date, no cap on a streamed response (`PARITY.md`, "Body size") |

Options:

- **A. Edge stays in front** and proxies migrated hosts to sproutd's port (with the original `Host`). Dashboard metrics, cache, assets and the activation path keep working with a `backend` field in the route entry. Cost: one extra hop and a Bun process in the path; the hop's cost is **unmeasured** (the API challenge ran sproutd "not behind Caddy or the edge", `api-challenge-2026-10-29.md`, Caveats).
- **B. Caddy sends migrated hostnames straight to sproutd** and everything else to the edge. Removes the hop but loses cache, edge-first assets and the existing metrics until rebuilt; needs per-host Caddy routing or a host-match list that control maintains.
- **C. Replace the edge entirely** once nothing needs the supervisor. Not possible while the supervisor path is kept for local development and ineligible apps (`infra/README.md`: off Linux the sandbox is skipped and the sprout spawned directly).

The dashboard reads only control's API (`apps/web/src/traffic-charts.tsx` and routes), but its charts need edge-log fields: `ttfbMs`, `reqBytes`/`resBytes`, `coldStart`, `startupMs`, `cpuMs` (`docs/metrics-roadmap.md`). sproutd's `request` tail event carries method, URL, status, outcome, time and serving version (`docs/operations.md`, section 1). Under option B those fields would need new sources or would disappear.

### 2.4 Bindings

sproutd uses the runtime's **embedded transport**: SQLite and plain files under the app's own state directory, "no binding service, broker or extra process" (`docs/bindings.md`). The broker transport is the loopback RPC to the Bun broker. Both come from `sproutboat-packages`; the op sets differ. From the op tables: the broker handles `service.fetch` and `d1.query`; the embedded transport has neither, and has `d1.backup`, `r2.md5` and the rest of the KV, D1, R2, DO, queue, cache, analytics and rate-limit ops.

| Feature                                    | Platform today (broker)                                                                                                 | On sproutd (embedded)                                                                                         | State                                                                                               |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| KV                                         | per-resource `resources/<id>.sqlite` or per-broker db                                                                   | `STATE/ID/store.sqlite`                                                                                       | 49/50 against miniflare from 2026-10-25 (`PARITY.md`)                                               |
| D1                                         | `resources/<id>.sqlite` or `brokers/<digest>/d1/`                                                                       | `STATE/ID/d1/BINDING.sqlite`                                                                                  | 57/64 at the time of PARITY.md; PR #61 (open) widens to 106 cases, 99/106 standalone, 98/106 broker |
| R2                                         | resources + `r2-blobs`, quota from `SPROUTBOAT_R2_QUOTA_BYTES` (10 GiB)                                                 | `STATE/ID/r2-blobs/*.blob`, quota `storage-mb` (default 10 GiB)                                               | 48/48 from 2026-10-26                                                                               |
| Durable Objects                            | `do_<id>.sqlite` per project, survives redeploy; `do.sql` files                                                         | in `store.sqlite`; keyed by app id so it survives redeploy                                                    | 93/105 (PARITY.md); PR #65 (open) widens                                                            |
| Queues, cron, alarms                       | broker timers, POST back to the sprout; held until routed                                                               | the daemon keeps time, wakes a reaped app; no replay of missed minutes                                        | Queues 41/46; B22 smokes (`docs/bindings.md`, B22)                                                  |
| Secrets                                    | decrypted `secrets.json` per project, read at spawn                                                                     | `secrets ID FILE` as `NAME=VALUE` lines, read before the sandbox closes                                       | needs a format adapter; values containing newlines are **unverified**                               |
| Assets                                     | edge-first, `env.ASSETS` via broker                                                                                     | baked into the module                                                                                         | works; module size grows                                                                            |
| Egress policy (#174)                       | the egress unit resolves, refuses private and reserved ranges, connects to the vetted IP; `SB_EGRESS_ALLOW` global list | the frontend does the same with the runtime's own table, `egress-allow` global list, no sockets in the worker | same granularity; per-tenant policy, limits and metering are open (C2)                              |
| Service bindings                           | broker `service.fetch` via the edge with vouching tokens; 53/53 against workerd (#303)                                  | not between sproutd apps (B5)                                                                                 | **gap**                                                                                             |
| Account-level shared resources (#74)       | `{ binding, id }` resolved to one shared file for several projects                                                      | each app's data is private; id ignored (sproutd #17, design only)                                             | **gap**                                                                                             |
| Analytics Engine, rate limiters, Cache API | broker ops                                                                                                              | embedded ops                                                                                                  | present                                                                                             |

Two consequences. Projects that bind a shared resource, or a service binding, cannot be migrated until B5 and #17 land, or until the project is made self-contained. How many production projects do (the control DB would say) is **unverified**; I could not read it. And the egress unit and the broker stay in the product as long as the supervisor path does.

### 2.5 Backups and restore of per-app SQLite

Today `apps/control/src/backups.ts` runs daily, takes `VACUUM INTO` snapshots of the control database and every SQLite file under `resources/` and `brokers/`, copies R2 bodies, artifacts, routes and `secrets.key` into one tarball, optionally uploads to S3. `sbctl restore` stops control and the edge, restores, re-owns `brokers` and `resources` to `sproutboat-edge:sproutboat`.

On sproutd:

- State is `STATE/ID/{store.sqlite, d1/*.sqlite, r2-blobs/}`, owned by the app's uid and mode 0700, outside the reach of the backup user (`docs/bindings.md`: purge runs inside the fork server "because a per-app uid's 0700 tree is unreadable to the frontend"). A WAL-mode `VACUUM INTO` also needs to open the `-shm`, which needs write access. Backup therefore needs either a root-run job, a daemon verb that snapshots through the fork server, or the app's own `env.DB.backup()`, which writes to `STATE/ID/backups/`. sproutd ships "no uploader, scheduler, compactor or backup API" (`docs/bindings.md`, "LTX capture"). **Gap.**
- LTX capture (sproutboat-packages #141) streams one D1 database per app (`capture ID DB`) into a spool inside the state directory, counts toward the quota, and does not support blue/green redeploys.
- Restore is easier than today in one respect: an app directory restored by root under a different uid index is re-owned on the next worker start (`own_tree`, `docs/bindings.md`, "Where the data lives"). `sbctl restore` would add sproutd to the stop list and restore `STATE/` the same way; the archive format needs a `sproutd/` member and a manifest version.
- Whether a broker-written SQLite file opens unchanged in the embedded transport (schema, internal tables, `user_version`) is **unverified**; both sides read the same `packages` source but I did not compare schemas. R2 blob naming differs in form (the embedded transport names blobs `sha256(bucket 0x1e key).blob`; the broker's layout was not compared).

### 2.6 Logs and live tail

Today control merges two sources: the edge request log and each sprout's stdout file (`apps/control/src/tail.ts`, `logs.ts`), polling every second with a 10-minute cap. Console lines are not tied to requests, because the runtime does not tag them.

sproutd has `logs ID [N]` (last lines as JSON) and `tail ID...` or `tail *` on the admin socket: `log`, `request` and `exception` events, `outcome` names borrowed from `wrangler tail` (`ok`, `exception`, `exceededCpu`, `exceededWallTime`, `canceled`) plus its own (`rateLimited`, `suspended`, `unavailable`, `queueFull`). Console lines are also not tied to requests (`docs/operations.md`, section 1), so there is no regression there. Per-app logs rotate at 8 MiB and 7 days.

Design points: control holds one `tail *` connection (or one per tailing client) and filters by owner itself; request events are built only while a tail is attached, so a permanent metrics consumer turns that cost on for everyone (cost **unmeasured**); `exceededCpu` and friends map onto control's `errorKind` taxonomy, `ttfb`, bytes and cold start do not exist in the event.

### 2.7 Per-app limits

| Limit     | Today                                                                                                                                             | sproutd                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Memory    | per-sprout cgroup is opt-in and off in the repo unit (`SPROUTBOAT_SPROUT_MEMORY_MAX` 128M if enabled); the 2500M edge cgroup is the real backstop | `memory.max` per worker cgroup, `limits ID memory-mb N`, default 32 MiB, swap off, `pids.max 9` (`native-host.cpp:273-298`). The API challenge had to run with `memory-mb 1024`                                                                                                                                                                                                                                              |
| CPU       | edge `CPUQuota=200%` aggregate; per-sprout `CPUQuota` (50%) only if cgroups are on                                                                | per-request CPU budget enforced by killing the worker (`limits ID cpu-ms N`, default 2000, per-request since runtime 0.36.0 / compat 2026-11-02, `PARITY.md`); a worker using 2 s of CPU without answering is stopped. **No `cpu.max` or `cpu.weight` is written** (`native-host.cpp` writes `memory.max`, `memory.swap.max`, `pids.max` only; sproutd #1, C1: "Open: ... cpu.max/weight"). The user's position is "not yet" |
| Wall time | `SPROUTBOAT_REQUEST_TIMEOUT_MS` 30000 platform-wide                                                                                               | `wall-ms`, default 30000; cron/queue/alarm up to 15 min                                                                                                                                                                                                                                                                                                                                                                      |
| Storage   | R2 quota per account                                                                                                                              | `storage-mb`, default 10 GiB per app, enforced inside the worker by a directory scan at most once a second, with overshoot by up to one second of writes                                                                                                                                                                                                                                                                     |
| Rate      | none per project found in the edge                                                                                                                | `rate ID N [BURST]`, 429 with `Retry-After`; `suspend` / `resume`                                                                                                                                                                                                                                                                                                                                                            |

Control's `limits.ts` (deploy rate, project caps, version caps) is unaffected; a per-project plan would map to the `limits` verb. The memory default is the point most likely to surprise existing apps: 32 MiB against whatever they run in today (**unverified** for production; the repo unit has cgroups off).

### 2.8 The sandbox: uid and cgroup

|                   | Today                                                                                      | sproutd                                                                                                                                                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Process model     | bubblewrap per sprout (user, pid, mount, ipc, uts namespaces), all as uid 65534            | process per app forked from the template, own uid/gid `BASE+N` (`uids` directive), own cgroup per worker generation                                                                                                                                                        |
| Filesystem        | read-only view of runtime libs plus the artifact directory                                 | Landlock: read/write only its state dir, read of its two modules, no exec                                                                                                                                                                                                  |
| Network           | `IPAddressDeny=any` on the edge unit (inherited), loopback only; fetch via the egress unit | seccomp denies `socket()` of any kind; Landlock has no TCP rule; the frontend connects and passes the fd                                                                                                                                                                   |
| Syscalls          | optional BPF file (`worker-seccomp.bpf`)                                                   | seccomp denylist (not an allowlist; C3 open)                                                                                                                                                                                                                               |
| Host requirements | unprivileged user namespaces, bubblewrap, cgroup v2 optional                               | Linux kernel with Landlock ABI 4+ (TCP rules, 6.7 or later), signal scoping needs 6.12+, cgroup v2 with a delegated scope, `AmbientCapabilities=CAP_SETUID CAP_SETGID CAP_CHOWN`, a subuid range for the daemon user, x86-64 only (no per-platform packages: issue #1, B1) |

sproutd needs no user namespaces, so it avoids the Ubuntu AppArmor restriction on them that `install.sh` has to lift today; it needs privileges of a different kind (setuid-family capabilities and a delegated cgroup). othello runs kernel 7.0.0-38 (`uname -r`), which satisfies both kernel floors.

### 2.9 Dashboard

`apps/web` talks to control only. If control keeps its API shapes and the edge stays in front (option A), the dashboard needs no change. Under option B the traffic charts lose fields (section 2.3). Candidate additions, none required: show the runtime and generation on a deployment, show the per-app limits that sproutd enforces, surface `exceededCpu` and `queueFull` outcomes, and a "migrate to sproutd" control in project settings (section 5). Any UI work follows the repo's browser-check rules and is out of scope here.

## 3. The generation problem

### 3.1 Evidence

- A generation is Porffor plus three patch layers and the shared prelude and runtime. Its identity is the `abi` digest (`inputs/expected.json`). Apps compile against one generation and are checked against its ABI (`abi_rejected` otherwise).
- Cadence: 13 promotions from `ea07aedb` (2026-10-24) to `70470ba8` (2026-10-29), listed in `inputs/expected.json` ("Before that: ..." chain). Not all change the ABI: the 2026-10-29 handover change altered only `native-host` (`3c0610ff` to `5c513580`), with `abi`, `module-a.so` and `libsprout-native.so` unchanged.
- A runtime-only patch can still change app code: sproutboat-packages #141 left a 100-program sample identical but changed Risulta, "five internal names one higher after a prelude function was added" (`PORFFOR-UPGRADE.md`, `narrow` tier). So a recompile cannot be skipped by reasoning about what changed; requalify measures it.
- Qualification cost (`PORFFOR-UPGRADE.md`, tiers table, "wall clock (requalify, this Mac)"): `host` about 2.5 min with smokes; `prelude` 1 min with a warm admission cache, about 20 min cold (the 1,024-program corpus is 15.5 min); `porffor` 7 min warm, about 22 min cold; plus the 1,000-app density gate on othello for promotions.
- Per-app compile is "about 4 seconds" (`README.md`), 1.37 s median in the Stage A measurement (issue #1, A-table), admission compiles 4 programs at a time.
- The platform's rollback promise is the opposite: "a sprout is an immutable native binary, and `rollback` can reactivate one built arbitrarily long ago" (`CONTRACTS.md`). With 25 retained versions per project, a rollback target can be several generations old.
- sproutd's own roadmap already lists the missing piece: D-1 "Compile service and runtime-generation registry; side-by-side generations; rolling upgrades" (issue #1, open).

### 3.2 Schemes

**S1. Rebuild on the server.** Control stores the generated JS of every deployment (not only the binary). A new generation triggers a background recompile of each active version (and of a rollback target on demand), admits it, then deploys. Cost: a compile service (needs Zig, Porffor, python3 and the pinned inputs on the host or on a build box), a changed artifact contract, 4 s times the number of versions to rebuild (parallelism 4 in admission today), and a decision about apps that stop admitting under the new generation (they stay on the old one, or fail). Benefit: one generation live at a time, single daemon, lowest steady memory, server-side compile also closes D3.

**S2. Side-by-side generations.** One sproutd daemon per live generation, each with its own port, admin socket and `STATE` (or a shared one), and the router (edge, option A) picks the daemon from a per-deployment `generation` field. New deploys go to the newest; old deployments stay where they are until redeployed or force-migrated; a generation is retired when nothing is pinned to it. Cost: fixed memory per extra daemon (**unmeasured**; the 73 MiB figure is 1,000 idle apps, not a base), a security-patch obligation on every live generation, and `handover` only works within one generation and port. Benefit: no recompile on upgrade; rollback to an older version works while its generation lives. The daemon config has a single `runtime` directive today, so S2 is N daemons, not one daemon with N runtimes (the fork server holds one template).

**S3. A stable ABI.** Split app code from the runtime so that a runtime fix does not require recompilation. The evidence points the other way: app units embed prelude-derived functions with generated names (`_23func_cache_3022` renumbered to `_23func_cache_3023` is treated as a change that escalates the tier), and the build asserts that an app does not change the runtime's shared code. A stable ABI would be Porffor-level work with no estimate I can support. Not recommended as a plan; worth a research issue.

**S4. Dual artifact with the supervisor path as the fallback.** The CLI keeps building the standalone binary (immutable, self-contained, today's contract) and additionally uploads the generated JS. The platform runs the binary under the supervisor until the server has compiled a module for the current generation and admitted it, then moves the project to sproutd. Rollback always has a runnable artifact. Apps that never admit, or that are CPU-heavy (D-5), stay on the binary. Cost: both paths stay in the product permanently (broker, egress unit, supervisor, bubblewrap) and artifacts get larger.

### 3.3 Proposal

A combination, offered for the user to accept or change: **S4 as the contract, S1 as the engine, S2 limited to two generations as the upgrade mechanism.**

- Control stores the generated JS beside the binary for every deployment (retention same as versions).
- A compile service builds `app.so` for the current generation on deploy, and for old versions lazily on rollback.
- At most two generations run (current and previous). A promotion starts the new daemon, recompiles active deployments in the background, moves each when its module admits and its smoke check passes, then retires the old daemon. A project that fails to admit stays on the previous generation until the next promotion, at which point it falls back to the binary on the supervisor.
- Promotion follows sproutd's existing tiers: a `host` tier release (native-host only) never needs a new generation, only a `handover`.

Trade-offs of this proposal: it is the most machinery of the options; it needs the CLI to upload extra bytes; and its steady-state memory is higher than S1 alone during a promotion window. Its advantage is that no step can strand a project: every state has a runnable artifact, and rollback keeps working.

## 4. Gaps in sproutd before it can carry production

Checklist. "Evidence" is where the claim comes from; "Status" is my reading of it.

- [ ] **Throughput.** Benchmark `docs/benchmarks/api-challenge-2026-10-29.md` (platform PR #318, merged): on one pinned othello core, sproutd (generation 8154c609) holds 1,600 req/s at 510 CPU us/request; standalone holds 4,600 at 210; sproutd is 1,269 us/request on `/feed` against standalone's 649. sproutd PR #67 (open, `benchmarks/queue-and-cost-2026-10-29`): per-app queue 32 to 1,024 with a 0.5 s wait limit, collect every 8th reply; held rate 2,600 req/s (3/3 trials, p95 154 ms, p99 215 ms, 370 us/request), 3,000 fails 0/3 with p95 1,412 ms and no 503s; the worker saturates near 2,800. Standalone at 3,000: 3/3 at 254 us. Caveats stated in both: one host, not behind Caddy or the edge, no per-app uid, `memory-mb 1024`, median of 3. About 18 syscalls per feed request against standalone's 7.5. Status: partly closed; 57% of standalone's held rate on this app, and the real projects' offered load is **unverified**.
- [ ] **CPU limits.** `cpu.max` / `cpu.weight` not set (`native-host.cpp:273-298`; issue #1, C1). Per-request CPU budget and the 2 s hog kill exist (`README.md`, "Limits"; `limits-smoke`). A tenant can use a full core of the shared box until its request budget trips. Status: open, by the user's decision "not yet".
- [ ] **`connect()`.** Not implemented on any transport; the build rejects it. Design only: `docs/design/01-tcp-sockets-and-hyperdrive.md`. Status: open; affects any app using `cloudflare:sockets` or a Postgres/MySQL driver (such apps already cannot run on the platform today).
- [ ] **`crypto.subtle`.** Digest, HMAC and PBKDF2-SHA-256 only today; full surface in sproutboat-packages #222 (open, in progress, compat date 2026-11-06 placeholder). That PR states it was not scored on sproutd, did not run `requalify.sh --tier prelude --repro` or the 1,000-app density gate, and leaves the broker transport at `NotSupportedError`. Status: open. The platform's broker transport has the same gap, so this is not a regression of moving.
- [ ] **Parity scores** (`PARITY.md`, against miniflare or workerd): W2 Web APIs 206/208; KV 49/50; D1 57/64 (PR #61 open: 99/106 standalone, 98/106 broker); R2 48/48; DO 93/105 plus RPC 17/17 (PR #65 open); Queues 41/46 (PR #63 open); service bindings 53/53 on the platform, none between sproutd apps; Cloudflare's published examples 26 of 41 identical (37 expected with the next runtime, per the PARITY.md gate text; current figure unverified), and the 95% gate on a larger corpus not reported there; A5 49 admitted, 3 build failures (`test/requal-expected.json`); `nodejs_compat` refused at build, WebAssembly absent, Cache API partial. Status: mixed; no score equals 100%, and the platform's own scores on the same suites are in the same PRs for comparison.
- [x] **Zero-drop restart.** Listener handover between daemons (sproutd #64, merged): `benchmarks/reload-2026-10-29`: 200 restarts plus 100 app reloads with 4 keep-alive clients, 175,607 requests, 0 failed; 50 + 50 on the previous host: 7 failed and 150 retries; 1,000-app density gate A,B,A,B passes. App deploys, rollbacks and SIGHUP never dropped a request (`docs/operations.md`). Caveat: othello's conntrack table filled during fresh-connection load runs; unrelated to sproutd per the README.
- [ ] **Observability.** Per-app log and tail with request outcomes exist; console lines are not tied to requests; the tail `request` event lacks ttfb, bytes and cold start that the dashboard charts use (`docs/metrics-roadmap.md`); no metrics export (no `metrics` or Prometheus string in `native-host.cpp`, README or docs; the fields returned by `list` were not checked, **unverified**); no per-app CPU or memory usage reporting found. Status: open for dashboard parity.
- [ ] **Multi-tenant security review.** sproutd's own gate: "Untrusted code must not run before Stage C" (`STAGE-A.md`); C7 (internal red-team with two adversarial tenants) open; E2 (external review) open; seccomp is a denylist (C3); fuzzing covers HTTP, admin lines, not yet worker frames or the egress protocol (C9); per-tenant egress policy open (C2); user namespaces undecided (D2). What exists: probes with a control build that shows each probe can fail (`isolation-2026-10-18`, `d2-uids-2026-10-19`, `c4-signal-scoping-2026-10-18`). Status: open. For a single-admin box running the admin's own apps the bar is a user decision (section 7).
- [ ] **Linux-only and host constraints.** x86-64 Linux only; kernel floors, cgroup delegation and ambient capabilities in section 2.8; a per-platform build flow does not exist (B1). Local development and CI on macOS keep needing the standalone path (`infra/README.md`, "Local development"). I found no packaged release or install flow for generations (the repo is "Private", README), and no LICENSE file at the sproutd root, so how a self-hosted install obtains the runtime is **unverified** and is decision 2.
- [ ] **Account-level shared resources** (#74 on the platform, sproutd #17, design only). Without it, projects that share a D1/KV/R2 cannot migrate.
- [ ] **Service bindings between apps** (B5). Same effect.
- [ ] **Backup API** (section 2.5).
- [ ] **Memory density holds only at the gate.** The 1,000-app run fits 1.5 GiB since generation 10ba133b, after a period where it did not (`PARITY.md`, "Apps per small server"; issue #32 still open). Irrelevant at a few dozen projects, relevant to the stated goal.

## 5. Migration plan for existing deployments

Principles: per project, opt-in, reversible until a soak window ends, data copied never moved, the supervisor path kept.

### 5.1 Dual-run

- Run sproutd as a new unit on othello next to the edge (new user, delegated cgroup, `uids` range, `boot lazy`), bound to loopback on its own port, config managed by control through the admin socket. Capacity on othello is a real constraint: it is a 2 vCPU, 3.8 GiB host that also runs benchmark processes (seen in `ps`), and the edge unit's 2500M cap would sit beside sproutd's workers. Whether sproutd goes under a cap of its own is part of the unit design (decision).
- Control gets a per-project `runtime` setting: `sprout` (default) or `sproutd`. The route entry carries a `backend` field the edge uses to choose the upstream; the same hostname serves either.

### 5.2 Opt-in and cutover, per project

1. Eligibility check: no service bindings, no shared resource (#74), admits against the current generation, memory fits the limit, no `nodejs_compat`. Show the reason when ineligible.
2. Compile on the server, `deploy` to sproutd under the project id, with limits and secrets mapped. Smoke-request through a private hostname.
3. Quiesce writes (suspend the old route, 503 with `Retry-After`), snapshot the project's SQLite files with `VACUUM INTO`, copy them into `STATE/ID/`, re-own on first start, verify (`quick_check`, row counts), flip the route. Window length is **unmeasured**; it grows with data size.
4. Keep the old files and the old artifact for the soak window.

### 5.3 Data migration from broker SQLite files

The mapping, from `broker.ts` and `transport-embedded.js`:

| Broker side                                                              | sproutd side                                           |
| ------------------------------------------------------------------------ | ------------------------------------------------------ |
| `resources/<kv id>.sqlite` (or per-broker db)                            | KV tables in `STATE/ID/store.sqlite`                   |
| `resources/<d1 id>.sqlite`, `brokers/<digest>/d1/<name>.sqlite`          | `STATE/ID/d1/<BINDING>.sqlite`                         |
| `resources/<r2 id>.sqlite` + blobs                                       | R2 metadata in `store.sqlite` + `r2-blobs/<hash>.blob` |
| `resources/do_<id>.sqlite`, `resources/<store>.do-sql/CLASS/<id>.sqlite` | DO storage and SQL in `store.sqlite`                   |
| queue state                                                              | `store.sqlite`                                         |

D1 is the easy case (user tables copy as is, subject to the schema question in 2.5). KV, R2, DO and queues need a converter between two different on-disk layouts, which does not exist; writing it is the largest new item in the plan. Its correctness check can reuse the parity suites (read the same keys back through the binding API on both sides).

### 5.4 Rollback

- Before the soak ends: flip the route back to `sprout`. The old files are untouched. Writes made on sproutd after cutover are not in them. Options: accept the loss window (cheapest), copy back on rollback with the same converter in reverse, or keep D1 captured (LTX, one D1 per app, blue/green unsupported) for a restore (decision).
- After the soak: delete the broker-side copy only on explicit confirmation, never automatically.
- Platform-level: `sbctl update` rolls control and edge as today; the sproutd unit and its generations update on their own track, and the `handover` restart keeps sockets. A bad generation is rolled back by pointing the router at the previous daemon (S2).

### 5.5 What users see

- URLs, DNS, certificates, custom domains: unchanged.
- Faster cold starts for reaped apps (5 to 7.6 ms for real apps against a fresh process plus a broker wait), and scale to zero by fork; the platform's own cold-start number is not in a benchmark I read.
- New or changed error surfaces: `503 app queue full` after 1,024 queued or 0.5 s of waiting (after #67), `429` with `Retry-After` under a rate limit, `exceededCpu` / `exceededWallTime` outcomes, a 32 MiB default memory ceiling, `x-sb-cpu-ms` per request from compat date 2026-11-02.
- Logs: per-app console in `STATE/<id>.log` with 8 MiB and 7 day rotation; `sproutboat tail` and the dashboard keep working through control; a `sproutd:` line source for crashes and budget kills.
- New capabilities: `split` gradual deploys with `Cloudflare-Workers-Version-Key` affinity, `suspend`, per-app `rate`.
- Anything gated on a compat date stays as the app was built; the migration itself changes no `compatibility_date` behaviour.
- Release notes follow `docs/versioning.md`: an operator action and a section under "Breaking and operator actions" for the first release that ships the sproutd unit.

## 6. Expected wins and risks

### 6.1 Wins, with sources

Only numbers from existing files. None is a measurement of the platform's current sprout-plus-broker path under the production edge, which no file I read contains; they compare sproutd to standalone or workerd, or state the platform's own recorded constraints.

| Claim                                              | Number                                                                                                      | Source                                                                    |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Idle PSS per app, 1,000 apps, gate A/B runs        | 1.44 to 1.47 MiB (idle PSS 1,435 to 1,467 MiB for 1,000 apps)                                               | `sproutd/benchmarks/reload-2026-10-29/README.md`                          |
| 1,000 active apps in a 1.5 GiB cap                 | peaks 1,343 to 1,347 MiB at generation 10ba133b                                                             | `sproutd/PARITY.md` ("Apps per small server")                             |
| Idle and active memory of one app, API challenge   | sproutd 21 MiB RSS (10 PSS) idle, 24 (13) after the mix; standalone 7 (7) and 11 (11)                       | `docs/benchmarks/api-challenge-2026-10-29.md`                             |
| Platform's recorded cost per deployment today      | "~10 MB per (sprout + broker + bwrap)", the old 1G cap OOM'd at about 80 to 100 deployments                 | comment in `infra/systemd/sproutboat-edge.service` (not a benchmark file) |
| Broker memory under DO SQL                         | about 40 MB with 64 small open databases, about 175 MB with 64 databases of 4 MB read in full               | `CHANGELOG.md` (Durable Objects `ctx.storage.sql` entry)                  |
| Scale to zero                                      | 1,000 deployed and all reaped: 72.7 MiB of scope                                                            | `sproutd/STAGE-A.md`                                                      |
| Cold start                                         | 5 to 7.6 ms median for real apps, p95 up to 15 ms                                                           | `sproutd/STAGE-A.md`                                                      |
| Deploy                                             | hot swap 12.8 ms median, first correct response 32.8 ms (compile excluded); no request dropped across swaps | issue #1 A-table; `docs/operations.md`                                    |
| Restart                                            | 0 failed of 175,607 requests across 200 restarts and 100 reloads                                            | `sproutd/benchmarks/reload-2026-10-29`                                    |
| Cost per request against workerd with Miniflare D1 | sproutd 1,269 vs 3,439 us on `/feed`; 710 vs 3,157 on a post read                                           | `api-challenge-2026-10-29.md`                                             |
| Density against workerd                            | 296 vs 503 MiB idle at 250 apps; workerd OOM-killed starting 1,000                                          | `sproutd/README.md`                                                       |

Not wins, per the same files: CPU-heavy code is about 5x slower than V8 (`README.md`); throughput of a single hot app is below standalone (section 4); workerd rows use Miniflare's D1 shim, which the benchmark itself says does not represent production Cloudflare.

Qualitative wins from reading the code, no number attached: the platform stops restarting every app when the edge restarts; versions, rollback and gradual deploys are in the host; the broker, the egress unit and bubblewrap leave the path of migrated projects; the sandbox no longer needs unprivileged user namespaces.

### 6.2 Risks

- **Generation churn.** A repeat of 13 promotions in six days against a platform that promises old rollbacks (section 3). Mitigated by the proposal; not eliminated.
- **Two runtimes forever.** Local development, ineligible apps and the cheaper-alternative fallback keep the supervisor, broker and egress unit alive, so maintenance goes up before it goes down.
- **Security.** Moving user code into a shared-runtime host with no red-team or external review (section 4). A native `app.so` loaded by `dlopen` in a process that shares the template's pages is a different attack surface from a bubblewrapped binary; sproutd's mitigation is OS-level, not language-level.
- **A compile service on the production box** brings Zig, Porffor and python3 into a host that today "builds nothing" (`infra/README.md`: "sprouts are built by the CLI, never here"), or a separate build host to operate.
- **Privilege.** `CAP_SETUID`/`CAP_SETGID`/`CAP_CHOWN` ambient on a daemon, plus the admin socket as a tenant-wide root; the platform runs unprivileged services today.
- **Throughput headroom** on hot projects (section 4), and 503s instead of latency when the queue limit trips (the benchmark's own observation).
- **Backup and restore regress** until sproutd has a snapshot path; this is the most data-critical item.
- **Shared host.** othello is also the benchmark host; dual-run adds memory and CPU contention in production.
- **Unmeasured costs**: the edge hop in option A, a permanent tail consumer, per-daemon base memory in S2, the cutover window.
- **Private dependency.** sproutd is private and "not ready for outside users" (`README.md`), while the platform is installed by anyone with `install.sh`.

## 7. Phased plan and open decisions

### 7.1 Phases

Effort is my estimate in engineer-weeks for one person who knows the code, not a measurement, and excludes external review time.

| Phase                      | Content                                                                                                                                                                                                                                         | Exit                                                                                                          | Estimate                                     |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| 0. Measure and decide      | Decisions below; production inventory (projects per binding kind, shared resources, request rates from control metrics, memory per deployment); sproutd behind Caddy and the edge on othello with the real mix; broker memory baseline with PSS | numbers for the unverified items; decisions 1 to 6 answered                                                   | 1 to 2                                       |
| 1. Skeleton                | sproutd unit and unit file; control admin-socket client and reconcile; `runtime` project setting; edge `backend` routing (option A); secrets and limits mapping; `deploy`/`rollback` from control for a hand-built module                       | a test project served by sproutd through the real edge, rollback works, `sbctl update` does not touch sproutd | 3 to 4                                       |
| 2. Compile and generations | generated-JS upload (additive contract), compile service, two-generation promotion, admission fallback to the supervisor                                                                                                                        | a promotion drill: new generation, background rebuild, no dropped request, rollback across generations        | 4 to 6                                       |
| 3. Operations parity       | backup verb or root helper plus `sbctl restore`; tail adapter and metrics fields; per-owner filtering; storage converter (KV, R2, DO, queues) with a parity check; retention alignment                                                          | backup, restore and migration of a real project round-trip with the parity suites green                       | 4 to 6                                       |
| 4. Closing gaps in sproutd | shared resources (#17) and service bindings (B5) if decision 6 says so; CPU cgroup limits (when the user lifts "not yet"); throughput work (#67 and beyond); `crypto.subtle` (#222) and `connect()` per priority                                | gate list in section 4 reviewed item by item                                                                  | unestimated here; owned by sproutd's tracker |
| 5. Security gate           | C7 red-team, C3 allowlist, C9 worker-frame and egress fuzzing, E2 external review, per decision 5                                                                                                                                               | written outcome                                                                                               | calendar-bound                               |
| 6. Pilot                   | internal projects opt in, two-week soak, rollback drill, then new projects default to sproutd, existing ones opt in                                                                                                                             | no data loss, no regression in dashboard metrics                                                              | 2 to 4                                       |

Phases 1 to 3 total about 11 to 16 engineer-weeks by these estimates, before phases 4 and 5.

### 7.2 Open decisions (for the user; none is made here)

1. Is the goal served by the cheaper alternative (standalone artifacts under the supervisor, section 1.3), by sproutd, or by both in sequence?
2. Scope and distribution: self-hosted single-admin installs, the managed cloud, or both? sproutd is private; should `install.sh` ever fetch it, and under what licence?
3. Artifact contract: allow an upload of generated JS and compile on the server (D3), keep CLI-built binaries only, or support both (S4)?
4. Generation policy: how many generations live side by side, how long a retired generation's rollbacks must work, and whether an app that stops admitting falls back to the supervisor or is frozen.
5. Security bar: may migrated projects run before C7 and E2 (for example admin-owned projects only), or only after?
6. Shared resources and service bindings: build them in sproutd, or exclude such projects from migration?
7. Edge: option A, B or C (section 2.3), and whether dashboard metrics may lose ttfb, bytes and cold start under B.
8. Admin socket: relax the file mode, add a local authenticated adapter, or run control as the same user; who enforces per-owner isolation on `tail` and `deploy`.
9. Backups: a sproutd `backup` verb, a root-run helper, or LTX for D1 only; the recovery point you require.
10. Data cutover rollback: accept loss of writes made on sproutd, copy back, or keep captured D1.
11. Defaults: 32 MiB worker memory against today's behaviour, version retention (10 against 25), and who owns `versions-keep`.
12. Throughput bar: the sustained req/s per project sproutd must hold before a project may migrate, and whether the queue-limit behaviour (503 instead of latency) needs a compat date.
13. CPU limits: keep "not yet" for the pilot, or require `cpu.max` first.
14. Dashboard: show runtime and generation, and offer self-service migration, or keep it an operator action.

### 7.3 Unverified

- Production inventory: number of projects, binding kinds in use, shared (#74) resources, service bindings, request rates, memory per deployment. `/var/lib/sproutboat` and `/etc/sproutboat` are not readable to the inspecting user; whether `SPROUTBOAT_SPROUT_CGROUP` is on in production is unknown (the repo unit says off).
- Throughput and cost of the current sprout-plus-broker path behind the production edge: no file I read measures it.
- Whether broker-written SQLite files (schema, internal tables) open unchanged in the embedded transport, and R2 blob layout compatibility.
- Whether `app.so` embeds an ABI digest that a mismatched generation would reject at load.
- Base memory of an extra sproutd daemon (S2); cost of a permanent `tail *` consumer; cost of the edge hop in option A.
- Behaviour of secrets with newlines in `NAME=VALUE` files.
- Fields returned by `list`; whether any metrics export exists beyond what the README and docs describe.
- Open PRs (#61, #63, #65, #67 on sproutd, #222 on packages) are cited as their authors describe them; none was re-run.
- sproutd licence and release packaging: no LICENSE file or install flow found.
- Effort estimates in section 7.1.

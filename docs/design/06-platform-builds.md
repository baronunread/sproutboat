# Design 06: Platform builds for sproutd

Status: proposal. One measurement (section 7) and one probe (section 6) were run for this document; nothing else here was built. Anything I could not check is marked **unverified** and collected in section 11. The design leaves open product questions (section 10), so no code accompanies it.

Sources (read at these heads): platform `sproutboat` origin/main 4f4376f (`apps/control/src/sproutd-deploy.ts`, `sproutd.ts`, `deployments.ts`, `infra/`, `install.sh`, `docs/design/` and design 05 from PR #324, which is still open); `sproutd` origin/main d43b5db (`build/build.ts`, `compile-app.ts`, `scan-dynamic-compatibility.py`, `deps.ts`, `inputs/`, `deploy/README.md`, `docs/`, CI from #77); `sproutboat-cli` origin/main 5a76551 (v0.51.0: `src/main.ts` deploy, `build.ts`, `compile.ts`, `bundle.ts`, `standalone-build.ts`); `sproutboat-packages` main 08d0192 (`packages/runtime/src/wrap.ts`). Nothing ran on othello and nothing was deployed.

## Summary

Today a developer who wants a sproutd module has to run `sproutboat build --standalone`, then clone sproutd and run `bun build/compile-app.ts GENERATION PROJECT out.so` against the exact generation the box runs, then upload `module` (and, for the #335 fallback, the supervisor artifact too). The CLI does none of that yet. A generation changes about every few days, and a module built for another one is refused at load (`abi_rejected`).

Proposal, in the model the user chose (Cloudflare's): the CLI uploads a **source bundle plus a small build description**, control **queues a build on the box**, runs a stable open tool, `sproutd-build`, in a sandbox against the generation that box runs, admits the resulting module, and records the deployment. When `sbctl update` installs a new generation, control rebuilds every active sproutd version from the stored bundle itself; users never rebuild.

The five decisions that carry the design:

1. **Upload the bundle, not the generated JS.** `compile-app` already throws away the CLI's copy of the shared prelude and splices the application part onto the generation's own (section 2), so uploading `sprout.generated.js` works today. But its application part is written by the CLI's wrapper, and a stored one cannot be rebuilt against a generation whose prelude expects something new. A bundle plus `build.json`, wrapped by the generation's own pinned wrapper, can.
2. **One tool, `sproutd-build`, with a JSON result and fixed exit codes**, living in the open sproutd repo. Self-hosted control and a future build farm run the same binary on the same inputs.
3. **The generation and toolchain live in `/opt/sproutd/generations/<abi16>/`**, side by side, installed by `install.sh` and `sbctl update` and activated by symlink. The toolchain (Zig, pinned inputs, Bun, python3) is installed once, by the same installer.
4. **Builds run in a queue of one**, under a dedicated unprivileged user with a systemd scope (memory, CPU, tasks, wall time) and no network, cached by an input hash. The deploy has the states `building`, `ready`, `fell back`, `failed`.
5. **Tenant code reaches the C compiler.** The probe in section 6 shows a bundle's `Porffor.c` template literal is passed to `zig cc` verbatim and can read files at compile time. On a shared box that is the main risk, and the sandbox has to be a real one, not an unprivileged user alone.

Measured on the Mac (section 7): a hello app compiles in 4.4 s, a `postgres` driver app in 56 s, at about 0.9 to 1.0 GB peak resident set; a generation builds in 145 s at 2.4 GB. The driver app's time is the C link step, not the Porffor compile, so a small box needs a timeout in minutes, not seconds.

## 1. Today

- **Developer machine.** `sproutboat deploy` bundles the handler (`bundleHandler`, Bun), wraps it with the runtime prelude (`wrapNativeFetchHandler`), compiles a native `sprout` with Porffor and Zig, and uploads `manifest`, `sprout` and sidecars (`bindings`, `assets_manifest`, `asset`) (`src/main.ts:561-590`). `build --standalone --emit-only` stops after writing `sprout.generated.js` and needs no native toolchain (`src/standalone-build.ts:55-58`).
- **Control.** For a project with `runtime: sproutd`, `POST /deployments` takes `module` (an `app.so`), or the supervisor artifact with `sproutdRefusal`, and loads the module through sproutd's adapter. A module sproutd refuses runs on the supervisor if the upload carried `manifest` and `sprout` (#335). Routing is per deployment (`vid` present means sproutd) (`apps/control/src/sproutd-deploy.ts`).
- **sproutd.** `build/build.ts` builds a generation from pinned inputs; `build/compile-app.ts GENERATION PROJECT|GENERATED.js OUT.so` compiles one app: Porffor to C, an ABI comparison against the generation (`abi_rejected` lists what changed), then `zig cc` links the module. It is Bun plus python3 plus Zig. Admission results are cached by generation key and program hash under `$SPROUTD_CACHE/admission`.
- **The box.** `install.sh` says it plainly: "The server only runs deployments (under bubblewrap) - it never builds them" (`install.sh:184`). sproutd is "private, staging only", not installed by `install.sh`, and `sbctl update` never restarts it (`infra/README.md`, `sproutd/deploy/README.md`). The generation lives by hand at `/opt/sproutd/generation`.
- **Sources.** artifact-v1 says an upload "never contains source code" (`docs/artifact-v1.md`). The proposal breaks that for sproutd projects (section 10, Q3).

## 2. What the CLI uploads

### 2.1 The generated JS is two pieces

`wrapNativeFetchHandler` (`sproutboat-packages` `wrap.ts:165`) emits the prelude, then `globalThis.__sbCompat = ...`, `__sbAppName`, optional `__sbAssets`, `env` (the baked `vars`), the version-metadata binding, `__sbInstallFetch()`, `__sbInstallBindings(env, bindings)`, the user's bundle inside a function, and the `export default { fetch }` shim. sproutd's `build/sync-prelude.ts` cuts the same file at the `__sbCompat` marker to make `inputs/shared-prelude.js`, and `scan-dynamic-compatibility.py` (`program()`) cuts every uploaded `generated` file at the same marker and replaces everything before it with the template's prelude. So the prelude part is already the generation's, never the developer's. The application part is a pure function of: bundle source, `vars`, bindings, compatibility date, app name, baked assets, version metadata.

### 2.2 Options

| Option          | Upload                                                                                      | Rebuild on a new generation                                                                                                                                                                            | Cost                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| A               | `sprout.generated.js` (0.7 MB for hello, 1.2 MB for a `postgres` app, mostly prelude)       | works only while the CLI's wrapper still matches the new prelude's expectations (the wrapper calls `__sbInstallBindings`, `__sbEntry` and so on); **unverified** across the 13 promotions in design 05 | bytes dominated by a prelude the server discards; wire format is the CLI's private business                                    |
| B (recommended) | `bundle` (the handler after `bundleHandler`) plus `build` (JSON) plus the existing sidecars | the server wraps with the wrapper pinned in the generation, so a runtime change that changes the wrapper is absorbed                                                                                   | the generation must carry `wrap.ts`; sproutd's `sync-prelude.ts` already imports it from sproutboat-packages and can vendor it |
| C               | project source tree                                                                         | the server bundles too                                                                                                                                                                                 | needs Bun plus npm resolution on the server, and arbitrary `postinstall`-class risk; no                                        |

Option B stays an Option-A superset: `sproutd-build` also accepts `--generated FILE` (what `compile-app` takes today), which keeps the tests, the corpus and hand builds working.

### 2.3 Upload format (multipart, additive)

New fields on `POST /api/projects/:project/deployments`, for a project whose runtime is `sproutd`:

| Field                      | Content                                                                                                   |
| -------------------------- | --------------------------------------------------------------------------------------------------------- |
| `bundle`                   | `bundle.js`, the single ESM file the CLI produces today, at most 8 MiB (a `postgres` app is about 0.5 MB) |
| `build`                    | `build.json`, v1: `{ v: 1, name, compatibilityDate, vars, cli: { version, runtime, toolchain } }`         |
| `bindings`                 | existing `bindings.json` sidecar (KV, D1, R2, queues, DO, services...)                                    |
| `assets_manifest`, `asset` | existing sidecars; the server bakes them into `__sbAssets` as the CLI does                                |

Everything the compile depends on is in these fields, so the build is deterministic given a generation: `inputHash = sha256(generationAbi, sproutd-build version, wrapper digest, bundle, canonical build.json, bindings, assets manifest)`. Version metadata (`env.<binding>`) is derived by the server from that hash, not from a client-side artifact digest. I checked that the module is byte-identical across repeated compiles on one machine (section 7); I did not check across machines or different checkout paths.

Compatibility date: sproutd's generation manifest gains `compat.max` (the newest date its prelude implements). A build with a later date is refused up front (400, before queueing) rather than silently running without the feature. The CLI already refuses dates its own runtime does not know.

`module` stays accepted (hand builds, tests, #325 phase 1) and so do `manifest` plus `sprout` (supervisor). Field precedence on the server: `module`, then `bundle`, then the supervisor artifact alone.

### 2.4 Is the supervisor artifact still built on the client?

It is today's fallback contract (#335), and it costs the developer a native Porffor and Zig build, which is what this change exists to remove. Options in section 10, Q1. Recommendation: not by default. The CLI uploads the bundle only; the server builds a supervisor artifact itself (`sproutd-build --target supervisor`, a later phase, same input) only if the project opted into `fallback: "supervisor"`. A failed build leaves the previous version serving, which blue/green already gives.

The CLI side needs one new command shape: `sproutboat build --emit-bundle DIR` writes `bundle.js`, `build.json`, `bindings.json` and the assets, with every source and config check a build runs (it is `emitGenerated` minus the wrapping), and `deploy` for a sproutd project calls it and uploads the result. The CLI must learn that a project is sproutd from `GET /api/projects/:project/runtime`, which exists.

## 3. The build tool, split out of sproutd

`build/compile-app.ts` is already most of it. What is missing is a stable contract. Findings from reading it:

- It writes scratch under `ROOT/out/` (`compile-app.ts:36`, `scan-dynamic-compatibility.py`, `pack-compatibility-proof.py`), so it cannot run from a read-only install tree. Needs `--work DIR` or `$SPROUTD_WORK`.
- The admission cache is `$SPROUTD_CACHE/admission` (4.2 GB on the measuring Mac after corpus runs). Needs a size cap and an `--no-cache` flag; the python scanner has the latter already.
- The link step throws an uncaught error with a stack on failure (observed with the probe in section 6: no JSON, exit 1). Only the Porffor compile stage is reported as `compile_failed`.
- Python is used for scanning and packing. Fine for now; the interface should not expose it.

### 3.1 Entry point

```
sproutd-build app --generation DIR --out FILE.so --work DIR
              ( --bundle FILE --build FILE [--bindings FILE] [--assets DIR]  |  --generated FILE )
              [--no-cache] [--cache DIR] [--jobs N] [--timeout-s N] [--json]
sproutd-build generation --out DIR [--allow-new]       # today's build.ts
sproutd-build info --generation DIR                    # abi, runtime version, compat.max, tool version
```

Shipped as `bin/sproutd-build` (a shim that `exec`s `bun build/cli.ts`), with `build/compile-app.ts` and `build/build.ts` kept as thin aliases for a release. One JSON object on stdout, diagnostics on stderr. Output on success:

```json
{
  "status": "admitted",
  "out": "app.so",
  "bytes": 355752,
  "abi": "6fced0a5...",
  "inputHash": "...",
  "sha256": "...",
  "tool": "1",
  "compileMs": 1705,
  "cached": false
}
```

### 3.2 Exit codes

| Code | Status              | Meaning                                                                   | User-visible                                                      |
| ---- | ------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 0    | `admitted`          | module written                                                            | yes                                                               |
| 10   | `compile_failed`    | Porffor or the C link failed; `diagnostic` has the compiler's first lines | yes, as the build log                                             |
| 11   | `abi_rejected`      | the app changes the generation's shared code; `changed` lists which parts | yes, with a hint to report it                                     |
| 12   | `input_invalid`     | malformed bundle, `build.json`, bindings; compat date above `compat.max`  | yes                                                               |
| 20   | `timeout`           | exceeded `--timeout-s`                                                    | yes                                                               |
| 21   | `resource_exceeded` | killed by the sandbox for memory                                          | yes                                                               |
| 2    | usage               | bad flags; never user-visible                                             | no                                                                |
| 70   | `internal_error`    | tool bug, missing generation, disk full                                   | no: operator log; the deploy is retried once then marked `failed` |

`abi_rejected` and `compile_failed` keep the meaning they have in `compile-app` today (README, "compile an app into a module"; control's `loadRefusal` matches `rejected`). The distinction matters because 11 can clear on its own with the next generation and 10 cannot.

### 3.3 What stays in sproutd and what a farm reuses

sproutd keeps: the generation build, `sproutd-build`, the wrapper snapshot, the ABI check, the host. Control keeps: queueing, sandboxing, caching policy, states. A build farm runs `sproutd-build app` inside its own isolation on its own machines with the same arguments; nothing in the tool assumes the platform. The tool does not do network access, uploads, or process supervision.

## 4. Where the generation and toolchain live

```
/opt/sproutd/
  generations/<abi16>/      generation tree: manifest.json, compiler/, app-0/ (template), native-host/
  current -> generations/<abi16>
  toolchain/                zig-<ver>/, pinned archives (bearssl, sqlite), bin/sproutd-build
  deploy/                   adapter, units
/var/lib/sproutboat/builds/ work dirs (per build, deleted), cache/ (input hash -> module), inputs/ (stored bundles)
```

- **Size.** The generation I built is 331 MB (`native-host` 131 MB, three template apps of 46 MB each, `a` and `b` 29 MB each); only part is needed to compile (the template `app-0`, `compiler/`, `manifest.json`, `native-host/module-a.so`). A `--slim` install of a compile-only generation is a phase 1 item. Zig 0.16.0 unpacks to 403 MB (arm64 macOS; the x86-64 Linux size is **unverified**). Expect roughly 0.7 GB for one generation plus toolchain, 1.0 GB while two generations live.
- **Install.** `install.sh` gains a step, off unless the installer is told sproutd is wanted (Q2). It installs `python3` (plus the packages it already installs) and fetches a _release tarball_ of sproutd (generation, `sproutd-build`, pinned Zig and archives, with SHA-256s), not the source tree. This needs sproutd to publish releases; it is private today with no LICENSE file (Apache-2.0 is planned), so open-sourcing is a precondition.
- **Update.** `sbctl update` stages the release the way it stages the platform (`infra/sb-update`), verifies digests, unpacks to `generations/<abi16>` beside the old one, and does not switch anything. It then tells control (admin API, or a marker file in the activation directory as for #141) that a new generation exists. Control runs the rebuild (section 5). Only after that does it run the daemon switch. A `host`-tier release (native-host only, same ABI) keeps the generation directory name, because the ABI digest is unchanged, and needs only a `handover`.
- **Rollback of the base.** The previous generation directory stays until nothing pins it, then `sbctl` removes it (keep two, as design 05 section 3.3 proposes).
- `sbctl update` never touches `/var/lib/sproutboat`; the builds directory is under it, owned by control.

## 5. Build execution in control

### 5.1 Queue

One build at a time on a small box (concurrency is `SPROUTBOAT_BUILD_CONCURRENCY`, default 1; the 56 s link step is single-threaded, so 2 on a 4-core box is reasonable and is a Cloud knob). A SQLite table `builds(id, owner, project, input_hash, generation, state, queued_at, started_at, finished_at, result_json)` in control's database; the queue survives a control restart (a build found `running` at startup is requeued). Order: user deploys first, rebuilds on upgrade second, FIFO inside each class. Caps: queued builds per account (default 3) and a global queue length, answered 429, so one account cannot starve the rest.

### 5.2 Sandbox

A build is untrusted code reaching a C compiler (section 6). Per build, `systemd-run --scope` or a transient service with:

- an unprivileged system user `sproutboat-build` (no shell, no home), distinct from `sproutboat-control` and `sproutd`, with no access to `/var/lib/sproutboat` except the one work directory it is handed;
- `MemoryMax=2G`, `MemorySwapMax=0`, `CPUQuota=100%` (one core), `TasksMax=256`, `RuntimeMaxSec=300` (the 56 s driver build leaves a 5x margin; measured on an M-series Mac, so **unverified** on a small VPS);
- `PrivateNetwork=yes`, `PrivateTmp=yes`, `ProtectSystem=strict`, `ProtectHome=yes`, `NoNewPrivileges=yes`; read-only access to `/opt/sproutd` and the system libraries; read-write only `builds/<id>/`;
- `IPAddressDeny=any`, no environment except `PATH` and `TMPDIR` (the scanner already passes only those to the Porffor child).

The limits above are my numbers, derived from section 7 and not from a Linux run: they are Q4. In the self-hosted default control can instead run `sproutd-build` under the existing bubblewrap launcher (`infra/sandbox/sprout-sandbox.sh` pattern) when `systemd-run` is not usable.

### 5.3 Cache

`inputHash` (section 2.3) keys `cache/<hash>/app.so` plus the result JSON. A hit skips the queue and the sandbox: redeploying an identical bundle is instant, and control already short-circuits `unchanged` by module digest. Entries are evicted LRU to a size cap (default 2 GB; modules are 0.4 to 4.5 MB, so this is thousands). The sproutd admission cache stays inside the sandbox work area per build or is mounted read-only from a shared warm copy; a shared writable cache is a cross-tenant channel and is not allowed. Rejections are cached too (the same input will be rejected again), which also blunts repeated hostile input.

### 5.4 Deploy states

The CLI today waits for one response. Builds can take a minute, so `POST /deployments` for a bundle returns `202` with a deployment id and `state: "building"` (queue position included), and the CLI polls `GET /api/projects/:project/deployments/:id` (it already lists and gets deployments). With `--no-wait` it returns at once.

| State       | Meaning                                                                                                                                   | Serving                         |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `queued`    | waiting for the build slot                                                                                                                | previous version                |
| `building`  | `sproutd-build` running                                                                                                                   | previous version                |
| `ready`     | admitted by sproutd, routed                                                                                                               | this version                    |
| `fell back` | build or load failed and the project opted into a supervisor fallback; runs on the supervisor with the reason (the #335 `fallbackReason`) | this version, on the supervisor |
| `failed`    | `compile_failed`, `abi_rejected`, `input_invalid`, `timeout`; log kept                                                                    | previous version                |

The dashboard row reads the state and shows the build log for `failed`. The first four states are columns on the deployment record; `failed` deployments are kept for the log and not counted in `versionsPerProject`.

## 6. Multi-tenant security: compiling untrusted code

**Probe (run on the Mac, section 7 setup).** A bundle whose handler file contains

```js
Porffor.c`
#error HOSTILE_C_REACHED_THE_C_COMPILER
`;
```

passes the CLI's `build --standalone --emit-only`, passes the Porffor compile and the ABI check, and fails in the link step with `worker.js.<hash>.c:36:2: error: HOSTILE_C_REACHED_THE_C_COMPILER`. So the tenant's text is part of the C that `zig cc` compiles. A second probe replaced the `#error` with `#include "/etc/hosts"`: the compiler's error output contained the file's lines. Compile-time file read is therefore real, and a build failure message that is shown to the user would return the content. (`.incbin`, `__asm__`, `#include` of `/proc` and so on are the same primitive; I did not test them.) Neither the CLI nor the patched Porffor refuses `Porffor.c` in user code (`rg 'Porffor\.c'` over CLI `src/` finds only the CLI's own use).

What follows, in order of preference:

1. **Reject `Porffor.c`, `Porffor.asm` and the other Porffor-internal template tags in user code at the bundle level.** `sproutd-build` scans the bundle (and the CLI refuses it too) and returns `input_invalid`. The wrapper's own use is outside the bundle, in the generation's wrapper, so it is unaffected. This is a denylist in front of a trusted compiler, so it is not the security boundary, but it closes the documented path.
2. **The sandbox of 5.2 is the boundary**: no network, no other files, a work directory the build user owns and nothing else, resource and time limits. A `zig cc` that reads `/etc/hosts` reads the build namespace's `/etc/hosts`; add a mount namespace with a minimal root (bubblewrap exists on every install already) so there is nothing to leak.
3. **Sanitise diagnostics.** The log shown to the user is the compiler's first lines with absolute paths stripped, capped at 4 KiB; the full log stays operator-side. Do not return raw compiler output.
4. **The output is untrusted too.** The module is loaded by sproutd, whose own sandbox (Landlock, seccomp, per-app uid) is its security story, and sproutd's gate says untrusted code must not run before its Stage C is finished (design 05 section 4, open). Platform builds do not make that better or worse; they do make "who compiled it" the platform, not the tenant, which removes the case where a tenant hands over a hand-built hostile `.so` (`POST` with `module` is then restricted to the admin).
5. **Supply chain.** A bundle can name any npm package; the CLI resolves them on the client, so the server never runs `npm`, `bun install` or a `postinstall`. This is a reason to reject Option C.
6. **Denial of service.** Limits and queue caps above; the cached rejection; per-account build budget per day (Cloud knob).

The self-hosted single-admin case (the admin's own apps) can run with 1 and 2 only. Whether non-admin accounts may build at all on a self-hosted box before a review is Q5.

## 7. Measured costs

Method: Apple Silicon Mac (8 cores, 16 GiB), macOS 24.3, Bun 1.4.4, Zig 0.16.0 (cross-compiling to x86-64 Linux). Every command ran as `lockf -k /tmp/sproutd-mac-build.lock /usr/bin/time -l ...`; nothing ran on othello. The generation is sproutd origin/main d43b5db (`6fced0a5`, the candidate; it matched `inputs/expected.json`). Apps were generated by the CLI at 5a76551 (`build --standalone --emit-only`, compat date 2026-11-17): `hello` is a one-line handler; `pgapp` imports `postgres` 3.4.5 and runs one query. "Peak RSS" is `time -l`'s maximum resident set size, which is the largest process in the tree, not the sum.

| Step                                            | Wall               | Peak RSS | Output        |
| ----------------------------------------------- | ------------------ | -------- | ------------- |
| `build.ts` (a generation, cold archives cached) | 145 s (237 s user) | 2.4 GB   | 331 MB tree   |
| `compile-app` hello, cold admission cache       | 4.4 s              | 0.90 GB  | 356 KB module |
| `compile-app` hello, warm admission cache       | 4.4 s              | 0.93 GB  | same          |
| `compile-app` pgapp, cold                       | 56.8 s             | 1.02 GB  | 4.5 MB module |
| `compile-app` pgapp, warm admission cache       | 55.6 s             | 1.01 GB  | same          |

Observations:

- The reported `compileMs` is 1.7 s (hello) and 2.3 s (pgapp): that is the Porffor-to-C stage only. The rest of pgapp's wall time is the link of a 4.5 MB module (`zig cc -O3 -shared`, `build-dynamic-apps.ts`), which is single-threaded (59 s user for 56 s wall). I did not time the stages separately, so "the link is about 50 s" is inferred.
- The admission cache did not change wall time here because it saves only the Porffor stage; the link always runs. The cache that matters for the platform is the module-level one in 5.3.
- Three compiles of hello (two by project directory, one from the copied generated file with `--name`) produced the same SHA-256 (`cf93c63a...`). Different output paths, same bytes.
- `design 05` quotes "about 4 seconds" and 1.37 s medians; that matches hello and the Porffor stage, and not a driver app. Driver apps are the case a timeout has to fit.
- Not measured: an x86-64 Linux build box (a 1 to 2 vCPU VPS will be slower than 8 Apple cores, possibly several times), two concurrent builds, and RSS summed over the tree.

## 8. Rebuild on a base upgrade

A daemon holds one template, hence one generation (design 05 section 3.2), so a module for generation N cannot load into a daemon on N-1. A per-app swap inside one daemon is impossible. The mechanism is the two-generation window design 05 proposed, run by control:

1. `sbctl update` installs generation N+1 beside N (section 4). Nothing serving changes. Control learns of it.
2. Control starts a second daemon on N+1 (own port and admin socket, same `STATE` so app data is shared; SQLite WAL permits it, and the existing zero-drop restart already overlaps two daemons on one state directory). **Unverified**: the two-daemon overlap on one state directory is supported for same-generation handover, not tested across generations (design 05 section 3.2 says handover only works within one generation and port). A spike is phase 3's first item.
3. Control enqueues a rebuild for every active sproutd deployment from the stored `bundle` and `build.json` (class "rebuild", lower priority than user deploys; rollback targets lazily on demand). A module whose `inputHash` includes N+1's ABI is a new cache key.
4. As each module is admitted by the N+1 daemon, control sets that deployment's route `backend` to the N+1 daemon (routing is already per deployment, so this is the same switch `activateSproutd` makes). The N module keeps serving until then. A failed build or admission changes nothing for that app.
5. When all active apps are on N+1, or after a deadline (default 24 h), the N daemon drains (`SIGTERM`) and retires.
6. Per-app failure policy (Q6): the app stays **pinned** on N until the deadline, then follows the project's fallback: the supervisor if it opted in and an artifact exists, otherwise it keeps its last good state as `stale` and the owner is told; it is not silently stopped.

States for the dashboard: `rebuilding` (queued or building for N+1), `migrated`, `pinned on N` with the reason.

Expected failure rate: design 05 and the requalification record show 1,024 corpus programs admitted with 0 rejected and 49 of 52 real apps admitted, so a rebuild rejection will be rare but not zero (a prelude change can alter an app's internal names without changing behaviour, per `PORFFOR-UPGRADE.md` as quoted in design 05). Time: with concurrency 1 and a mix of hello-like (4 s) and driver (56 s) apps, 100 apps is 7 to 90 minutes. The sizes of the deadline and of the queue are what keep this safe on a small box.

## 9. What moves to the closed Cloud later

Open (sproutd and the self-hosted platform): the `sproutd-build` tool and its contract, the generation build, the control queue, sandbox profile, cache, rebuild-on-upgrade and the states. Closed (Sproutboat Cloud): the multi-host build farm (it runs `sproutd-build` with its own scheduler and isolation, for example a microVM per build, which is the right answer to section 6 for strangers' code); a global content-addressed cache across hosts; fleet-level generation rollout across many boxes and canary of a new generation; per-account build budgets and billing; abuse detection on submitted bundles. The seam is the tool's inputs, outputs and exit codes (section 3), plus the `builds` table's states (section 5), which the farm replaces with its own scheduler.

## 10. Open product questions

Each has a recommendation; none is decided here.

**Q1. Is the supervisor artifact still built on the client?** (a) Always, as #335 today; keeps the fallback guaranteed, keeps the native toolchain requirement on dev machines. (b) Never; a failed build stays failed, the previous version serves. (c) Opt-in per project (`fallback: "supervisor"`), and built by the server from the same bundle in a later phase. Recommendation: **(c)**, defaulting to (b). It removes the client toolchain for the common case and keeps a safety net where it is asked for.

**Q2. Self-hosters without sproutd.** Platform builds only matter to projects that use sproutd, but installing the toolchain costs about 0.7 to 1.0 GB of disk, python3, and a build user, and the compile step needs several hundred MB of RAM. Options: (a) `install.sh` always installs it; (b) install only when asked (`SB_SPROUTD=1`), and `sbctl update` upgrades it only if present; (c) never, builds only on a separate build host. Supervisor-only installs must see no change in packages, units, memory or behaviour. Recommendation: **(b)**, with `sbctl sproutd enable` to add it later. Also requires sproutd's open-sourcing first (Apache-2.0 and a release tarball), so `install.sh` never clones a private repo.

**Q3. Upload format and compatibility.** (a) `bundle` plus `build.json` (this document), additive; `module` and supervisor uploads keep working, so an old CLI against a new server and a new CLI against an old server (the server rejects `bundle` with a clear 400 and the CLI falls back to telling the user to upgrade the platform) both behave. (b) Generated JS. (c) Both. This also decides source retention: the platform now stores the user's bundle, contradicting "an upload never contains source code" (artifact-v1), and the bundle is in backups. Options: keep bundles for the retained versions only (25), encrypted at rest with the existing `secrets.key`, or hash-only after a successful build (which gives up rebuild). Recommendation: **(c) with (a) as the CLI default**, bundles kept for the retained versions, encrypted at rest, and artifact-v1's sentence amended for sproutd projects.

**Q4. Resource limits.** My proposal is 2 GB memory, one core, 300 s, 8 MiB bundle, 3 queued builds per account. They come from a Mac run. Options: take them as defaults and expose `SPROUTBOAT_BUILD_*` overrides; or measure on the intended smallest box first. Recommendation: **ship the defaults, flagged as unverified, and measure on a 2 vCPU 4 GB Linux VM in phase 2 before enabling for non-admin accounts.** The box memory minimum then becomes a documented number (I would say 2 GB free for builds).

**Q5. Who may build on a shared box.** The probe shows compile-time file read. Options: (a) admin-owned projects only until the sandbox review; (b) all allowed owners (today's `SPROUTBOAT_SPROUTD_OWNERS`); (c) builds only on a dedicated host (the Cloud model). Recommendation: **(a) until phase 2's hostile-build tests pass, then (b) with the section 5.2 sandbox.** `SPROUTBOAT_SPROUTD_OWNERS` already gates this.

**Q6. App that stops admitting on a new generation.** (a) pinned on the old generation until a deadline, then fall back or stale; (b) fall back at once; (c) fail the upgrade for everyone until fixed. Recommendation: **(a)**, deadline 24 h, notify the owner.

**Q7. Rollback across generations.** An old version's module is for an old generation. Options: rebuild on rollback from the stored bundle (queue wait before it goes live), or keep modules for both live generations only and rebuild for older ones. Recommendation: rebuild on demand from the bundle and say "building" on the rollback, with the retained module used when its generation is still live.

## 11. Phased PR plan

| Phase | Repo           | PR                                                                                                                                                                                                                                                                                                                                                                                                                   | Exit                                                                                                                             |
| ----- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 1     | sproutd        | `sproutd-build` entry point: `app`, `generation`, `info`; `--work`, `--cache`, `--timeout-s`, `--json`; exit codes of section 3.2 including link failures as `compile_failed`; `Porffor.c` and friends rejected as `input_invalid`; docs; tests in CI (#77): unit tests for the argument parser, the exit-code mapping on stub failures and the hostile fixture, plus an end-to-end hello build on the CI generation | CI green; `compile-app.ts` still works as an alias                                                                               |
| 1b    | sproutd        | vendor `wrap.ts` with `sync-prelude.ts`; `--bundle`/`--build` inputs; `compat.max` in the generation manifest; LICENSE (Apache-2.0, user's call)                                                                                                                                                                                                                                                                     | same hash from `--generated` and `--bundle` for the same app (test)                                                              |
| 2     | platform       | control: `builds` table and queue, sandbox launcher, cache, states, 202 plus polling, `bundle` field handling, rebuild hooks stubbed; fake `sproutd-build` for tests (as `sproutd-fake.test-util.ts` does for the adapter)                                                                                                                                                                                           | deploy of a bundle on a staging box (`tools/sproutd-staging.sh`) reaches `ready`; hostile-bundle tests; limits measured on Linux |
| 3     | platform       | `install.sh` and `sbctl update`: toolchain and generation install, activation, `generations/` layout; rebuild on upgrade and the two-daemon window (spike first)                                                                                                                                                                                                                                                     | an upgrade drill: new generation, background rebuild, no dropped request, a forced rejection pins the app                        |
| 4     | sproutboat-cli | `build --emit-bundle`, `deploy` for sproutd projects uploads it, polls the state, prints the build log; `--fallback supervisor` opt-in                                                                                                                                                                                                                                                                               | an end-to-end deploy from a developer machine with no Zig installed                                                              |
| 5     | platform       | dashboard states and build log; `sbctl builds` (queue, cancel); retention and encrypted bundle storage                                                                                                                                                                                                                                                                                                               | Q3 policy in place                                                                                                               |
| later | Cloud (closed) | farm, global cache, fleet rollout, budgets                                                                                                                                                                                                                                                                                                                                                                           | n/a                                                                                                                              |

Merge order: sproutd 1 and 1b first (they are independent of the platform), then platform 2 and 3, then the CLI. The CLI change can ship before platform 3 behind the project's runtime flag, since the server rejects `bundle` for non-sproutd projects.

### Unverified

- Compile time, memory and the 5.2 limits on any Linux machine; two concurrent builds; the size of Zig for x86-64 Linux.
- Whether a stored `sprout.generated.js` (Option A) rebuilds across the generations promoted so far; I argued against it by design, I did not test it.
- Module byte-identity across machines or different generation checkout paths (identical on one Mac across three runs).
- The two-daemon overlap on one state directory across different generations.
- Whether an `install.sh` that installs the toolchain stays within the memory a supervisor-only box needs at idle (it should: nothing runs between builds).
- Whether `.incbin`, `__asm__` and `/proc` reads behave as `#include` did; only `#error` and `#include "/etc/hosts"` were run.

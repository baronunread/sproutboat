# 03. D1 read replicas via LTX

Status: design proposal, 2026-10-28. No code changed. Repos read: `sproutboat-packages` at `wt-pkgs-main` (9fa3a2d, clean, includes #139; written `packages/...`), `sproutd` main (b4abbef, includes #6), `sproutboat` at `wt-sb-pins` (b0db7e1). Nothing was run.

## Summary

LTX capture already yields an ordered, checksummed, immutable log of every committed D1 write plus a restorable base. That is the right substrate for read replicas: ship files to another node, apply them in order, serve reads locally, forward writes to the primary. Cloudflare's Sessions API maps cleanly if a bookmark is `(epochSeq, TXID)`. The hard parts are not the stream: they are a safe page-apply path on the replica, cross-host single-writer fencing, retention, and an epoch ordering the stream lacks today. Recommendation: embedded transport only (sproutd first), pull-based with a host-side relay, async replication, operator-triggered promotion in v1. Not the broker.

## Current state

- Enablement: compat date 2026-10-22+, `SB_LTX_ENABLE=1`, `SB_LTX_DATABASE=<binding>` (`packages/runtime/LTX_REPLICATION.md:5-9`; `packages/runtime/src/transport-embedded.js:1156-1167`). sproutd sets them from `capture ID DB` (`sproutd/docs/bindings.md:446-450`). Broker D1 is plain WAL SQLite with no capture (`packages/wire/src/d1.ts:166`).
- Written: one LTX v3 file per WAL commit from `wal_hook` (`transport-embedded.js:670, 795-809`); a write batch is one file (`sproutd/docs/bindings.md:472`). Header: 100 bytes, magic `LTX1`, page size, commit page count, TXIDs, ms timestamp, pre-apply checksum, WAL range and salts (`:444-456`). Pages are literal-only LZ4, so no shrinkage (`LTX_REPLICATION.md:32-35`). Trailer: post-apply database checksum plus file CRC64 (`:490-511`). Database checksum is the XOR of per-page CRC64s over page number and bytes (`:352-356`).
- TXID and position: TXIDs count from 1 per generation and are not application transaction ids (`LTX_REPLICATION.md:28-30`). The base snapshot is TXID 1 (`transport-embedded.js:583-640`); each commit is `txid+1` with `preApply` equal to the previous post-apply (`:447-450, :783`). The cursor is a CRC-protected `position` file, `LTXPOS2`: epoch, W/C state, TXID, salts, WAL offset, checksum (`:539-565`).
- Where: `<db>.sqlite.ltx/epoch-XXXXXX/<min16hex>-<max16hex>.ltx` (`:522-529`; `sproutd/docs/bindings.md:460-466`), written to `.tmp`, fsynced, hard-linked with no replace (`LTX_REPLICATION.md:56-70`). Epoch names come from `mkdtemp` (`:607`): random and unordered. Mismatched state on restart starts a new epoch with a fresh base and TXID 1 (`LTX_REPLICATION.md:104-117`).
- Snapshot vs incremental: snapshot is checkpoint TRUNCATE, `BEGIN`, raw page reads (`:583-640`); incrementals are the per-commit files, then a checkpoint after the statement resets (`:826-842`).
- Restore: offline only. The vendored routine (`sproutboat-cli` worktree `wt-cli-strings`: `vendor/ltx-restore/restore.ts.txt:22-72`, built with `--with-restore`, `src/surface.ts:100`) replays single-TXID files 1..N, checks TXID, pre-apply continuity, page order, each post-apply checksum, then a physical checksum. It refuses to overwrite a database.
- Retention: none. No uploader, compactor or backup API (`LTX_REPLICATION.md:134-135`; `sproutd/docs/bindings.md:483`). The spool counts toward quota, and over quota every write is refused (`sproutd/docs/bindings.md:104-110`; `transport-embedded.js:2196`).
- Constraints: capture forces `locking_mode=EXCLUSIVE`, so no second connection or process can read the primary file (`LTX_REPLICATION.md:13-16`; `:1127`). The only writer guard is a host-local `flock` (`:1229`). Hook failure latches the DB closed (`LTX_REPLICATION.md:84-87`). Blue/green with capture is unsupported (`sproutd/docs/bindings.md:476`).
- D1 surface: `withSession()` is a stub returning the database, with `getBookmark()` returning `null` (`packages/runtime/src/native-fetch-prelude.js:5508-5518`). Transaction SQL is refused (`:5356-5364`). Wire ops are `d1.query|exec|batch|backup` (`packages/wire/src/broker.ts:1598-1601`; `transport-embedded.js:4769-4787`). Read-only classification already uses `sqlite3_stmt_readonly` (`:2196`). The edge is an HTTP proxy over a route snapshot and never sees SQL (`sproutboat: services/edge/src/main.ts:120-123`).

## Design

Cloudflare semantics (developers.cloudflare.com/d1/best-practices/read-replication, fetched today): `withSession("first-unconstrained")` is the default and may start on any replica; `"first-primary"` starts on the primary; a bookmark string starts at a version at least as new, and the replica waits to catch up. `getBookmark()` returns the position after the last query. Guarantees: monotonic reads and writes, writes follow reads, read-your-writes. All writes go to the primary. The page does not specify bookmark format, expiry, wait timeout or batch routing; those are our choices.

**Bookmark.** Opaque `sb1.<epochSeq>.<txid hex>.<mac>`. Prerequisite: add a monotonic `epochSeq` to the position record (LTXPOS3), since epoch names are unordered. Write replies carry `meta.ltx = {epochSeq, txid}` (one TXID per batch). Reads carry the head the answering node had applied. A bookmark from an older epoch is served by the primary only; that is always correct because a fresh base contains every acknowledged commit, and the reply returns a current bookmark.

**Transport.** Pull over mTLS using node-enrollment identity. A host-side relay in sproutd, outside the app sandbox and read-only on the spool, serves `head` (epochSeq, last TXID, timestamp), immutable `epoch/<n>/<txid>.ltx`, and a long-poll `wait?after=N`. Files are atomically published and never replaced, so there is no coordination with the writer. Standalone binaries have no listener and would need an opt-in endpoint.

**Bootstrap and apply.** The follower fetches the TXID 1 snapshot, applies it to a temp file with the restore routine's checks, swaps it in, then streams 2..N verifying file CRC, pre-apply continuity and post-apply checksum. Any mismatch, or a vanished epoch, triggers re-bootstrap. The replica's app worker owns the file (one process per app), so it applies between requests: pwrite pages, truncate to `commit`, reopen the connection, mmap off.

**Read-only enforcement.** Reads use `SQLITE_OPEN_READONLY`, `PRAGMA query_only=ON` and an authorizer denying writes, ATTACH and write PRAGMAs. Apply is the one place the file changes. This is the biggest unknown: whether reopen-per-apply is cheap and safe is untested. Spike first; fallback is applying into a second file and swapping atomically.

**Routing.** The edge is unchanged: it sends the HTTP request to the nearest node running the app. The D1 shim classifies each statement with `sqlite3_stmt_readonly`: read-only runs locally, anything else is forwarded to the primary over an authenticated write endpoint. `batch` is a transaction, so one non-read statement sends the whole batch to the primary; an all-read batch runs locally. `exec` forwards if any line writes; `RETURNING` and effectful PRAGMAs forward. Session logic: `first-primary` forwards its first query; a bookmark makes the replica wait (default 2 s, our choice) then fall back to the primary; after a primary query the session holds the new bookmark for monotonic reads. Wire: add `session` to `d1.query|batch|exec` and `meta.ltx`, `served_by_primary`, `served_by_region` to replies; gate by compat date.

**Lag.** Count: primary head TXID minus applied TXID. Time: now minus the applied file's header timestamp (`:449`), plus the head-poll time so an idle primary is not shown as lagging.

**Failover and fencing.** Today's `flock` fences one host. Add a per-(app, DB) writer lease in the control plane with a monotonic fencing generation recorded in the epoch. The primary stops acknowledging writes when it cannot renew within TTL; relay and forwarder reject stale generations. Promotion: the replica applies all reachable files, starts a new epoch (existing fresh-base path) under the new generation. A returning old primary discards its state and re-bootstraps as a replica. Replication is async, so promotion can lose the unshipped tail; the product must say so. TTL fencing assumes bounded clock drift on enrolled nodes, which is unverified.

**Retention.** Keep the current epoch's snapshot plus later files; cut a new snapshot (new epoch) at a size or age threshold; drop old epochs once no follower or backup needs them. It must be accounted against the quota.

**Per transport.**
- sproutd: spool at stable paths, relay in the daemon, follower in the replica worker, config like `replica ID DB from NODE`. First target.
- standalone: same embedded code, but no daemon or control plane: manual lease, opt-in listener. Defer.
- broker: no capture, pooled non-exclusive connections. Not in v1; later by capturing in `d1.ts`.

## Candidate engine: Turso (Rust SQLite rewrite) as D1 engine

Evaluated 2026-10-28 from the README, `COMPAT.md` and the GitHub API (github.com/tursodatabase/turso; raw.githubusercontent.com/tursodatabase/turso/main/COMPAT.md). Nothing of ours was changed.

**Verdict: do not adopt for D1 now; re-check at 1.0.** The three things our LTX plan leans on are marked unsupported in COMPAT.md, and the engine is pre-1.0.

- **Linkability.** Turso targets the SQLite 3.50.4 C API, the same version we vendor (`sproutd/build/deps.ts:86`, compiled with `-DSQLITE_THREADSAFE=0 -DSQLITE_OMIT_LOAD_EXTENSION` at `sproutd/build/build-native-host.ts:45`). Our host declares `sqlite3_*` by hand and calls it from the transport C (`sproutd/inputs/transport.js.txt:148-149, :1152, :1231`); the broker uses `bun:sqlite` with a custom libsqlite3 (`sproutboat-packages/packages/wire/src/d1-sqlite.ts:4-8`). A Rust cdylib or staticlib would add the Rust runtime to a binary that is C today. COMPAT.md lists the C API as partial: `sqlite3_create_function*`, collations, backup, blob I/O, serialize and `sqlite3_db_config` are unsupported or stubbed.
- **Gaps against our D1 surface.** Unsupported: `sqlite3_wal_hook`, commit and update hooks (LTX capture, `transport.js.txt:1152`), `sqlite3_set_authorizer` (the read-only enforcement in design 03), `sqlite3_create_function` (our `sb_sql_budget`, `packages/wire/src/d1-budget.c:62`), extension loading, all `sqlite3_vtab_*`. `sqlite3_progress_handler` works only for step callbacks. FTS3/4/5 are absent; a Tantivy `CREATE INDEX ... USING fts` replaces them, without `snippet()`. JSON is nearly complete. Unsupported PRAGMAs include `foreign_key_check`, `data_version`, `optimize`, `secure_delete`, `mmap_size`, `journal_size_limit` (we set it, `:118`); `locking_mode` is EXCLUSIVE only; `wal_checkpoint` takes no mode, yet our conformance uses `wal_checkpoint(TRUNCATE)` (`sproutd/conformance/bindings/d1.js:135`). I did not diff the remaining d1.js cases, so the list above is a floor.
- **Concurrent writes (design 02).** MVCC `BEGIN CONCURRENT` is experimental and COMPAT.md lists same-connection hazards (deferred commit, possible silent rollback). It does not help us: sproutd keeps one JS thread and one SQLite connection per app, so the writer is never contended; bindings block the loop regardless. Gain only appears with a helper-thread option, which design 02 defers.
- **Replication.** Turso's sync is its own protocol (a `sync/` crate; I did not read its design, so frame format and server needs are unverified). It is not LTX, so our checksummed `.ltx` spool, restore routine and `(epochSeq, TXID)` bookmarks would be replaced, not reused. Mixing SQLite and Turso on one file in multi-process use is unsupported, which blocks a gradual migration.
- **Maturity and license.** README: not yet 1.0, full compatibility is a 1.0 requirement, keep independent backups. Releases are frequent (v0.8.3 on 2026-10-12, v0.9.0-pre.1 on 2026-10-15), which also means churn. License MIT (API `license.spdx_id`).
- **Footprint at 1,000 apps.** Unmeasured. Our budget is about 1.5 MiB per app; embedded SQLite is tuned with `cache_size=-2000` and zero lookaside. Turso has no equivalent known knobs (`soft_heap_limit` and `shrink_memory` are unsupported), and a Rust runtime with async I/O (io_uring on Linux) plus per-DB shared state is likely heavier. Treat as unverified.
- **Experiment.** Attempted read-only on a copy of `twelve-dollar-server-challenge/seed/feed.db` (250 MB) with `@tursodatabase/database@0.8.3` under bun 1.4.4. It installed, but `connect()` failed (`db.connectAsync is not a function`, native binding not loaded under bun). Skipped further tries; no query results. Scratch deleted.

Revisit when: 1.0 ships, and hooks, authorizer, UDFs and FTS5 are supported. A cheaper spike then is the `BEGIN CONCURRENT` gain behind a helper thread, not replication.

## Alternatives considered

- Litestream-style object-store relay: simple and durable, but adds a bucket dependency, seconds of latency and cost, and is poor for self-hosting. Reasonable as a second backend of the same pull API.
- LiteFS: FUSE and Consul lease; awkward under Landlock/seccomp, and we lose control of the TXID-to-bookmark mapping.
- rqlite/dqlite: Raft gives sync replication and failover, but replaces the in-process SQLite model that gives our per-request cost.
- App-level caching: no D1 change, but staleness is the app's problem and gives no Sessions semantics.

## Risks

1. Silent corruption from page apply under live readers; mitigated by verifying every checksum and the spike.
2. Split brain if leases rely on clocks or an unavailable control plane; manual promotion can fork history.
3. A new authenticated write path into a per-app sandbox model built to be private, plus a cross-node round trip per write.
4. Spool growth freezing writes through the quota without retention.
5. Capture is synchronous with fsync per commit (`:795`), so write latency stays bound by it.
6. Unverified: Cloudflare bookmark format and wait timeout, SQLite behavior under a replaced file, clock bounds, and any measurement.

## Effort

About 10-12 engineer-weeks: (1) apply and read-only spike, 1 week; (2) relay, follower, bootstrap, lag metrics, 3 weeks; (3) classification, forwarding, Sessions shim, wire fields, 2-3 weeks; (4) LTXPOS3 epochSeq, retention, snapshot cadence, 1-2 weeks; (5) lease, fencing, operator promotion, 3 weeks including control plane.

## How to measure success

- Correctness: extend the SIGKILL harness to compare replica and primary full-database checksums at every TXID; zero divergence.
- Sessions: write, take bookmark, read from every replica, never older; monotonic reads across replica switches.
- Lag: p99 applied-TXID gap and age under sustained writes, target under 1 s same region.
- Latency: remote replica read versus forwarding to primary; write-forward cost.
- Failover: promotion time, commits lost, zero dual-writer windows in a partition test.
- Disk: spool bounded by retention.

## Open questions for the user

1. Is promotion in v1 operator-triggered (simple, honest RPO) or automatic (lease service, clock assumptions)?
2. Do we accept async replication with possible data loss on failover, or is a synchronous-ack mode required?
3. Default `withSession()`: Cloudflare's `first-unconstrained` (stale by default) or primary-first?
4. Are replicas on every node or explicit per app/database, and is this a paid tier given spool storage counts toward quota?
5. Is dropping broker support acceptable, and is standalone in scope?
6. What retention window do we promise, if the same log is to back point-in-time restore?

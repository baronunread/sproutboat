# 04. Hidden classes and inline caches for Porffor objects

Status: design, nothing implemented. Date: 2026-10-28. Evidence: Porffor checkout at `wt-sproutd-perreq/out/porffor-upstream` (HEAD `77766a6`), sproutd PRs 52 and 54, side-by-side notes on othello (`~/.local/share/sproutboat-bench/sidebyside-20261028/`; it has no README, only perf outputs, `cmp-*.out` and scripts). Paths below are relative to `compiler/` in that checkout.

## Summary

Porffor already has most of a "stage 2": compile-time key hashes, inline-stored object literals, and a per-site read cache (`__Porffor_object_get_ic`). It has no shapes. Objects are flat arrays of 20-byte entries searched linearly by 32-bit hash.

On the 12-dollar feed API, property access is small. Self time in `Porffor_object_get*`, `set*_withHash`, `hash`, `underlying*` and `appendEntry` is 2.0% (feed), 5.4% (post), 4.4% (like), 3.5% (create) of samples. Full shapes plus ICs would touch at most about 8% of the profile and save roughly 2-4% of CPU per request (low confidence). The same work is a large, invasive layout change in a fast-moving upstream.

Recommendation: do not build shapes for this workload now. Build a property-heavy microbench first, ship the cheap Stage 0 items (below) if it shows a gap, and revisit shapes only if real customer apps show property access above about 15% of CPU.

## Current state

- Object header is 16 bytes: `u16 size` at 0, `u16 capacity` at 2, flags `u8` at 4, entries pointer at 12 (`builtins/_internal_object.ts:44-53`). Entry is 20 bytes: hash `i32` at 0, key pointer at 4, value `f64` at 8, flags `u8` at 16, value type at 17, key type at 18 (`_internal_object.ts:100-105`, `readValue` ~line 180). Accessors reuse the value slot for getter and setter pointers (`_internal_object.ts:667-679`).
- Lookup is a linear scan comparing only the 32-bit hash, then a symbol path (`__Porffor_object_lookup`, `_internal_object.ts:~690-700`). There is no hash index for large objects, so `obj[k]` on a 500-key dictionary is O(n). Equal hash is treated as equal key; a collision would return the wrong property (pre-existing, not measured).
- Hash is xxh32-style over the key bytes (`_internal_object.ts:29-98`). Strings are not interned: `JSON.parse` allocates a fresh key string per key and hashes it (`builtins/json.ts:589-596`), then `__Porffor_object_define` does hash + linear duplicate scan + `appendEntry` (`_internal_object.ts:1528-1543`, `appendEntry` ~line 140).
- Compile time: `ctHash` precomputes the hash for `a.b` and literal keys (`codegen.js:3247`). Object literals with static keys emit direct stores into a pre-sized entry array, no lookups (`generateObject`, `codegen.js:4661-4720`). Computed keys, spreads and duplicates drop to `__Porffor_object_expr_*`.
- Inline cache: `Prefs.ic` is on by default (`prefs.js:1`). Each `a.b` read site gets a 4-byte cell in a data segment (256 cells per chunk, `codegen.js:~4895-4908`). `get_ic` checks `off < size*20`, compares the hash at that offset, and returns the value, else `get_icMiss` rescans and fills the cell if empty ("first writer wins", `_internal_object.ts:851-885`). It covers own data properties only. Prototype hits (methods), accessors, writes (`setStrict_withHash`) and `a[k]` always take the full path. Precompiled builtins are built with `ic:false` (`builtins_precompiled.js:2`).
- `for-in` walks the entries array directly (`codegen.js:4130-4160`). `Object.keys` loops the entries three times and runs `propertyKeyIndex` on every key (`builtins/object.ts:39-116`).
- "Hidden types" in Porffor means builtin values (Headers, Request, strings) whose real object lives in a side hash store (`__Porffor_underlyingInsertEntry`, `_internal_object.ts:~190`). `Porffor_object_underlying`/`underlyingPtr` are 0.4-0.65% each in post/like/create profiles. This is unrelated to shapes. Likewise `porf_gc_object_shape_valid` in the generated runtime is a GC pointer sanity check, not a hidden class.
- The GC scans entries one by one, 20 bytes apiece (`render.js:3505`).
- Our `patch.ts` (2,150 lines in `wt-packages-perreq`) has no object-layout patches. The layout stride 20 appears in about 70 places across `_internal_object.ts`, `object.ts`, `regexp.ts`, `array.ts`, `promise.ts`, `codegen.js`, and `render.js` (generated GC C).

### Where time goes (othello, `perf record -F 2999`, per-endpoint flat self shares)

|                                            |  feed | post | like | create |
| ------------------------------------------ | ----: | ---: | ---: | -----: |
| object get/set/hash/underlying/appendEntry |  2.0% | 5.4% | 4.4% |   3.5% |
| JSON (serialize + parseValue)              |  7.9% | 2.6% | 1.4% |   1.4% |
| memset/memcpy/memmove/malloc/free          | 15.0% | 4.2% | 3.2% |   3.8% |
| Porffor GC                                 |  6.9% | 5.0% | 2.8% |   2.2% |
| SQLite and page cache                      | 13.4% | 5.0% | 5.6% |   7.2% |

Percentages are of all samples; the flat files list only about 43-66% of them, kernel time is one unresolved bucket (24% of the mix in PR 54). `p_builtins___Porffor_json_serialize` alone is 6.6% of feed and `memset` 5.7%; those, not property lookup, are the Porffor-side costs. The D1 binding path is 32% inclusive but only about 6 points beyond SQLite (PR 54, section 4). Go's feed handler costs about 75 us user against about 390 us for ours (`cmp-*.out`, `cpu-1.out`); the gap is spread over JSON, allocation, the D1 round trip and SQLite, not property access. Caveats: lookup loops may be inlined into callers and not show under the object symbols, there is no PMU on this VM (task-clock sampling), and 5% run-to-run noise.

## Design

**Stage 0 (no shapes, local patch candidates).** (a) Intern or cache keys in `JSON.parse` and skip the duplicate scan when the previous object had the same key at the same index. (b) A lazily built per-object hash index once `size > 8`. (c) A write cache for `a.b = v` mirroring `get_ic`. (d) Prototype-hit caching for method calls.

**Stage 1: shapes.** A shape is an immutable record in static memory: ordered key list with hash, key pointer and flags, a transition table keyed by (key hash, flags), and a parent link. Object header becomes `shape pointer, values pointer, size, capacity`; values are 16 bytes (f64 + type, aligned) or split into two arrays, down from 20 bytes per entry plus a duplicated key. Adding a property follows or creates a transition; the root shape is shared. Dictionary mode: after 64 properties, any delete, any `defineProperty` with accessor or non-default flags, or more than 4 transitions out of one shape, the object gets a private shape that is a flat table (today's layout) with a mode bit. JSON output: `JSON.parse` keeps a small cache from (first key, key count) to the last shape and fills values straight in, so repeated row shapes from D1 cost one pointer compare per key. GC: scanning iterates values only, shapes live in static memory (not collected, bounded by the dictionary threshold). Fork/CoW: shapes and transitions built before the template is sealed stay shared; a transition created after fork dirties a heap page per worker, so warm-up must run the representative paths before sealing (compare worker footprint 207 KiB/app, packages 171, sproutd 34).

**Stage 2: monomorphic IC on shapes.** Cell holds (shape pointer, value offset), 8 bytes. Guard is one pointer compare, replacing today's size check plus hash compare, and extends to writes and to prototype hits via a (receiver shape, holder, holder shape) triple plus a global "prototype mutated" epoch for invalidation. Cells live in the existing data-segment chunks; they are written on first execution after fork, so pre-warm them in the template or the pages CoW per worker.

**Stage 3: polymorphic.** Up to 4 (shape, offset) pairs per site, 32-byte cells, fall back to megamorphic generic lookup via a global (shape, key) cache. Today's single-cell "first writer wins" becomes four entries.

## Alternatives considered

- **Cheaper hashed lookup, no shapes** (Stage 0b): 80% of the lookup win on large dictionaries, 5% of the code. Does not help the 20-byte-per-entry size or JSON row building.
- **JSON-specific fast paths**: key interning, a row-shape cache, a `JSON.stringify` serializer that avoids per-character calls. These target the 7.9% (feed) JSON symbols and are where most of the measured property-adjacent waste sits. Cheapest per percent gained.
- **Compile-time struct layouts for known literals**: already half done by `generateObject`. Making the literal's layout a static shape that the IC can hit without a miss is a natural Stage 1 subset, but every escape (spread, delete, computed key) needs the dictionary fallback anyway.

## Risks

- Layout change touches about 70 sites plus the generated GC C and our sproutd runtime; one missed stride is a memory-corruption bug, not a slowdown.
- Upstream churn: `_internal_object.ts` and `codegen.js` had 64 commits since 2026-08-01. A local fork of the layout would need a rebase every Porffor bump, far beyond what `patch.ts` string replacement can carry.
- Payoff may not exist for our workload (below 5% of CPU). Shapes can regress memory for small objects (shape pointer per object, transition tables) and startup (shape build before sealing).
- Hash-only equality is already unsound under collision; shapes could fix it (compare shape identity) but must not copy it.
- Not verified: actual per-site hit/miss rates, the share inlined into callers, behaviour on apps other than the 12-dollar feed, and that `ic` is enabled in the sproutd build (the `get_ic` symbol appears in the profiles, so it is).

## Effort

Stage 0: 1-2 weeks, local patches, 200-400 lines. Stages 1+2: 6-10 weeks (layout, builtins, GC, JSON, template/fork warm-up, test262 green). Stage 3: 1-2 weeks. Milestones: M0 property-heavy microbench and a customer-like SSR/transform workload; M1 Stage 0; M2 shapes behind a pref, dictionary mode, JSON row cache; M3 shape-guarded ICs for reads, writes, prototype hits; M4 polymorphic.

Speedup per stage (share of total CPU, then confidence): Stage 0, touches 3-5%, saves 1-2%, medium confidence. Stage 1, touches up to 8% (property ops plus JSON.parse plus some memset/GC from smaller objects), saves 2-4%, low. Stage 2, touches the 2-5% of reads and writes, adds 0.5-1.5% beyond the existing IC, low. Stage 3, under 0.5%, low. Total on the feed API: 3-5% (Amdahl: even removing property access entirely caps at 2-5.4% per endpoint). On property-heavy compute apps maybe 10-20%; unmeasured, low confidence.

## How to measure success

Keep the existing harness (`cmp.sh`, interleaved trials, us per request, 5% noise floor). Add (1) a microbench: 1e6 reads of 3-, 10-, 30-key objects, monomorphic, 2-shape and 6-shape sites, writes, `Object.keys`, `JSON.parse` of 1,000 same-shape rows; (2) the four endpoints with `perf` self shares of the symbols above before and after. Gate: microbench at least 2x on monomorphic reads, endpoint CPU at least 3% down at three trials, RSS and template-fork footprint within 2%, test262 unchanged.

## Open questions for the user (product decisions, ranked)

1. Is the target the feed-API class of apps (D1, JSON, HTTP), where shapes are worth about 3-5%, or CPU-bound compute apps, where they may be worth 10-20%? This decides whether to start Stage 1 at all.
2. If Stage 1 goes ahead, do you want to upstream it? It needs a Porffor PR (needs your approval; nothing has been sent) and a design discussion with the maintainer first. The alternative is a long-lived local fork of the object layout.
3. Do you accept Stage 0 local patches in `patch.ts` (JSON key interning, hash index for large objects, write cache) as the interim?
4. Is a slightly higher RSS per small object acceptable if shapes ship, against the 207 KiB/app footprint goal?

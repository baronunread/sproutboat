# Bindings v1 — design sketch

**Status: design only. Blocked on one Porffor primitive (see §4).**

## Goal

Give handlers the Cloudflare-Workers `env` surface — `env.MY_KV.get(...)`,
`env.MY_BUCKET.put(...)`, `env.DB.prepare(...)`, `env.SECRET`, outbound
`fetch()` — where each binding is implemented **host-side** and the handler only
issues calls. This decouples capability growth from Porffor's language
completeness: Sproutboat implements KV, not Porffor.

## What exists today

- `env.VAR` — non-secret `vars` from `sproutboat.jsonc`, **baked into the bundle
  at build time** as a frozen-in-spirit `const env = {…}` (issue #8, shipped).
  Read-only, static, part of the immutable artifact.
- The worker is an HTTP **server** the edge proxies to. It has no outbound
  channel: `node_modules/porffor/runtime/native-fetch.js` binds "fetch" to _your
  handler_; there is no client `fetch`, no `getenv`, no FFI escape hatch.

So anything dynamic (KV reads/writes, secrets that must not sit in the artifact,
outbound HTTP) needs the sprout to call out, which it currently cannot.

## Proposed architecture

```
handler ──env.KV.get("k")──▶ binding shim (in the bundle, prepended like the prelude)
                                   │  Porffor.hostcall("kv.get", frame)   ← the missing primitive
                                   ▼
                         unix socket /run/sproutboat/bind-<deployment>.sock
                                   ▼
                          binding broker (host process, per node)
                            ├─ kv     → SQLite table, deployment-scoped
                            ├─ r2     → local dir or S3 passthrough
                            ├─ d1     → one SQLite file per binding
                            ├─ secret → decrypt from the sealed store
                            └─ fetch  → egress allowlist, then real fetch
```

- **Binding shim**: a small JS module the build prepends (same mechanism as
  `sproutboat/runtime/prelude`). It defines `env.<NAME>` objects whose methods
  serialise a request frame and call the host primitive.
- **Wire format**: length-prefixed CBOR or JSON frames —
  `{ op, binding, args }` → `{ ok, value | error }`. Synchronous round-trip
  (matches `http-sync-v0`); an async variant waits on Porffor async support.
- **Broker**: one host process per node, listening on a per-deployment unix
  socket the supervisor creates and bind-mounts into the sandbox. The socket
  path _is_ the capability — no token needed if the socket is only visible
  inside that deployment's mount namespace. Broker enforces per-deployment
  scoping, quotas, and the egress allowlist.
- **Sandbox change**: `sprout-sandbox.sh` bind-mounts the one socket
  (`--bind /run/sproutboat/bind-<id>.sock …`) and nothing else changes;
  `IPAddressDeny=any` stays.
- **Config**: `sproutboat.jsonc` gains `kv_namespaces`, `r2_buckets`,
  `d1_databases`, `secrets`, `allowed_hosts` — shape mirrors `wrangler.toml`.
- **Manifest**: records the binding names + kinds (not values) so activation is
  reproducible and the dashboard can show what a deployment can reach.

## §4 The one dependency

The whole design needs **one** way for compiled handler code to call the host.
In rough order of preference:

1. `Porffor.hostcall(name: string, input: Uint8Array) => Uint8Array` — a builtin
   that emits an FFI call to a registered host function. Smallest, most general,
   no networking in the sandbox. **This is the upstream ask.**
2. Outbound `fetch()` limited to a unix socket / loopback — larger surface,
   needs an HTTP client in Porffor's native runtime.
3. `Porffor.env(name)` / `getenv` — only unblocks secrets, not KV/R2/D1.

Until one exists, `env.VAR` (build-time `vars`) is the entire binding surface and
this doc is a plan, not a task.

## Incremental delivery once unblocked

1. Broker process + shim + wire format + sandbox socket mount (the spike: prove
   `env.KV.get/put` end to end against SQLite).
2. KV (#14) → Secrets (#8) → outbound `fetch` + egress allowlist (#17) →
   R2 (#13) → D1 (#9) → Queues (#20) / Cron (#12).
3. Durable Objects last — needs single-threaded per-object routing in the
   supervisor, a much bigger change.

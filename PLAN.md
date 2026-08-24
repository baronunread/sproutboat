# porffor-platform

Compiled-JS edge platform. Host JavaScript functions compiled to tiny native
binaries via [Porffor](https://porffor.dev), at 50–100x lower infra cost than
Node-based serverless. Sell "instant, cheap, always-warm functions" — never
mention the compiler in user-facing copy.

## Why this works

- Porffor (v0.61.x, alpha) compiles JS AOT to ~2.6 MB native binaries using
  ~0.9 MB RAM each → ~1,100 apps per GB.
- Density is the business model: every function stays warm on cheap hardware.
  Zero cold starts, always — a feature V8-isolate platforms can't match on price.
- We don't need Porffor to run all of npm. We need it to run **webhook-class
  handlers**: API glue, bots, cron jobs. Anything else falls back to a shared
  Bun worker transparently.

## User contract (frozen early, keep tiny)

One file, Workers-style:

```js
export default {
  fetch(request) {
    return new Response("hello");
  }
};
```

- No Node APIs promised. `fetch`-style Request/Response only.
- Env vars via `env` second arg. That's the whole API surface at launch.
- This is the subset AOT compilers will always handle best, and it's familiar.

## Architecture principles (durable decisions)

1. **Compiler is a plugin.** Pipeline speaks "JS in → binary out". Porffor
   today, Static Hermes or anything else tomorrow. No Porffor internals in the
   user contract.
2. **Two-tier runtime forever.** Compiled path (cheap, dense, warm) and
   fallback path (Bun worker: compatible, costs real money). Business improves
   automatically as the compiled % rises.
3. **Differential testing gates promotion.** A handler only runs on the
   compiled path after its output matches Node/Bun on a probe suite.
4. **Sandbox from day one.** Compiled binaries are untrusted code: unprivileged
   container/jail per tenant, seccomp, rlimits, egress filtering. Not optional.
5. **One box until it hurts.** A single VPS + Caddy holds thousands of compiled
   apps. Multi-region is a later problem.

## Phases

### Phase 0 — Validate (1–2 weeks)
Harness that compiles 30–50 real webhook-class snippets with Porffor, runs
them, diffs output vs Node. Output: compatibility matrix (% compiling, failure
categories, binary sizes, startup times).
**Kill criterion:** <40% of simple handlers work even with light shims → park,
re-test each Porffor minor release (minor version = Test262 %; 0.70 = re-entry
signal).

### Phase 1 — Thinnest product (3–4 weeks)
- CLI upload (or git push) → server compiles → static binary stored →
  registered behind router.
- Router: Caddy (TLS, subdomains) → small Go/Bun router process → warm pool of
  compiled binaries; failed compiles route to shared Bun worker (tagged).
- Logs: journald + `platform logs <app>` streaming. No dashboard yet.
- **Milestone:** `curl install | sh` → live HTTPS endpoint in under 60 s.

### Phase 2 — 50 users + data moat (4–8 weeks)
- Free tier, launch on HN / Porffor community.
- Instrument everything: which handlers compile, which APIs are missing. This
  dataset (what real JS needs to run compiled) is the moat and the shim
  backlog.
- Ship top 5 shims (likely: fetch client, env, crypto basics, timers, JSON
  edges). Upstream general fixes; keep platform glue private.
- Deploy previews per branch (each preview = 1 MB warm binary — free for us,
  expensive for competitors).
- **Milestone:** 50 weekly-active handlers, >60% on compiled path.

### Phase 3 — Revenue (month 3–5)
- Free tier generous; $5–10/mo for custom domains, limits, log retention,
  secrets, cron triggers. Per-request pricing only at real scale. Price
  against Lambda/Vercel, not against our costs.
- First buyers: indie devs (bots, webhooks), then small SaaS teams.

## Risks / hedges

| Risk | Hedge |
|---|---|
| Porffor stalls (single maintainer) | Compiler swappable (principle 1); customers + compat dataset survive a swap |
| Cloudflare/Vercel copy it | They're committed to V8 isolates; wedge = warm-everything + price; own the niche fast |
| Compiled-JS correctness bugs | Differential testing gate on every deploy (principle 3) |
| Sandbox escape | Day-one jailing (principle 4); treat as a security product internally |

## 6-month "winning"

Few hundred active handlers, >70% compiled, infra <$100/mo, first paying
customers, public compat dashboard ("we run X% of real handlers natively") as
recurring marketing.

## Where to start

`TASKS.md` — ordered, snippet-sized tasks for a coding agent. Do them in order;
each has an acceptance check.

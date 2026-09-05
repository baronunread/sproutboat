<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/logo-dark.svg">
  <img src="docs/logo-light.svg" alt="Sproutboat" width="220" height="32">
</picture>

**Compile a JavaScript function to a native binary on your laptop.
Ship the binary. The server never sees your code.**

Workers-style HTTP handlers, hosted on **one Linux VPS you control**. Stable
HTTPS, immutable versions, instant rollback, live logs. No Docker, no build
servers, no vendor.

[![License: MIT](https://img.shields.io/badge/License-MIT-c8ff5a.svg)](LICENSE)
[![Compat: GO](https://img.shields.io/badge/Porffor%20alpha--4-31%2F31%20compile%20·%2029%2F31%20match-66d6ff.svg)](COMPAT.md)
[![Runtime: no Docker](https://img.shields.io/badge/server-bubblewrap%2C%20not%20Docker-f1f7f3.svg)](infra/README.md)

</div>

---

## The idea

You compile your handler **locally** with [Porffor](https://porffor.dev/) (+ Zig
cross-compile) into a single `linux-x86_64` executable. What you upload is an
**artifact**: `manifest.json`, one `sprout` binary, and any binding or asset
sidecars. Nothing else. No source, no `node_modules`, and no bundler config
leaves your machine.

```mermaid
flowchart LR
    A["src/index.js<br/>export default { fetch }"] -->|"sproutboat deploy<br/>(Porffor + Zig, on your laptop)"| B["artifact (schema v2)<br/>manifest.json + sprout"]
    B -->|"HTTPS upload"| C["control API<br/>verify · store · route"]
    C --> D["supervisor<br/>one process per deploy<br/>under bubblewrap"]
    D --> E["edge<br/>reverse proxy"]
    E --> F["https://hello.you.example.com<br/>Caddy · auto TLS"]
```

The server's job is narrow: **verify, store, route, and run** immutable
artifacts in a sandbox. It never builds anything.

## What's in this repo

The **single-machine, single-admin** deployment:

| Piece           | Path                  | Role                                                                                                                                                                                                   |
| --------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Control API** | `apps/control`        | Auth, projects, artifact intake + verification, routes, backups. Artifact-only; no source ever.                                                                                                        |
| **Edge**        | `services/edge`       | Public request path. Reverse-proxies each route to its running sprout; serves matched static assets directly; records metrics + logs.                                                                  |
| **Supervisor**  | `services/supervisor` | One long-lived native sprout process per deployment, under `bubblewrap`. Spawns a binding broker sidecar alongside it when the artifact ships `bindings.json`. Restarts on exit. No per-request spawn. |
| **Dashboard**   | `apps/web`            | React SPA Caddy serves from disk. Metrics, versions, users, backups.                                                                                                                                   |
| **Installer**   | `install.sh`          | The whole runbook: user namespaces, Caddy + bubblewrap, default-deny firewall, systemd units, one admin identity.                                                                                      |

The **CLI is its own MIT repo**,
[`baronunread/sproutboat-cli`](https://github.com/baronunread/sproutboat-cli).
It does the Porffor build and targets any control plane.

**Docs:** [sproutboat.com/docs](https://sproutboat.com/docs) is the full
reference: handler rules, every `sproutboat.jsonc` field, every binding, the
CLI, custom domains, limits. A plain-text copy for agents is at
[sproutboat.com/llms.txt](https://sproutboat.com/llms.txt).

> ⚠️ **Experimental proof of concept.** Not production-ready, not generally
> Workers-compatible. Managed cloud hosting is coming; the CLI already works
> against a hosted control plane, so nothing changes for you when it opens.

## Deploy to a VPS

SSH into a fresh Linux box (Debian/Ubuntu or RHEL-family, x86-64) and:

```sh
curl -fsSL https://raw.githubusercontent.com/baronunread/sproutboat/main/install.sh | sudo bash
#  …or, from a checkout:  sudo ./install.sh
```

It asks 3–4 questions (domain, ACME email, admin name), then runs unattended:
unprivileged user namespaces, Caddy + bubblewrap, a default-deny firewall
(22/80/443 only), the dashboard build, one admin identity, and the systemd
services. It pauses **once** for you to add a single wildcard DNS record and
waits for it to resolve.

```
Type:  A       Name:  *.example.com   (literally  *  )
Value: <your box's public IPv4>       Proxy: OFF / DNS only
```

That one record covers `control.`, `dashboard.`, and every
`<project>.<admin>.example.com` deployment. Per-hostname certs via
HTTP-01 / TLS-ALPN-01, with **no DNS API token and no wildcard cert**. Full runbook:
[`infra/README.md`](infra/README.md).

Non-interactive: set `SB_DOMAIN`, `SB_ACME_EMAIL`, `SB_ADMIN`. GitHub sign-in is
opt-in via `SB_GITHUB_CLIENT_ID` + `SB_GITHUB_CLIENT_SECRET`.

## Ship your first function

```sh
bunx sproutboat init hello
bunx sproutboat login --api-url https://control.example.com
bunx sproutboat deploy
```

A handler is a Cloudflare-style default export:

```js
// hello/src/index.js
export default {
  fetch(request) {
    const name = new URL(request.url).searchParams.get("name");
    return new Response(name ? `${env.GREETING}, ${name}` : env.GREETING);
  },
};
```

```jsonc
// hello/sproutboat.jsonc
{
  "name": "hello",
  "main": "src/index.js",
  "compatibility_date": "2026-08-26",
  "vars": { "GREETING": "hello from Sproutboat" },
}
```

`env.*` carries your `vars` (baked into the artifact), project **secrets**
(AES-256-GCM at rest, never in the binary), and storage bindings: **KV, D1, R2,
queues, Durable Objects, cron, analytics, static assets**. A KV / D1 / R2 /
queue store is an account-level resource with a stable id; `deploy` provisions
one for any bare-name binding and pins the id into `sproutboat.jsonc`, so the
data survives redeploys, and another project can bind the same id.

Also on the CLI: `build`, `check`, `deploy --dry-run | --artifact | --no-provision`,
`tail [--sprout]`, `versions list`, `rollback`, `secrets`, `resource`,
`domains` (attach your own hostname, apex included), `delete --yes`. See
[sproutboat.com/docs](https://sproutboat.com/docs).

**Immutable by construction.** Every deploy is a new content-addressed version.
Rollback re-points the route; it never rebuilds. A compile error uploads
**zero bytes** and leaves the live version untouched.

## The runtime

Porffor `alpha-4` compiles `export default { fetch }` into a
[µWebSockets](https://github.com/uNetworking/uWebSockets) server binary
(~0.42 MB for a bare handler; ~1.5 MB RSS idle; a cold start is a process exec
plus a socket bind, tens of milliseconds, then warm). The supervisor gives it a
loopback port, starts it, waits for `listen`, and restarts it if it exits. RSS stays
flat over 500k requests, so no recycle. On Linux every sprout runs under
`bubblewrap` (`sprout-sandbox.sh`): read-only filesystem, own UID, no network
except loopback to its broker; a handler's `fetch()` reaches the outside only
through that broker and only for hosts in the config's `outbound` allowlist.
A per-sprout cgroup scope caps memory / CPU / pids.

## Dashboard & accounts

`https://dashboard.<domain>`: a static SPA, no service, no port.

- **Sign in** with email + password, or GitHub (if configured). The admin's
  email is the ACME email; the admin's password is the token in
  `/root/sproutboat-admin.env` (same token the CLI uses).
- **No self-service sign-up.** `POST /api/auth/sign-up` always returns 403. The
  admin creates every other account from **Admin → Users**; those users then
  sign in with email + password or link GitHub to the same address.

## Local end-to-end

Runs the whole stack (Portless, a GitHub emulator, Control, Edge, and the
dashboard) on `*.sproutboat.localhost`.

```sh
bun install
bun run dev:local
```

Trust Portless's local CA on first run, open
`https://dashboard.sproutboat.localhost/`, sign in as the seeded `andrea`
account, reserve the `andrea` namespace, then in another terminal:

```sh
bunx sproutboat init hello
bunx sproutboat login --api-url https://control.sproutboat.localhost
# approve in the dashboard, then:
bunx sproutboat deploy
open https://hello.andrea.sproutboat.localhost
```

Reset: `Ctrl-C`, then `rm -rf .local/sproutboat ~/.config/sproutboat` and
restart. Portless certs survive.

## Compatibility harness

One question: **does the installed Porffor run enough real webhook-style
handlers to justify the supported capability profile?** The kill threshold is
40% of capability handlers matching Bun on all three probes. Compilation alone
doesn't count; behavior must match.

```sh
bun add --dev porffor@latest && bun run retest   # rebuilds report.json + COMPAT.md
```

`COMPAT.md` starts with the compiler version, compile/match counts, median
binary size, and a **GO / NO-GO** decision, then groups failures into
_compile_ / _runtime_ / _output mismatch_. To test an unpublished compiler:

```sh
PORFFOR_BIN=/path/to/porf PORFFOR_VERSION='alpha 2 (…)' PORFFOR_MODE=native-fetch bun run retest
```

Current: **Porffor alpha-4: 31/31 compile, 29/31 match** (the two misses are
`Date` parsing). See [`COMPAT.md`](COMPAT.md).

## Repository map

```
apps/control       control API — auth, projects, artifacts, routes, backups
apps/web           React dashboard (Vite + TanStack Router)
services/edge      public request path, metrics, logs
services/supervisor  sandboxed per-deploy sprout + binding-broker processes
install.sh         single-VPS provisioner  ·  infra/  systemd units + runbook
tools/             compat harness (refserve, compile, diff, report) + dev-local
tests/porffor/capabilities/   the 31-handler Porffor capability suite
docs/              artifact + bindings + runtime + capability-profile + self-hosted design notes
```

## Handy scripts

```sh
bun run dev:local     # full local stack
bun test              # apps/ services/ tests/
bun run typecheck     # tsc --noEmit
bun run lint          # oxlint (+ anti-slop plugin)
bun run style         # style-doctor (prose lint)
bun run check         # validate tools + capability-suite shape + Bun probes
bun run retest        # typecheck + test + check + diff + report
```

Use **Bun**, not npm, in this repo.

## Roadmap

Bindings work end to end: an artifact that ships `bindings.json` gets a **broker
sidecar** (from `sproutboat/runtime/broker`) on a token-gated loopback port, and
handlers see a synchronous `env` surface for **KV, D1, R2, queues, Durable
Objects, cron, analytics, secrets, outbound `fetch()`, and static assets**.
Storage bindings are account-level resources with a stable id, auto-provisioned
on first deploy ([#74](https://github.com/baronunread/sproutboat/issues/74)).
Custom domains attach with a TXT + A record, the platform apex included.
[`docs/bindings-v1.md`](docs/bindings-v1.md) is the original design sketch.

Still open: large-object / multipart R2, the Cache API, service bindings,
`ctx.waitUntil`, WebSockets (a streaming capability profile), a static-only
"pages" deploy mode, and push-to-deploy, all tracked in
[issues](https://github.com/baronunread/sproutboat/issues). Scaling past one box
waits until traffic data asks for it.

## License

[MIT](LICENSE) © 2026 Andrea Bruno

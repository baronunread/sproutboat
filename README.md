# Sproutboat

https://sproutboat.com

Workers-style HTTP handlers on one Linux box you control

## Overview

This repository contains the self-hosted Sproutboat platform: the control API,
the public edge, the supervisor that runs each deployment under `bubblewrap`,
the dashboard, and `install.sh`, which provisions all of it on a fresh VPS.

You compile your handler on your own machine. [Porffor](https://porffor.dev)
and Zig turn `export default { fetch }` into a single `linux-x86_64`
executable, and what you upload is an artifact: a manifest, one `sprout`
binary, and any binding or asset sidecars. No source, no `node_modules`, and no
bundler config leaves your laptop. The server's job is narrow — verify, store,
route, and run immutable artifacts in a sandbox. It never builds anything.

The CLI is a separate repository,
[baronunread/sproutboat-cli](https://github.com/baronunread/sproutboat-cli).
It is MIT licensed, does the Porffor build, and targets either this platform or
the hosted one.

Sproutboat is an experimental proof of concept. It is not production-ready and
it is not generally Workers-compatible. Managed hosting is coming; the CLI
already works against a hosted control plane, so nothing changes for you when
it opens.

## Installing

SSH into a fresh Debian/Ubuntu or RHEL-family x86-64 box and run:

```sh
curl -fsSL https://raw.githubusercontent.com/baronunread/sproutboat/main/install.sh | sudo bash
```

That installs the newest released version. Set `SB_REF` to pin one
(`SB_REF=v0.2.0`) or to track development (`SB_REF=main`); `sbctl update` moves
to the newest release unless you say otherwise.

`sbctl update` is safe to run through `sudo` from a normal operator account.
Its root-owned bootstrapper stages the target release outside the active
installation and then runs that staged release's installer. This lets an
installer fix apply during the same update rather than waiting for another
upgrade. The bootstrapper records the installed commit in
`/etc/sproutboat/update.env` and serializes concurrent updates.

Before upgrading, read [CHANGELOG.md](CHANGELOG.md). The public compatibility
policy and release checklist are in [docs/versioning.md](docs/versioning.md).

It asks three or four questions — domain, ACME email, admin name — then runs
unattended: unprivileged user namespaces, Caddy and bubblewrap, a default-deny
firewall, the dashboard build, one admin identity, and the systemd services.
Set `SB_DOMAIN`, `SB_ACME_EMAIL` and `SB_ADMIN` to skip the questions.

It pauses once for a single wildcard DNS record, and waits for it to resolve:

```
Type:  A       Name:  *.example.com   (literally  *  )
Value: <your box's public IPv4>       Proxy: OFF / DNS only
```

That one record covers `control.`, `dashboard.`, and every
`<project>.<admin>.example.com` deployment. Caddy issues a certificate per
hostname over HTTP-01 and TLS-ALPN-01, so you need no DNS API token and no
wildcard certificate. The full runbook is in [infra/README.md](infra/README.md).

## Using

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

`env` carries the `vars` from your `sproutboat.jsonc` (baked into the artifact),
project secrets (AES-256-GCM at rest, never in the binary), and bindings for KV,
D1, R2, queues, Durable Objects, cron, analytics and static assets. A KV, D1, R2
or queue store is an account-level resource with a stable id, so its data
outlives a redeploy and a second project can bind the same id.

Every deploy is a new content-addressed version. Rollback re-points the route
and never rebuilds, and a compile error uploads zero bytes and leaves the live
version untouched.

Full documentation is at [sproutboat.com/docs](https://sproutboat.com/docs).
A plain-text copy for agents is at
[sproutboat.com/llms.txt](https://sproutboat.com/llms.txt).

## How a deployment runs

The supervisor gives each artifact a loopback port, starts it, waits for it to
listen, and restarts it if it exits. It never spawns per request and never
recycles: RSS stays flat over 500k requests. A bare handler is about 0.42 MB on
disk and 1.5 MB resident.

On Linux every sprout runs under `bubblewrap` (`infra/sandbox/sprout-sandbox.sh`):
a read-only filesystem holding only its own artifact directory, its own uid,
private namespaces, and no network route except loopback. A per-sprout cgroup
scope caps memory, CPU and pids.

An artifact that ships `bindings.json` also gets a binding broker beside it on a
token-gated loopback port. The broker implements KV, D1, R2, queues, secrets and
outbound `fetch`, which is what keeps the sprout itself free of disk and
egress. A handler reaches the outside world only through the
broker, and only for hosts in the config's `outbound` allowlist.

## Building

Use [Bun](https://bun.sh), not npm.

```sh
bun install
bun run dev:local     # control, edge, dashboard and a GitHub emulator on *.sproutboat.localhost
bun run seed --reset  # demo accounts, projects, resources and traffic
bun test
bun run validate      # typecheck, test, capability harness, report
```

`dev:local` serves the stack over local TLS; trust Portless's CA on first run,
sign in at `https://dashboard.sproutboat.localhost/`, and deploy to it with
`sproutboat login --api-url https://control.sproutboat.localhost`. To reset,
stop it and remove `.local/sproutboat` and `~/.config/sproutboat`.

## Compatibility

The capability harness answers one question: does the installed Porffor run
enough real webhook-style handlers to justify the capability profile the
platform supports? Compilation alone does not count — behavior has to match
Bun's on every probe.

`bun run validate` rebuilds [COMPAT.md](COMPAT.md), which opens with the
compiler version, compile and match counts, median binary size, and a GO/NO-GO
decision. Porffor alpha-4 is currently 31/31 compile, 29/31 match; both misses
are `Date` parsing.

## Repository layout

```
apps/control          control API — auth, projects, artifacts, routes, backups
apps/web              React dashboard (Vite + TanStack Router)
services/edge         public request path, metrics, logs
services/supervisor   per-deployment sprout and broker processes
install.sh, infra/    single-VPS provisioner, systemd units, sandbox launcher
tools/                capability harness and the local dev stack
tests/porffor/        the 31-handler Porffor capability suite
docs/                 artifact, bindings, runtime and self-hosted design notes
```

## Bugs

Please file issues about this code on
[the issue tracker](https://github.com/baronunread/sproutboat/issues). Bugs in
the CLI belong in
[sproutboat-cli](https://github.com/baronunread/sproutboat-cli/issues).

## Contributing

Pull requests are welcome, but please file a bug first and reference it from
the commit. See `git log` for the commit message style: a lowercase scope, a
short summary in the imperative, and the issue number in parentheses.

`bun run validate` is what CI runs. Run it before opening a PR.

## Legal

Sproutboat is MIT licensed; see [LICENSE](LICENSE). It builds on
[Porffor](https://porffor.dev),
[uWebSockets](https://github.com/uNetworking/uWebSockets),
[bubblewrap](https://github.com/containers/bubblewrap) and
[Caddy](https://caddyserver.com), each under its own license.

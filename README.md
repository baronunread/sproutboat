# Sproutboat Community

[![CI](https://github.com/baronunread/sproutboat/actions/workflows/ci.yml/badge.svg)](https://github.com/baronunread/sproutboat/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/baronunread/sproutboat?include_prereleases)](https://github.com/baronunread/sproutboat/releases)

**Sproutboat Community is the single-machine, self-hosted edition of Sproutboat: Workers-style HTTP handlers, compiled on your laptop to native binaries, running on one Linux box you own, for personal projects and homelabs.**

https://sproutboat.com

You write `export default { fetch }`. The [CLI](https://github.com/baronunread/sproutboat-cli) compiles it with [Porffor](https://porffor.dev) and Zig into a single `linux-x86_64` executable and uploads an artifact: a manifest, one `sprout` binary, and any binding or asset sidecars. No source, no `node_modules` and no bundler config leaves your machine. This repository is the server side: it verifies, stores, routes and runs those artifacts under a sandbox. It never builds anything.

## What Community is

- **One machine.** Control API, request edge, supervisor, dashboard and a CLI-driven deploy flow, all on one Linux box. Capacity is the RAM and disk of that box.
- **The supervisor runtime.** Each deployment is a long-lived native process on a loopback port, started on the first request and evicted when idle. Cron, queue consumers and Durable Object alarms keep their deployment resident.
- **Homelab first.** Besides the public-VPS install (Caddy, Let's Encrypt, ufw), Community has a homelab mode: behind your own reverse proxy, on a LAN or a tailnet, with no Caddy and no firewall changes. See [docs/homelab.md](docs/homelab.md).
- **Bindings on local storage.** KV, D1 and queues are one SQLite file each, R2 objects live on the local disk (default quota 10 GiB per account, `SPROUTBOAT_R2_QUOTA_BYTES`), Durable Objects are SQLite too, and secrets are AES-256-GCM at rest. Stores belong to the account, so data outlives a redeploy.
- **Activity and webhooks.** Control records what changes on the box (deploys, rollbacks, secrets by name, domains, tokens, members, backups) and shows it on the dashboard's Activity page. Signed webhooks, with a Discord format, can deliver the same events. Deliveries leave through the egress service, which refuses private addresses.
- **Versioned and reversible.** Every deploy is a new content-addressed version. Rollback re-points the route and never rebuilds, and a compile error uploads nothing.
- **Complete, not a trial.** Community disables nothing and expires nothing. The code is MIT licensed.

## What Community is not

- **No high availability.** No replication, no failover, no second node. Missed cron ticks during an outage are not replayed. A reboot or an update takes the services down while they restart.
- **Not a scheduler for fleets.** One supervisor on one host. Community has no sproutd, no rollouts or canaries, no teams and no billing.
- **Not a hostile-code boundary.** The sandbox is defence in depth around code you trust. Do not run code from people who must not trust each other. See [SECURITY.md](SECURITY.md).
- **Not generally Workers-compatible.** It runs the capability profile the toolchain compiles. The CLI's `check` and the compatibility notes in [docs/compat](docs/compat) say what runs.
- **Not for every box.** x86-64 Linux with systemd, cgroups v2 and unprivileged user namespaces, on a VM or bare metal. Not Docker, not LXC, not arm64.

## Sproutboat Cloud

For production workloads, scale, or more than one machine, use **Sproutboat Cloud**: a separate hosted product that shares this runtime. Cloud keeps its source closed and sits outside Community. Community is a complete single-machine product, not a trial of it. Information about Cloud lives at [sproutboat.com](https://sproutboat.com); this repository promises nothing about its availability or price.

## Requirements

- Debian, Ubuntu or a RHEL-family distribution, x86-64, with systemd and cgroups v2 (the installer checks the architecture, systemd, cgroups v2 and the distribution, and refuses otherwise).
- Root, and unprivileged user namespaces (the installer enables the sysctls bubblewrap needs).
- About 4 GiB of RAM is comfortable. Half of RAM (at least 512 MiB) caps the edge and every deployment it runs. `sbctl memory` shows the budget.
- Public mode: a public IPv4, ports 80 and 443 free, and one wildcard DNS record. Homelab mode needs neither; see [docs/homelab.md](docs/homelab.md).

## Quick start

### On a public VPS

```sh
curl -fsSL https://raw.githubusercontent.com/baronunread/sproutboat/main/install.sh | sudo bash
```

That installs the newest stable release (`main` only if no release exists). It asks for a deployment domain, an email for Let's Encrypt and an admin name (set `SB_DOMAIN`, `SB_ACME_EMAIL` and `SB_ADMIN` to skip the questions), then runs unattended: user-namespace sysctls, Caddy (pinned and checksum-verified), bubblewrap, a default-deny `ufw`, the dashboard build, one admin identity, the Rust edge and egress engines, and the systemd services.

It pauses once for a wildcard DNS record, and waits for it to resolve:

```
Type:  A       Name:  *.example.com   (literally  *  )
Value: <your box's public IPv4>       Proxy: OFF / DNS only
```

That one record covers `control.`, `dashboard.` and every `<project>.<admin>.example.com` deployment. Caddy gets a certificate per hostname over HTTP-01 and TLS-ALPN-01, so no DNS API token and no wildcard certificate are needed. The installer prints the admin token, and keeps it in `/root/sproutboat-admin.env` (`sudo sbctl token` prints it again).

### In a homelab

```sh
curl -fsSL https://raw.githubusercontent.com/baronunread/sproutboat/main/install.sh | sudo bash -s -- --homelab
```

Homelab mode installs no Caddy and leaves `ufw` alone. Control (`:8787`) and the edge (`:8080`) listen on loopback unless you say otherwise; you point your own proxy (nginx, Traefik, Caddy elsewhere) at them, or use Tailscale. The choices are kept in `/etc/sproutboat/install.env`, and `sbctl update` keeps them. The recipes, DNS-01 through Cloudflare and the trade-offs of widening the bind address are in [docs/homelab.md](docs/homelab.md). The full operator runbook is [infra/README.md](infra/README.md).

### Your first deploy

On your own machine:

```sh
npm install -g sproutboat      # or: bunx sproutboat ...
sproutboat init hello
cd hello
sproutboat login --api-url https://control.example.com   # one browser approval
sproutboat deploy
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

`env` is a global, not a parameter. It carries the `vars` from your `sproutboat.jsonc` (they go into the artifact), project secrets (they stay out of the binary), and the bindings you declare. Your app answers at `https://<project>.<admin>.example.com`. Full CLI documentation lives at [sproutboat.com/docs](https://sproutboat.com/docs).

## Upgrading

```sh
sudo sbctl update --check    # installed and target release, and the changelog in between; changes nothing
sudo sbctl update
```

Read the **Breaking and operator actions** sections of [CHANGELOG.md](CHANGELOG.md) first. An update takes a backup and verifies it, keeps the running release in `/opt/sproutboat-prev`, installs the new one (the dashboard build runs under a 1200 MiB memory cap), restarts the services, and runs a health gate. If anything fails, it rolls back by itself and exits non-zero. `sudo sbctl rollback` returns to the kept release by hand. Every service restarts, so expect a brief outage and cold starts.

`sbctl update` follows the newest stable `vX.Y.Z` tag. To install a pre-release such as `v1.0.0-rc.1`, ask for it: `sudo SB_REF=v1.0.0-rc.1 sbctl update`. That choice becomes a pin until you remove `SPROUTBOAT_UPDATE_REF` from `/etc/sproutboat/update.env`. [docs/versioning.md](docs/versioning.md) has the rules.

Your own settings (backup, limits, egress allow list) belong in the `*.local.env` files next to the installer's env files, which an update never rewrites: see "Where settings live" in [infra/README.md](infra/README.md#where-settings-live).

## Backups

A systemd timer takes a backup daily (with up to 30 minutes of jitter) and keeps the last 7 (`SPROUTBOAT_BACKUP_KEEP`). An archive holds the control database, every KV, D1, queue and Durable Object store, R2 objects, artifacts, `routes.json`, `/etc/sproutboat` and Caddy's certificates. Backups encrypt by default (AES-256-GCM) with `/etc/sproutboat/backup.key`.

**Copy `/etc/sproutboat/backup.key` off the box** (a password manager or a secret store) the day you install. Without it, every encrypted archive is unreadable, including the ones you copy elsewhere. The backups live on the same disk as the data they protect, so also set up an off-box copy: any S3-compatible bucket (`SPROUTBOAT_BACKUP_S3_*` in `control.local.env`), or your own provider snapshots.

```sh
sudo sbctl backup now
sudo sbctl backup verify /var/lib/sproutboat/backups/<archive> --full
sudo sbctl restore /var/lib/sproutboat/backups/<archive> --force
```

Restore stops the services, restores state, config and Caddy's data, and re-seeds the admin password from the restored token. Practise it once on a spare machine. [infra/README.md](infra/README.md#backups) has the format, the S3 settings and the restore details.

## Limits and capacity

Community's limits are what one machine and one supervisor are:

- Capacity is the RAM of the box. Half of RAM caps the edge unit, which holds every running deployment with its broker (`sbctl memory`), and each other unit has its own cap. Per-deployment cgroups default to off.
- Each database is one SQLite file on local disk. Objects sit on local disk. Nothing replicates.
- The supervisor stops a deployment after an idle window and cold-starts it on the next request. Cron, queue and Durable Object deployments stay resident.

Safety caps protect the box. They are not tiers, and every one is a setting (see [infra/README.md](infra/README.md#limits-and-abuse-controls-25)): 50 projects per account, 25 retained versions per project, 5 custom domains and 64 secrets per project, 100 storage resources per account, 10 deploys per account per minute, 20 new certificates per hour, 10 webhooks per account, and Activity events kept for 365 days or 50,000 rows.

## Health and monitoring

`sudo sbctl status` shows each unit, `sudo sbctl health` runs the same gate an update uses (units, control, edge, egress, Caddy; `--json` for scripts), and `sudo sbctl logs` follows the journals. Control answers `GET /internal/health` for an HTTP check. The dashboard has live tail, request metrics and Admin pages for users and backups.

## Security model

Each deployment runs under [bubblewrap](https://github.com/containers/bubblewrap) as an unprivileged user in its own user, PID, IPC, UTS and cgroup namespaces, and sees a read-only view of only its own artifact directory. The edge unit denies all network traffic except loopback, so outbound requests go through a token-gated egress service that refuses private and reserved addresses (`SB_EGRESS_ALLOW` is your escape hatch). Bindings run in a separate broker, which has its own sandbox. This is defence in depth for code you wrote or trust. It is not a boundary against hostile code: sprouts share the kernel and the loopback interface, the installer ships no seccomp filter, and per-deployment resource caps default to off. The details, and how to report a vulnerability, are in [SECURITY.md](SECURITY.md).

## Maintenance and versions

Community follows [SemVer](https://semver.org). From 1.0, the 1.x line enters maintenance mode: it gets security fixes, runtime and toolchain compatibility, and fixes for data loss or broken installs and updates, with new features only when they are small. Only the newest 1.x release gets support, and minor releases do not break, so staying current is cheap. [docs/versioning.md](docs/versioning.md) and [SECURITY.md](SECURITY.md) hold the policy, the supported-version table and the list of what counts as breaking.

## Building and contributing

Use [Bun](https://bun.sh), not npm.

```sh
bun install
bun run dev:local     # control, edge, dashboard and a GitHub emulator on *.sproutboat.localhost
bun run seed --reset  # demo accounts, projects, resources and traffic
bun test apps/ services/ tests/
bun run typecheck && bun run lint && bun run fmt:check
```

CI runs those checks, the dashboard component tests, a Playwright end-to-end suite against the local stack, and the Rust edge and egress jobs. `bun run validate` also runs the Porffor capability harness and rebuilds [COMPAT.md](COMPAT.md); CI does not run it.

`dev:local` serves the stack over local TLS; trust Portless's CA on first run, sign in at `https://dashboard.sproutboat.localhost/`, and deploy to it with `sproutboat login --api-url https://control.sproutboat.localhost`. To reset, stop it and remove `.local/sproutboat` and `~/.config/sproutboat`.

To try unreleased `@sproutboat/{wire,runtime,toolchain}` changes, point this checkout at a local [sproutboat-packages](https://github.com/baronunread/sproutboat-packages) checkout (with its own `bun install` done) for the length of one command:

```sh
bun tools/with-local-packages.ts ../sproutboat-packages -- bun test services/supervisor
```

It symlinks `node_modules/@sproutboat/<pkg>` to the checkout, runs the command, and puts the installed packages back afterwards. It refuses to run in the main checkout while that has uncommitted changes: use a `git worktree`.

```
apps/control          control API: auth, projects, artifacts, routes, backups, activity, webhooks
apps/web              dashboard (React, TanStack Start in SPA mode, built on @sproutboat/ikada,
                      the open design system at github.com/baronunread/ikada)
services/edge         the Bun edge (the fallback engine)
services/edge-rs      the Rust edge (the default engine)
services/egress-rs    the Rust egress service (the default engine)
services/supervisor   per-deployment sprout and broker processes
install.sh, infra/    the installer, sbctl, systemd units, sandbox launcher
tools/                capability harness, benches, differential tests, the local dev stack
tests/                contract and installer tests, the Porffor capability suite
docs/                 homelab guide, versioning, engine behaviour, compatibility notes
```

Pull requests are welcome; please file an issue first for anything larger than a fix. Commit messages use a lowercase scope, a short imperative summary and the issue or PR number in parentheses (see `git log`). Report bugs on [the issue tracker](https://github.com/baronunread/sproutboat/issues), and CLI bugs on [sproutboat-cli](https://github.com/baronunread/sproutboat-cli/issues). Security problems go through [SECURITY.md](SECURITY.md), not the tracker.

## Legal

Sproutboat is MIT licensed; see [LICENSE](LICENSE). It builds on [Porffor](https://porffor.dev), [uWebSockets](https://github.com/uNetworking/uWebSockets), [Bun](https://bun.sh), [bubblewrap](https://github.com/containers/bubblewrap) and [Caddy](https://caddyserver.com), each under its own license.

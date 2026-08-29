# Self-hosted, single-admin mode (v1)

> **`sudo ./install.sh` does everything below automatically.** This doc is the
> manual reference — what the script writes and why.

Run Sproutboat on your own VPS for one admin, driven entirely by the CLI. No
GitHub OAuth, no dashboard sign-in, no namespace reservation flow. The
multi-tenant code stays in place but dormant — this mode just doesn't wire it.

It leans on the existing **bootstrap token** path in
`apps/control/src/identity.ts` (`actorFor()`): any request carrying
`SPROUTBOAT_BOOTSTRAP_TOKEN` is the admin, and every CLI route
(`deploy`, `versions`, `rollback`, `tail`, logs, metrics) accepts it.

> Known-sharp, acceptable behind your own firewall, all on the production
> backlog: the bootstrap token is compared with `===` and never expires (#14);
> `POST /api/cli/authorizations` is unauthenticated (#15); there is no request
> deadline or response cap yet (#8). Do not expose this publicly.

## 1. DNS

One record, made in your DNS panel: `*.<domain>` A → host IP, DNS-only. Covers
`control.<domain>` and every `<project>.<admin>.<domain>`. `install.sh` prints
it and waits for it to resolve. No DNS API token is needed for TLS — Caddy
issues a cert per hostname via HTTP-01.

## 2. Control service env (`/etc/sproutboat/control.env`)

```sh
SPROUTBOAT_BOOTSTRAP_USERNAME=<3–32 char lowercase slug, e.g. your handle>
SPROUTBOAT_BOOTSTRAP_TOKEN=<32+ random chars>
SPROUTBOAT_DEPLOYMENT_DOMAIN=<your domain>

SPROUTBOAT_DATABASE_PATH=/var/lib/sproutboat/sproutboat.sqlite
SPROUTBOAT_ROUTE_SNAPSHOT=/var/lib/sproutboat/routes.json
SPROUTBOAT_ARTIFACTS_DIR=/var/lib/sproutboat/artifacts
SPROUTBOAT_DEPLOYMENTS_PATH=/var/lib/sproutboat/deployments.json
```

Leave `BETTER_AUTH_*` and `GITHUB_CLIENT_*` unset — `getAuth()` is only reached
on the browser/session routes, which this mode never calls.

## 3. Edge service env

```sh
SPROUTBOAT_LOG_PATH=/var/lib/sproutboat/logs/edge.ndjson
SPROUTBOAT_DEPLOYMENT_DOMAIN=<your domain>
# Optional request caps (defaults shown):
SPROUTBOAT_REQUEST_TIMEOUT_MS=30000
SPROUTBOAT_RESPONSE_MAX_BYTES=10485760
# Per-node response cache is on by default; disable with:
# SPROUTBOAT_EDGE_CACHE=off
```

Control and edge bind `127.0.0.1` by default (`SPROUTBOAT_BIND_HOST`). Keep it
that way — Caddy is the only listener that should face the internet.

`SPROUTBOAT_LOG_PATH` is optional in code but **required for any metrics** — the
edge silently writes nothing without it.

## 4. Services

Start `sproutboat-control`, `sproutboat-edge`, and `caddy`. Do **not** enable
`sproutboat-web.service` (the dashboard needs GitHub OAuth).

In `infra/caddy/Caddyfile`, swap `fn.example.com` for your domain and comment out
the `dashboard.` site block. Certs are per-hostname via HTTP-01 / TLS-ALPN-01 (no
DNS API token); the `on_demand_tls` block issues them for
`<project>.<admin>.<domain>` against the control `ask` endpoint.

## 5. CLI

Either set env per shell:

```sh
export SPROUTBOAT_API_URL=https://control.<your-domain>
export SPROUTBOAT_TOKEN=<the bootstrap token>
```

…or persist it once (writes `~/.config/sproutboat/credentials.json`, no browser):

```sh
sproutboat login --api-url https://control.<your-domain> --token <the bootstrap token>
```

Then the normal flow works:

```sh
sproutboat init hello
cd hello
sproutboat deploy          # → https://hello.<user>.<your-domain>
sproutboat versions list
sproutboat rollback <id>
sproutboat tail
```

## What stays off

Better Auth, GitHub OAuth, the device-code flow, namespace reservation, the web
dashboard, the admin/admin API. All compiled in, none wired. The full
production backlog (the 40-item audit) is unchanged and still applies before
this takes untrusted traffic.

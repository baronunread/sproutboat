# Self-hosted, single-operator mode (v1)

Run Sproutboat on your own VPS for one operator, driven entirely by the CLI. No
GitHub OAuth, no dashboard sign-in, no namespace reservation flow. The
multi-tenant code stays in place but dormant — this mode just doesn't wire it.

It leans on the existing **bootstrap token** path in
`apps/control/src/identity.ts` (`actorFor()`): any request carrying
`SPROUTBOAT_BOOTSTRAP_TOKEN` is the operator, and every CLI route
(`deploy`, `versions`, `rollback`, `tail`, logs, metrics) accepts it.

> Known-sharp, acceptable behind your own firewall, all on the production
> backlog: the bootstrap token is compared with `===` and never expires (#14);
> `POST /api/cli/authorizations` is unauthenticated (#15); there is no request
> deadline or response cap yet (#8). Do not expose this publicly.

## 1. DNS

`infra/tofu/` — set `root_domain` + `vps_ipv4`, then `tofu apply`. Only the
`*.<domain>` wildcard record matters for CLI-only use; `dashboard.` is unused.

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

In `infra/caddy/Caddyfile`, swap `sproutboat.com` for your domain and comment out
the `dashboard.` site block. Keep the `acme_dns cloudflare` line and the
`on_demand_tls` block — on-demand TLS issues certs for `<project>.<user>.<domain>`
against the control `ask` endpoint.

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
dashboard, the operator/admin API. All compiled in, none wired. The full
production backlog (the 40-item audit) is unchanged and still applies before
this takes untrusted traffic.

# One-server deployment

The POC requires a Linux x86-64 host with systemd, Docker, Caddy, cgroups v2,
and a Cloudflare wildcard DNS record for `*.sproutboat.com` pointing at the host.
The public marketing site is deliberately not hosted on this VPS: `sproutboat.com`
and `www.sproutboat.com` are Cloudflare Pages custom domains. Install the two unit
files in `infra/systemd/`, place the repository at `/opt/sproutboat`, and install
[Caddyfile](caddy/Caddyfile) at `/etc/caddy/Caddyfile`.

Before starting Caddy, provide `ACME_EMAIL`, create `/var/lib/sproutboat`, and
write its initial route snapshot as an empty JSON array. Caddy asks the local
control service before requesting a certificate, so it can issue TLS only for
an active `<project>.<username>.sproutboat.com` deployment. The custom Caddy build
uses Cloudflare DNS-01 validation to obtain an exact certificate for that host.

The dashboard, control, and edge services intentionally bind only to loopback.
Caddy is the sole public listener on ports 80 and 443. It serves the React
dashboard at `dashboard.sproutboat.com` and forwards its `/api` and `/v1` requests
to Control on the same origin.

## Provisioning

Copy `infra/ansible/inventory.example.yml`, set the real VPS address, ACME email,
and a scoped Cloudflare token, then run:

```sh
ansible-galaxy collection install ansible.posix
ansible-playbook -i infra/ansible/inventory.yml infra/ansible/site.yml
```

Before the public request path is enabled, attach `sproutboat.com` and
`www.sproutboat.com` to the Cloudflare Pages marketing project. Create exact
`dashboard.sproutboat.com` and wildcard `*.sproutboat.com` records in Cloudflare that
point to the VPS. Set both VPS records to **DNS only**: Caddy, not Cloudflare
Universal SSL, presents certificates for nested deployment names such as
`hello.andrea.sproutboat.com`. The Pages domains can remain proxied through
Cloudflare. The API token needs only the `Zone:Read` and `DNS:Edit` permissions
for `sproutboat.com`.

Before deploying, copy [control.env.example](control.env.example) to
`/etc/sproutboat/control.env` and set `BETTER_AUTH_SECRET` (at least 32
high-entropy characters),
`BETTER_AUTH_URL=https://dashboard.sproutboat.com`, and the GitHub OAuth client credentials.
For an operator CLI during the transition, set the temporary
`SPROUTBOAT_BOOTSTRAP_USERNAME` and `SPROUTBOAT_BOOTSTRAP_TOKEN`, then reload and
restart Control:

```sh
sudo systemctl daemon-reload
sudo systemctl restart sproutboat-control
```

Apply the Better Auth SQLite migration before enabling GitHub sign-in and
user-owned CLI keys:
`bunx --bun auth@1.7.1 migrate --config apps/control/src/auth.migrate.ts --yes`.

Register `https://dashboard.sproutboat.com/api/auth/callback/github` as the GitHub
OAuth callback URL. The GitHub app needs access to the account email address.

## First developer

1. Open `https://dashboard.sproutboat.com` and select **Sign in with GitHub**.
2. Reserve a lowercase namespace such as `andrea`.
3. On the development machine, set `SPROUTBOAT_API_URL=https://dashboard.sproutboat.com`
   and run `sproutboat login`. It opens the approval page and stores the approved
   credential locally. `SPROUTBOAT_TOKEN` is reserved as an explicit override for
   CI and other non-interactive automation.
4. Run `sproutboat deploy` from a project. Its live URL is
   `https://<project>.<namespace>.sproutboat.com`.

Each account receives its own namespace and API key. Projects with the same
name may be deployed by different accounts without sharing deployment history,
logs, rollback, or deletion rights.

# Single-VPS deployment

One Linux x86-64 host with a public IP runs a single-admin Sproutboat
instance. Multi-tenant / fleet hosting is a separate project (`sproutboat-cloud`).

## Install

```sh
git clone https://github.com/<you>/sproutboat && cd sproutboat
sudo ./install.sh
```

The script is the whole runbook: it enables unprivileged user namespaces,
installs Caddy + bubblewrap, sets a default-deny firewall, builds the dashboard,
generates one admin identity, writes `/etc/sproutboat/{sproutboat,control}.env`
**before** starting anything, brings up `control` + `edge` + `dashboard` + Caddy,
runs `runtime:preflight`, and prints the admin token, the DNS record to create,
and the CLI commands to deploy your first function.

No Docker on the server — deployments run under bubblewrap, and sprouts are
built by the CLI (Porffor + Zig), never here.

Non-interactive: set `SB_DOMAIN`, `SB_ACME_EMAIL`, `SB_ADMIN`. GitHub sign-in is
optional — add `SB_GITHUB_CLIENT_ID` / `SB_GITHUB_CLIENT_SECRET` to enable it.

## DNS

**One record:** `*.<domain>` A → host IP, **DNS only** (grey cloud, so
Let's Encrypt reaches the box directly). Like Coolify and Pangolin, you create
it yourself in your DNS panel — the installer prompts for the domain, it doesn't
touch your provider and **needs no DNS API token**.

The wildcard covers `control.<domain>`, `dashboard.<domain>`, and every
`<project>.<admin>.<domain>` deployment. Caddy gets a per-hostname cert for each
via **HTTP-01 / TLS-ALPN-01** — `control.`/`dashboard.` at startup, deployments
on demand. No wildcard certificate, so no DNS challenge.

**Issuance is gated.** Caddy's `on_demand_tls` asks `/internal/tls/allow` before
ordering any deployment cert; control answers `allowed` only for a hostname that
matches the `<project>.<admin>.<domain>` shape **and** is an active route right
now — an arbitrary `Host:` header never triggers an ACME order. On top of that,
new hostnames are capped at `SPROUTBOAT_TLS_NEW_CERTS_PER_HOUR` (default 20) per
rolling hour so a deploy burst can't run the zone into a Let's Encrypt block;
renewals of an already-seen hostname are never counted. A `429` here is logged to
`control.ndjson` as `{"kind":"limit","event":"tls-issuance"}`.

Start with **staging ACME** for the first shakeout: `SB_ACME_STAGING=1 sudo
./install.sh` (or add `acme_ca https://acme-staging-v02.api.letsencrypt.org/directory`
to the Caddyfile global block). Certs will be untrusted but rate-limit-free.
Remove it and `systemctl reload caddy` to switch to production.

`install.sh` prints the record and waits for it to resolve before starting Caddy
(skip with `SB_SKIP_DNS_CHECK=1`). Set `SB_CF_TOKEN` (Cloudflare, `Zone:Read` +
`DNS:Edit`) only if inbound `:80` is blocked — the installer then switches Caddy
to DNS-01.

### Custom domains

A project owner can attach their own hostname (`sproutboat domains add
www.example.com`, then `… verify` once the TXT record is live, or the project
**Settings** page). Verification is a `_sproutboat.<hostname>` TXT record
carrying `sproutboat-verify=<token>`; control resolves it and, on a match, adds
the hostname to `routes.json`. From then the edge serves it from whatever
version of the project is active, and Caddy issues its cert on demand through
the same `/internal/tls/allow` gate and per-hour ceiling as generated
hostnames. The visitor's DNS must point the hostname at this box (A/AAAA or
CNAME to the deployment domain). `SPROUTBOAT_MAX_DOMAINS_PER_PROJECT` (default 5) caps how many a project may hold; deleting the project or the domain drops
it from the snapshot on the next sync.

## Hosts and binding

`control` (`:8787`) and `edge` (`:8080`) bind `127.0.0.1` only. Caddy is the
sole public listener (80/443). The **dashboard is a static SPA** (`apps/web`,
built to `apps/web/dist/client`) that Caddy serves from disk on
`dashboard.<domain>` — no service, no port. The bare `<domain>` redirects to
the dashboard; `control.<domain>` is the CLI/API origin.

## Native runtime sandbox

Each active deployment is ONE long-lived process: a native-fetch HTTP server
(Porffor `alpha-3` + uWebSockets) — see `docs/runtime-native-fetch.md`. The
supervisor (`services/supervisor/src/run.ts`) assigns it a loopback port, starts
it through `infra/sandbox/sprout-sandbox.sh`, waits for it to accept a
connection, and restarts it if it exits. The edge reverse-proxies each request
to that port.

`sprout-sandbox.sh` wraps the binary in bubblewrap: private
user/pid/mount/ipc/uts namespaces, an unprivileged uid, a read-only view of only
the runtime libraries plus the one artifact directory, `--die-with-parent`, and
an optional seccomp filter. It does **not** unshare the network namespace — the
worker must serve loopback for the edge to reach it. Egress isolation comes from
the edge unit instead: `IPAddressDeny=any` / `IPAddressAllow=localhost` in
`sproutboat-edge.service`, which every sprout it spawns inherits, so a sprout can
serve loopback but cannot reach the host network, the control plane, or the
cloud metadata endpoint.

### 1. Host preflight

After installing Bun, `bubblewrap`, Caddy, and a C/C++ toolchain:

```sh
cd /opt/sproutboat
bun run runtime:preflight     # arch, cgroups v2, user/pid/mount namespaces, unprivileged userns, a live bwrap sandbox, seccomp, the launcher script
```

It fails for a non-x86-64 CPU, cgroups v1, unavailable namespaces, disabled
unprivileged user namespaces, a bwrap that cannot create the sandbox, or missing
seccomp. `systemd-run` is a warning only: the edge cgroup carries aggregate caps
(`MemoryMax`/`CPUQuota`/`TasksMax` in `sproutboat-edge.service`); opt into
per-sprout scopes with `SPROUTBOAT_SPROUT_CGROUP=1` (see Limits below).

### 2. Seccomp filter (optional but recommended)

`sprout-sandbox.sh` passes `--seccomp` when `SPROUTBOAT_SPROUT_SECCOMP` points at
a compiled BPF program (the unit sets `/etc/sproutboat/worker-seccomp.bpf`).
Build it from a real trace of a pinned artifact under load, then turn the
syscall set into a filter (e.g. with a libseccomp helper):

```sh
PORT=8099 /var/lib/sproutboat/artifacts/<id>/worker &
worker=$!
strace -f -c -qq -o /tmp/worker.strace -p "$worker" &
for i in $(seq 200); do curl -s -o /dev/null "http://127.0.0.1:8099/?i=$i"; done
kill "$worker"
# install the allowlist at /etc/sproutboat/worker-seccomp.bpf
```

Until that file exists the sandbox still runs — namespace, filesystem, fork, and
egress isolation do not depend on seccomp; the syscall allowlist is the last
layer. Do not reuse a trace across Porffor or libc updates.

### 3. Verify containment

```sh
bun run sandbox:smoke     # compiles a sprout, serves it through the sandbox, then
                          # asserts it cannot read the host fs, see other PIDs, or fork
```

The egress deny (`IPAddressDeny=any`) is enforced by systemd on the running unit,
not by the sandbox script, so `sandbox:smoke` cannot reproduce it — check it
directly once the edge is up:

```sh
# from inside the edge's cgroup, any non-loopback connect must fail
systemd-run --uid=sproutboat-edge --slice=$(systemctl show -p Slice --value sproutboat-edge) --pipe --quiet -- curl -s -m 3 https://example.com ; echo "exit $?"
```

### Local development

Off Linux the sandbox is skipped and the sprout is spawned directly. On a Linux
dev box that is fine to trust, `SPROUTBOAT_SPROUT_SANDBOX=none` plus
`SPROUTBOAT_UNSAFE_NO_SANDBOX=1` does the same; anything else is refused.

## First deploy

`install.sh` prints the admin token, the DNS records, and:

```sh
sproutboat login --api-url https://control.<domain> --token <admin-token>
sproutboat init hello
cd hello && sproutboat deploy          # -> https://hello.<admin>.<domain>
sproutboat tail hello
sproutboat versions list hello
```

The admin's username comes from `SPROUTBOAT_BOOTSTRAP_USERNAME` (set by the
installer) — there is no separate namespace-reservation step in single-admin
mode. `SPROUTBOAT_API_URL` / `SPROUTBOAT_TOKEN` env vars work instead of `login`
for CI.

The dashboard (`https://dashboard.<domain>`) is always installed, a static SPA
Caddy serves from disk. Sign in with **email + password**: the admin's email is
`SB_ACME_EMAIL`, the admin's password is `SPROUTBOAT_TOKEN` from
`/root/sproutboat-admin.env`.

**No self-service sign-up.** Add other people from **Admin → Users** — you set
an email + a starting password, hand those to them, and they sign in. They can
link GitHub to the same email afterwards. `POST /api/auth/sign-up` returns 403.

GitHub sign-in is optional. Set `SB_GITHUB_CLIENT_ID` / `SB_GITHUB_CLIENT_SECRET`
before install and register `https://dashboard.<domain>/api/auth/callback/github`
as the OAuth callback. With `disableSignUp` it only logs in an account that
already exists — a stranger's GitHub account can't get in. `install.sh` runs the
Better Auth migration
(`bunx --bun auth@1.7.1 migrate --config apps/control/src/auth.migrate.ts --yes`)
for you.

## Backups

`sproutboat-backup.timer` runs `apps/control/src/backups.ts` daily: a consistent
SQLite snapshot (`VACUUM INTO`) plus the artifact directory and route snapshot,
one `sproutboat-<date>.tar.gz` under `/var/lib/sproutboat/backups/`. The newest
`SPROUTBOAT_BACKUP_KEEP` (default 7) are kept.

Admin -> **Backups** in the dashboard lists them, takes one on demand, and
downloads or deletes an archive. On-demand: `systemctl start sproutboat-backup`.

### Off-box copy (S3-compatible)

Set these in `/etc/sproutboat/control.env` and every new archive is uploaded and
the remote copies are pruned to the same retention. An upload failure never
fails the backup — the local archive still exists, and the dashboard shows the
per-archive **Off-box** state.

```sh
SPROUTBOAT_BACKUP_S3_BUCKET=my-sproutboat-backups
SPROUTBOAT_BACKUP_S3_ACCESS_KEY_ID=...
SPROUTBOAT_BACKUP_S3_SECRET_ACCESS_KEY=...
SPROUTBOAT_BACKUP_S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com   # omit for AWS S3
SPROUTBOAT_BACKUP_S3_REGION=auto
SPROUTBOAT_BACKUP_S3_PREFIX=host-1                                          # optional key prefix
```

Works with AWS S3, Cloudflare R2, Backblaze B2, MinIO — anything S3-compatible.
Still keep taking provider snapshots.

### Restore

```sh
systemctl stop sproutboat-control sproutboat-edge
cd /var/lib/sproutboat
tar -xzf backups/sproutboat-<date>.tar.gz          # sproutboat.sqlite, artifacts/, routes.json
chown -R sproutboat-control:sproutboat sproutboat.sqlite artifacts routes.json
systemctl start sproutboat-control sproutboat-edge
```

## Limits and abuse controls (#25)

All configurable in `/etc/sproutboat/control.env`; sane defaults apply if unset.

| Env var                                    | Default | Effect                                                                      |
| ------------------------------------------ | ------- | --------------------------------------------------------------------------- |
| `SPROUTBOAT_DEPLOY_RATE_PER_MIN`           | 10      | deploys per account per minute (`429` + `Retry-After` past it)              |
| `SPROUTBOAT_DEPLOY_RATE_PER_IP_PER_MIN`    | 20      | deploys per source IP per minute                                            |
| `SPROUTBOAT_MAX_PROJECTS_PER_ACCOUNT`      | 50      | distinct projects one account may hold                                      |
| `SPROUTBOAT_MAX_VERSIONS_PER_PROJECT`      | 25      | retained inactive versions; older ones are deleted and their artifacts GC'd |
| `SPROUTBOAT_MAX_DOMAINS_PER_PROJECT`       | 5       | custom domains one project may attach                                       |
| `SPROUTBOAT_MAX_SECRETS_PER_PROJECT`       | 64      | secrets one project may hold                                                |
| `SPROUTBOAT_AUTH_RATE_MAX` / `_WINDOW_SEC` | 30 / 60 | Better Auth throttle on `/api/auth/*` (login, token)                        |

## Secrets (#2)

Set per project with `sproutboat secrets set NAME` (or the dashboard); the sprout
reads them as `env.NAME`. A running worker keeps the values it started with — a
change applies on the next deploy or sprout restart, like Cloudflare.

Encrypted at rest with AES-256-GCM. The key is `SPROUTBOAT_SECRETS_KEY` (base64,
32 bytes) if set, otherwise `<state>/secrets.key` — 32 random bytes written mode
`0600` on first use. **The backup archive includes `secrets.key`**; if you rely
on an off-box `SPROUTBOAT_BACKUP_S3_*` copy, understand that the key travels with
the ciphertext there. To keep them separate, set `SPROUTBOAT_SECRETS_KEY` from a
secret store your box reads at boot and delete `<state>/secrets.key`.

Rejections are written to `<state>/logs/control.ndjson` as
`{"kind":"limit","event":"deploy-rate-account"|"deploy-rate-ip"|"project-cap", ...}`.

**Per-worker runtime caps** (memory / CPU / pids) are opt-in and Linux-only —
each sprout gets its own `systemd-run --scope`:

| Env var                        | Default |                   |
| ------------------------------ | ------- | ----------------- |
| `SPROUTBOAT_SPROUT_CGROUP`     | unset   | `1` to enable     |
| `SPROUTBOAT_SPROUT_MEMORY_MAX` | `128M`  | scope `MemoryMax` |
| `SPROUTBOAT_SPROUT_CPU_QUOTA`  | `50%`   | scope `CPUQuota`  |
| `SPROUTBOAT_SPROUT_TASKS_MAX`  | `64`    | scope `TasksMax`  |

The edge unit still carries aggregate caps (`MemoryMax`/`CPUQuota`/`TasksMax`) as
a backstop. Verify `systemd-run` is reachable for the `sproutboat-edge` user
before enabling per-sprout scopes.

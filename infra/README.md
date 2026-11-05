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

**Not a public VPS?** `sudo ./install.sh --homelab` (or `SB_MODE=homelab`) installs
without Caddy and without touching `ufw`, for use behind your own reverse
proxy, on a LAN, or over Tailscale. The choices are kept in
`/etc/sproutboat/install.env` (`SB_MODE`, `SB_PROXY`, `SB_FIREWALL`, `SB_SCHEME`,
`SB_BIND_HOST`, ...) and survive `sbctl update`; `sbctl mode` prints them. Everything
below describes the default public mode unless it says otherwise. See
[docs/homelab.md](../docs/homelab.md).

## Pinned dependencies

`install.sh` installs two third-party binaries at exact, checksum-verified versions:

| Tool  | Version | Where                                              | Verified against                             |
| ----- | ------- | -------------------------------------------------- | -------------------------------------------- |
| Bun   | 1.4.4   | `/opt/sproutboat/bun/bin/bun` (`bunx` links to it) | SHA-256 from the release's `SHASUMS256.txt`  |
| Caddy | 2.11.9  | `/usr/local/bin/caddy-sproutboat`                  | SHA-512 from `caddy_<version>_checksums.txt` |

The pins (`BUN_VERSION`, `BUN_SHA256_X64`, `BUN_SHA256_X64_BASELINE`, `CADDY_VERSION`,
`CADDY_SHA512_AMD64`) are constants at the top of `install.sh`; CI uses the same Bun version.
CPUs without AVX2 get the Bun baseline build. A download whose hash does not match is
discarded and the install stops.

`sbctl update` re-runs the installer, so a changed pin replaces the binary on the next
update. The installer compares `bun --version` and `caddy version` with the pin on every
run and does nothing when they match. When Caddy was replaced, the installer restarts it
(a reload would keep running the old binary).

With `SB_CF_TOKEN` set (Cloudflare DNS-01), Caddy comes from the caddyserver.com build API
because the stock build lacks the DNS module. That build is made on demand, so it is **not**
checksum-verified or pinned to the version above; the installer prints a warning. It is
only fetched when the binary is missing or lacks the module.

## DNS

In homelab mode the installer never looks up the public IP and never waits for
DNS: point `*.<domain>` at the box's LAN or tailnet address (or at your proxy).
See [docs/homelab.md](../docs/homelab.md). The rest of this section is the public mode.

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

## Customising Caddy

`install.sh` regenerates `/etc/caddy/Caddyfile` and the unit files under `/etc/systemd/system` on every
`sbctl update`, so hand edits to either are overwritten. The supported extension points survive updates:

- **Caddy drop-ins:** `/etc/sproutboat/caddy.d/*.caddy` are imported at the end of the generated Caddyfile. Each file
  must hold complete site blocks, not global options. `README.caddy` in that directory explains this and is never
  overwritten once present. Dot-files are ignored by the glob.
- **systemd drop-ins:** `/etc/systemd/system/<unit>.service.d/*.conf` also survive (the installer only writes its own
  `sproutboat.conf` for caddy). Run `systemctl daemon-reload` after changing one.

Validation: the installer builds the new Caddyfile as `/etc/caddy/Caddyfile.new` and runs `caddy validate` on it before
replacing the live file. If a drop-in is broken the update stops with the Caddy error and the running config is left
untouched; fix or remove the file and re-run `sbctl update`. To check by hand:

```sh
caddy-sproutboat validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
```

### Recipe: redirect www to the apex

Without this, `http://www.example.com` gets Caddy's automatic redirect to `https://www...`, which fails: on-demand TLS
asks control, control only allows hostnames in `routes.json`, and `www` is not a route, so no certificate is issued.
A drop-in site block makes Caddy obtain the `www` certificate itself (HTTP-01):

```sh
sudo cp infra/caddy/caddy.d/www-redirect.caddy.example /etc/sproutboat/caddy.d/www.caddy
sudo sed -i 's/example\.com/yourdomain.tld/g' /etc/sproutboat/caddy.d/www.caddy
caddy-sproutboat validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
```

The apex must already be served (a verified custom domain of a project), and the DNS A record for `www` must point at
this box. `install.sh --uninstall` removes `/etc/sproutboat`, drop-ins included, even with `--keep-state`.

## Hosts and binding

`control` (`:8787`) and `edge` (`:8080`) bind `127.0.0.1` by default. In public
mode Caddy is the sole public listener (80/443). The **dashboard is a static SPA**
(`apps/web`, built to `apps/web/dist/client`) that Caddy serves from disk on
`dashboard.<domain>` — no service, no port. The bare `<domain>` redirects to
the dashboard; `control.<domain>` is the CLI/API origin.

In homelab mode (`SB_PROXY=external`) there is no Caddy: the listener is your own
proxy, which forwards `control.<domain>` and `dashboard.<domain>` to `:8787` (control
serves the SPA itself, from `SPROUTBOAT_DASHBOARD_DIR`) and the deployment hosts to
`:8080`. `SB_BIND_HOST` can widen the bind in homelab mode only. It also opens the
edge's `IPAddressDeny=any` filter to `SB_BIND_ALLOW`, which lets sprouts reach those
ranges directly; read [docs/homelab.md](../docs/homelab.md#g-sb_bind_host-and-sb_bind_allow)
before using it.

## Native runtime sandbox

Each active deployment is ONE long-lived process: a native-fetch HTTP server
(Porffor `alpha-9` + uWebSockets); see `docs/runtime-native-fetch.md`. The
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

### Outbound fetch

Brokers run inside the edge unit too, so they can't reach the network either.
A sprout's `fetch()` leaves the host through `sproutboat-egress.service`
instead (#252). That's a separate unit outside the edge's cgroup, listening on
`127.0.0.1:8070`:

- **Token:** it answers only callers that present the token in
  `/etc/sproutboat/egress.env`. `install.sh` generates it, keeps it across
  upgrades, and the edge unit reads it so its brokers carry it. Sprouts share
  loopback, but the sandbox clears their environment, so they never see it.
- **Address checks:** it resolves each target, refuses private and reserved
  addresses (loopback, RFC 1918, link-local and the metadata endpoint, CGNAT,
  multicast, and their IPv6 forms), and connects only to the address it vetted.
- **Allowing private addresses:** to let sprouts reach one, such as a database
  on this host, add `SB_EGRESS_ALLOW=10.0.0.5` (comma-separated exact
  addresses, or `*`) to `/etc/sproutboat/egress.env` and run
  `systemctl restart sproutboat-egress`. Re-running the installer keeps it.
- **Engines:** the egress runs as the Rust binary by default; see [Engines](#engines).

```sh
sbctl status   # sproutboat-egress should be active
# from the edge's cgroup the service answers; with the token it fetches
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8070/   # 401 without the token
```

### Broker sandbox

Each deployment's broker runs in its own `bwrap` sandbox, started by the
supervisor (`services/supervisor/src/broker-sandbox.ts`), with no new unit or
env file. It sees:

| Path or value                                                                                                 | Access      |
| ------------------------------------------------------------------------------------------------------------- | ----------- |
| `bun`, the checkout's `node_modules`, `broker-main.ts`                                                        | read only   |
| the deployment's `bindings.json`, secrets file, `assets/`, `assets.json`                                      | read only   |
| `/var/lib/sproutboat/brokers/<deployment>/`                                                                   | read write  |
| `/var/lib/sproutboat/resources/<id>.sqlite` (plus `-wal`, `-shm`) for each resource the app is bound to       | read write  |
| `/var/lib/sproutboat/resources/owners/<owner>/` mounted as `r2-blobs`, `r2-parts`, `r2-quota.sqlite`          | read write  |
| loopback: its sprout, the edge, `sproutboat-egress`                                                           | network     |
| `SB_EGRESS_URL`, `SB_EGRESS_TOKEN`, `SB_EGRESS_ALLOW`, `SB_R2_TRANSFER_MAX_BYTES`, `SB_FETCH_MAX_BYTES`, `TZ` | environment |
| a per-app credential in `SB_EDGE_SECRET`, only when the app has service bindings                              | environment |

The shared `resources/` directory, other deployments' state, the control
database and the rest of the edge's environment are not there. `SPROUTBOAT_BROKER_SANDBOX`
(`bwrap` or `none`) overrides the mode; by default it follows `SPROUTBOAT_SPROUT_SANDBOX`.
Like the sprout, an unsandboxed broker on Linux needs `SPROUTBOAT_UNSAFE_NO_SANDBOX=1`.
The first broker start for an account moves its R2 bodies from the old shared
`resources/r2-blobs/` into `resources/owners/<owner>/r2-blobs/`.

### Local development

Off Linux the sandbox is skipped and the sprout is spawned directly. On a Linux
dev box that is fine to trust, `SPROUTBOAT_SPROUT_SANDBOX=none` plus
`SPROUTBOAT_UNSAFE_NO_SANDBOX=1` does the same (for the sprout and its broker);
anything else is refused.

## Engines

The edge and the egress run as static Rust binaries (`services/edge-rs`, `services/egress-rs`). The Bun
implementations (`services/edge`, `@sproutboat/wire`) stay as a fallback.

- **Where they live:** `/usr/local/lib/sproutboat/bin/{sproutboat-edge,sproutboat-egress}`, root-owned, mode 0755,
  outside the `rsync --delete` tree. The units name them directly.
- **Where they come from:** the installer downloads `SHA256SUMS` and both binaries from the GitHub Release of the exact
  tag it installs (built by `.github/workflows/release.yml`), verifies the checksums, and installs them atomically.
  Re-running skips the download when the installed hashes already match.
- **Unreleased builds:** `SB_ENGINE_DIR=<dir>` uses a local directory holding `sproutboat-edge-linux-x64`,
  `sproutboat-egress-linux-x64` and `SHA256SUMS` instead. `SB_ENGINE_BASE_URL` overrides the download base. The
  release workflow can also be run by hand (`workflow_dispatch`) to publish a pre-release for a branch.
- **Choosing an engine:** `/etc/sproutboat/engine.env` holds `SB_EDGE=rust|bun` and `SB_EGRESS=rust|bun`. A fresh
  install defaults to `rust` for both; an existing file is kept on update; `SB_EDGE` / `SB_EGRESS` in the
  installer environment override it. `sbctl engine` shows the current engines and `sbctl engine rust|bun` switches
  both and restarts them. `bun` works through generated `10-engine.conf` drop-ins (`infra/sb-engine`, installed as
  `/usr/local/lib/sproutboat/engine`); `rust` removes them.
- **Automatic fallback:** if the binaries cannot be downloaded or verified, the installer warns and continues. With no
  Rust binaries installed at all it selects `bun` for both; with older ones it keeps them and the engine choice, and
  warns that they are stale (a ref that is not a `vX.Y.Z` tag, such as `main`, has no published binaries). On a fresh
  install it also probes `127.0.0.1:8080/__sb/pool` and `127.0.0.1:8070` for 20 s after the restart and switches both to
  Bun if the Rust engines do not answer.
- **Bun is still required:** the Rust edge runs the Bun supervisor (`services/supervisor/src/sidecar.ts`) as a
  sidecar (`SPROUTBOAT_BUN` in the unit), and control and `sbctl preflight` run on Bun.
- **Limits:** the Rust egress is small, so its cap is `MemoryMax=128M` / `MemoryHigh=112M` (the Bun fallback gets
  512M / 448M from its drop-in). Both listen on 8070 (HTTP) and 8071 (the connect tunnel), loopback only.

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

## Updating and rolling back

`sudo sbctl update` is safe to run on a live box: it backs up first, keeps the running
release, checks the result and undoes itself when the check fails. Order of events:

1. `sbctl update` stages the target release (the newest `vX.Y.Z` tag, or the pin in
   `/etc/sproutboat/update.env`) and runs that checkout's `install.sh --upgrade`. Every
   safety step below lives in that new installer, so even the first update to a release
   that has them is protected, whichever bootstrapper the box still has.
2. Checks that need nothing changed: memory for the capped build, and free disk for the
   snapshot (below). A refusal changes nothing.
3. **Pre-update backup.** `sproutboat-backup.service` runs with the installed code (under
   its own 512M cap), then the new release's verifier checks the new archive. If either
   fails the update stops with nothing changed. The installer prints the archive name:
   it is the fallback for data (`sbctl restore <archive> --force`). `SB_SKIP_BACKUP=1`
   skips this step.
4. **Previous release snapshot** in `/opt/sproutboat-prev` (see below).
5. The rollback is armed. The tree is synced, Bun and Caddy are upgraded if pinned
   versions changed, dependencies and the dashboard are built (capped), config and units
   are written, the auth schema is migrated, and the services restart.
6. **Health gate** (`sb-health`, up to `SB_HEALTH_TIMEOUT` seconds, default 45): control,
   egress, edge and caddy are active; `127.0.0.1:8787/internal/health` returns
   `"ok":true`; the edge pool route on `127.0.0.1:8080` returns 200; the egress on
   `:8070` and Caddy on `:80` answer (401 and a redirect are the normal answers).
7. If any step from 5 on fails, or the gate does, the installer runs `sb-rollback` from
   the new release and exits 1. A passing gate ends with exit 0.

`sbctl update` therefore exits non-zero on any failure: backup, verify, disk, memory,
build, Caddy validation, health or rollback. `SB_NO_ROLLBACK=1 sbctl update` leaves a
failed update in place for debugging (exit code still non-zero).

### What the update will change: `sbctl update --check`

Prints the installed version, commit and ref, the target ref and commit, and, when they
differ, the changelog sections between them, taken from the target's `CHANGELOG.md` on
GitHub. It changes nothing. Read the "Breaking and operator actions" parts first.

### The previous release

`/opt/sproutboat-prev` (root, readable) holds:

| Path      | Content                                                                                                                                       |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `tree/`   | a copy of `/opt/sproutboat`: code, `bun/`, `node_modules/`, the built dashboard                                                               |
| `etc/`    | `/etc/sproutboat`, the Caddyfile, the sproutboat and caddy units and their drop-ins, logrotate and journald snippets                          |
| `usr/`    | `sbctl`, the Caddy binary, and `/usr/local/lib/sproutboat` (update, engine, backup-stage, health, rollback, and `bin/` with the Rust engines) |
| `RELEASE` | version, commit, ref and date of what is saved; written last, so a half-written snapshot is never used                                        |

Disk: about the size of `/opt/sproutboat` (a few hundred MiB, most of it `node_modules`
and Bun). The installer refuses to start when the free space on `/opt` is less than that
plus 200 MiB (what an earlier snapshot already holds is not counted again). Each update
replaces the snapshot, so only one previous release is kept. The tree is copied with
`rsync`, so later snapshots only copy what changed. Nothing about the layout of
`/opt/sproutboat` changes: there are no symlinks and no releases directory, so a
half-finished update is always recoverable.

### Rolling back

Automatic when an update fails. By hand: `sudo sbctl rollback` (prints `RELEASE`, asks
first; `--yes` skips the question). It restores the tree, config, units, helper scripts,
engines and Caddy binary from `/opt/sproutboat-prev`, reloads systemd, restarts the
services and runs the health gate. It exits non-zero when the host is still unhealthy.
The data in `/var/lib/sproutboat` is not touched.

**Database policy.** The auth and control migrations the new release ran stay applied.
A release may only add columns the previous release ignores, or drop columns that the
previous release re-adds when it starts (0.14.0 and 0.13.x work this way). A change that
cannot meet that rule is called out under "Breaking and operator actions" in the
changelog, with its own rollback steps.

**When the rollback fails** (no snapshot, or still unhealthy): read
`sbctl status` and `journalctl -u sproutboat-control -u sproutboat-edge -u caddy`, then
restore the data from the pre-update backup the failed update printed:
`sbctl backup list`, `sudo sbctl restore <archive> --force` (see Restore below). If
`/opt/sproutboat-prev` is gone, re-run the installer of the release you want:
`SB_REF=v0.13.1 sbctl update`.

### Health at any time: `sbctl health`

Runs the same gate on a running box: one ok/fail line per check, exit 1 when unhealthy,
`--json` for monitoring. `sbctl health` waits up to `SB_HEALTH_TIMEOUT` seconds
(default 45); set `SB_HEALTH_TIMEOUT=1` for a one-shot probe.

## Backups

`sproutboat-backup.timer` runs `apps/control/src/backups.ts` daily, writing one
archive under `/var/lib/sproutboat/backups/`; the newest `SPROUTBOAT_BACKUP_KEEP`
(default 7) are kept. An archive holds:

- the control database, every binding store under `resources/` and `brokers/`
  (KV, D1, R2, queues, Durable Objects), R2 object bodies, the artifact
  directory, the route snapshot and `secrets.key`. Each SQLite file is
  snapshotted with `VACUUM INTO`, so the backup is consistent while the edge
  keeps writing;
- the host config under `config/`: every file in `/etc/sproutboat` (env files,
  `backup.key`) as `config/etc/sproutboat/`, and Caddy's data directory
  (certificates and ACME accounts, no lock files) as `config/caddy/`;
- `manifest.json`, the first member: format, platform version, creation time,
  whether config is included, and the size, sha256 and mode of every file.

Admin -> **Backups** in the dashboard lists them, takes one on demand, and
downloads or deletes an archive. CLI: `sudo sbctl backup now`, `sbctl backup list`.

### Encryption and the key

Archives are encrypted at rest by default and are named
`sproutboat-<date>.tar.gz.enc`. The key is `/etc/sproutboat/backup.key`: 64 hex
characters (32 random bytes), created by `install.sh` on first run and kept across
updates, mode `0640 root:sproutboat` so the backup user can read it.
`SPROUTBOAT_BACKUP_KEY_FILE` (written to `control.env`) overrides the path.

**Copy `/etc/sproutboat/backup.key` off the box** (password manager, secret
store). Without it every encrypted archive is unreadable, including the ones in
S3. Archives made with `backup.key` also carry a copy of it inside `config/`, so
keep the key somewhere the archive is not.

The format, for anyone who needs to read one by hand: the ASCII magic `SBBK1\n`
(6 bytes), a 12-byte random nonce, the AES-256-GCM ciphertext of a gzip tar
stream, then the 16-byte GCM tag. The key is the 32 bytes decoded from the hex
file, used directly (no KDF). Nothing unencrypted is written to disk on the way:
`tar` is piped through the cipher into the output file.

`SPROUTBOAT_BACKUP_ENCRYPT=off` in `control.env` writes plain `.tar.gz` instead.
Older plain archives keep working everywhere. With encryption off and an S3
target configured, the backup logs a warning: the archive, with `secrets.key` and
your env files, would leave the box in clear.

### Verify

Every archive is verified right after it is written; a failure fails the unit
(`systemctl status sproutboat-backup`) and deletes the bad archive.

```sh
sudo sbctl backup verify /var/lib/sproutboat/backups/sproutboat-<date>.tar.gz.enc
sudo sbctl backup verify <archive> --full --key /path/to/backup.key
```

The default check decrypts and streams the archive through `tar`: the GCM tag
proves it is intact and the key is right, and gzip and tar check their own
structure. It prints the manifest summary. `--full` also extracts to a scratch
directory, checks every size and sha256 against the manifest, runs
`PRAGMA integrity_check` on every SQLite file, and removes the scratch
directory. Exit status 1 with a one-line reason on any failure ("wrong backup
key or corrupted archive" for a bad key or tag).

### Config snapshot timing

The backup user cannot read `/etc/sproutboat/egress.env`, `update.env` or Caddy's
data. A root step, `/usr/local/lib/sproutboat/backup-stage`, copies them into
`/var/lib/sproutboat/config-snapshot/` (mode 0700, owned by the backup user);
the archive includes that snapshot. The step runs as `ExecStartPre=+` of
`sproutboat-backup.service`, so a nightly backup always has a fresh snapshot,
and once at the end of every install or update. **A backup started from the
dashboard uses the snapshot as of the last nightly run or update**, so a
certificate renewed since then is not in it. Run `sudo sbctl backup now` when
you need a backup with config as of this minute. Caddy's data directory is
found from the caddy unit (`XDG_DATA_HOME`, else the home of its `User=`, root
when unset), then `/caddy`, `/var/lib/caddy/.local/share/caddy` and
`/root/.local/share/caddy`; `backup-stage --print-caddy-dir` shows the result.
`/caddy` is there because the unit install.sh writes has no `User=` and no
`HOME`, so Caddy falls back to `./caddy` under its working directory `/`. A
directory counts once it holds `certificates` or `instance.uuid`.

### Off-box copy (S3-compatible)

Set these in `/etc/sproutboat/control.env` and every new archive is uploaded and
the remote copies are pruned to the same retention. An upload failure never
fails the backup: the local archive still exists, and the dashboard shows the
per-archive **Off-box** state. Archives are encrypted before upload; keep it that
way (see above).

```sh
SPROUTBOAT_BACKUP_S3_BUCKET=my-sproutboat-backups
SPROUTBOAT_BACKUP_S3_ACCESS_KEY_ID=...
SPROUTBOAT_BACKUP_S3_SECRET_ACCESS_KEY=...
SPROUTBOAT_BACKUP_S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com   # omit for AWS S3
SPROUTBOAT_BACKUP_S3_REGION=auto
SPROUTBOAT_BACKUP_S3_PREFIX=host-1                                          # optional key prefix
```

Works with AWS S3, Cloudflare R2, Backblaze B2, MinIO, anything S3-compatible.
Still keep taking provider snapshots.

### Restore

Onto a fresh install (run `install.sh` first, so the users and units exist):

```sh
sudo sbctl restore /path/to/sproutboat-<date>.tar.gz.enc --force --key /path/to/backup.key
```

A fresh install has its own, different `backup.key`, so pass the old one with
`--key`; once the archive's config is restored, `/etc/sproutboat/backup.key` is the
old key again. Flags: `--force` (the fresh install already has a
`sproutboat.sqlite`), `--no-config` (state only), `--key FILE`, `--allow-newer`
(see below). Plain `sbctl restore <archive> [--force]` still works.

The order, in full:

1. The archive is read end to end first (for an encrypted one, every byte is
   authenticated before anything is extracted). It stops on a truncated or
   foreign file, a wrong key, a member outside the state dir, or an archive from
   a newer platform version than the one running (`--force` does not override
   that; `--allow-newer` does).
2. `sbctl` stops the backup timer, control and the edge.
3. State is restored: the `-wal`, `-shm` and `-journal` files beside every
   database are deleted first (SQLite would replay the install's own log over
   the restored file). `config/` is extracted to a scratch directory, never the
   state dir.
4. Owners and modes are reset: control owns its database, routes and artifacts;
   the edge owns binding data, group-writable.
5. Config is applied: `config/etc/sproutboat/*` is copied over `/etc/sproutboat/`
   with the modes `install.sh` uses, Caddy's data is copied into its data
   directory, and `/root/sproutboat-admin.env` is rewritten from the restored
   `control.env`.
6. The admin password is reset to the current `SPROUTBOAT_BOOTSTRAP_TOKEN` with
   `bun apps/control/src/auth-admin.ts reset-password`. The database holds the
   admin hash from the old box while `control.env` holds the token to log in with;
   before this step the CLI token and the dashboard password could differ. It
   runs for every restore, so it also fixes archives made without config.
7. Caddy is reloaded, the egress service restarted if config was applied, then
   control, the edge and the timer start.

It warns when the archive has no `secrets.key` and `SPROUTBOAT_SECRETS_KEY` is
unset, and when the archive predates binding-data backups (no `resources/`).
After restoring config the domain and tokens are the old box's: if the new box
has a different IP, update DNS before expecting certificates to renew.

## Memory budget

Every unit has a memory cap, and the caps must fit in RAM. Rule: **the sum of the
`MemoryMax` values plus about 400 MiB for the OS must stay under MemTotal.**

| Unit                                                               | MemoryMax                                                                       | MemoryHigh              | Where set                                                                                                                                                                                                         |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sproutboat-edge` (edge, every sprout, broker, bwrap, Bun sidecar) | 50% of MemTotal, rounded down to 64 MiB, minimum 512M (1920M on a 3890 MiB box) | 85% of MemoryMax        | installer drop-in `/etc/systemd/system/sproutboat-edge.service.d/10-sproutboat-memory.conf`; the unit file keeps a static `MemoryMax=1536M` / `MemoryHigh=1280M` fallback for installs made without the installer |
| `sproutboat-control`                                               | 384M                                                                            | 320M                    | unit file                                                                                                                                                                                                         |
| `sproutboat-egress`                                                | 128M (Rust); 512M (Bun, via the engine drop-in)                                 | 112M (Rust); 448M (Bun) | unit file (Rust engine); `10-engine.conf` drop-in for Bun                                                                                                                                                         |
| `caddy`                                                            | 256M                                                                            | 224M                    | installer drop-in `/etc/systemd/system/caddy.service.d/sproutboat.conf`                                                                                                                                           |
| `sproutboat-backup`                                                | 512M                                                                            | none                    | unit file (also `Nice=10`, `IOSchedulingClass=idle`)                                                                                                                                                              |
| update build (`bun install`, dashboard build, auth migration)      | 1200M (`SB_BUILD_MEMORY_MAX`)                                                   | none                    | transient `systemd-run --scope` in `install.sh`                                                                                                                                                                   |
| OS and sshd reserve                                                | about 400M                                                                      |                         | documented only                                                                                                                                                                                                   |

On a 3890 MiB box the steady state is 1920 + 384 + 512 + 256 = 3072 MiB of caps,
plus the 400 MiB reserve (and a 128M monitoring agent if you run one) = 3600
MiB, under MemTotal. The backup (nightly) and the update build (manual) are
transient.

`sbctl memory` prints MemTotal, MemAvailable, and each unit's `MemoryMax`,
`MemoryHigh` and `MemoryCurrent`, then the sum of the maxes and whether it fits
under MemTotal minus 400M.

**Overriding the edge cap.** The installer rewrites `10-sproutboat-memory.conf`
on every install and update, so do not edit it. Either add a drop-in that sorts
later, for example `/etc/systemd/system/sproutboat-edge.service.d/50-local.conf`
with `[Service]`, `MemoryMax=3000M` and `MemoryHigh=2600M`, then
`systemctl daemon-reload && systemctl restart sproutboat-edge`; or run the
update with `SB_EDGE_MEMORY_MAX=<MiB> sbctl update` (it must be set on each
update). Keep the rule above in mind when raising it.

**The update build is capped.** `bun install`, the dashboard build and the auth
migration run in a transient scope with `MemoryMax=1200M` (override with
`SB_BUILD_MEMORY_MAX`) and no swap. Before building, an update checks
`MemAvailable` and refuses to start, before changing anything on disk, if it is
below the cap: stop the backup timer (`systemctl stop sproutboat-backup.timer`)
or wait for the backup to finish, then retry. `SB_SKIP_MEMCHECK=1` bypasses the
check.

The control, edge and egress units also set `StartLimitIntervalSec=0`, so a
crash-looping unit keeps retrying every 2 s instead of stopping in
`start-limit-hit`.

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
| `SPROUTBOAT_MAX_WEBHOOKS_PER_ACCOUNT`      | 10      | webhooks one account may register                                           |
| `SPROUTBOAT_EVENTS_KEEP_DAYS`              | 365     | days of Activity events kept                                                |
| `SPROUTBOAT_EVENTS_MAX_ROWS`               | 50000   | Activity events kept in total; the oldest go first                          |

## Activity and webhooks

Control records what changes on the box in an `events` table and serves it at
`GET /api/activity` (scoped to the caller; admins can pass `?all=1`).

- **What is recorded:** deploys (started, succeeded, failed), activations and
  rollbacks, version and project deletes, project creation, secret set and
  delete (the name only, never the value), custom domains (added, verified,
  removed; never the verification token), CLI token created and revoked, member
  created, disabled and enabled, backups (created, failed) and webhook tests.
  Each type may carry only an allowlisted set of fields, so a secret, token or
  hash cannot end up in the history by mistake. Backup events belong to the box
  and only admins see them.
- **Retention:** `SPROUTBOAT_EVENTS_KEEP_DAYS` and `SPROUTBOAT_EVENTS_MAX_ROWS`
  (above). Pruning runs at the first event after start and every 100th event
  after that. The table is part of the SQLite file, so backups carry it; a
  0.14.0 install ignores it.
- **Webhooks:** each account registers up to `SPROUTBOAT_MAX_WEBHOOKS_PER_ACCOUNT`
  URLs (`POST /api/webhooks`) with a type filter (`deploy.*` or exact types; an
  empty list means everything) and a format, `json` or `discord`. Failed
  deliveries retry at +30 s, +2 min, +10 min and +1 h, then are marked failed;
  the last 200 deliveries per webhook are kept and listed at
  `GET /api/webhooks/:id/deliveries`.
- **Egress:** control never connects to a webhook URL itself. It hands each
  delivery to the egress service (`SB_EGRESS_URL`, with the token from
  `/etc/sproutboat/egress.env`, which the control unit now reads), so private
  and reserved addresses are refused just as they are for a sprout's `fetch()`.
  The delivery log shows `refused` and the reason, and a refusal is not retried.
  To deliver to a host on a private address, add it to `SB_EGRESS_ALLOW` in
  `egress.env` (see [Outbound fetch](#outbound-fetch)) and restart
  `sproutboat-egress`. Without egress configured a delivery fails with
  `egress not configured`.
- **Discord:** create a webhook in the channel's Integrations settings, paste its
  URL as the webhook URL and choose the `discord` format. The signature header is
  sent too; Discord ignores it.

### Verifying a delivery

Every request carries `x-sproutboat-signature: t=<unix seconds>,v1=<hex>`, where
`v1` is the HMAC-SHA256 of `<t>.<raw body>` with the webhook's secret (shown once,
when the webhook is created). `x-sproutboat-event` and `x-sproutboat-delivery`
carry the type and a delivery id. Check the signature over the raw bytes, and
reject an old `t` to stop replays:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(rawBody, header, secret, toleranceSeconds = 300) {
  const parts = Object.fromEntries(header.split(",").map((part) => part.split("=")));
  const expected = createHmac("sha256", secret).update(`${parts.t}.${rawBody}`).digest("hex");
  const fresh = Math.abs(Date.now() / 1000 - Number(parts.t)) <= toleranceSeconds;
  const a = Buffer.from(expected);
  const b = Buffer.from(parts.v1 ?? "");
  return fresh && a.length === b.length && timingSafeEqual(a, b);
}
```

## Logs

Nothing under `/var/lib/sproutboat/logs` grows without bound. `install.sh` installs
`/etc/logrotate.d/sproutboat` (and `logrotate` itself) and enables `logrotate.timer`.

| What                                                             | Rotated at | Kept                    |
| ---------------------------------------------------------------- | ---------- | ----------------------- |
| `logs/requests.ndjson` (edge request log), `logs/control.ndjson` | 64 MiB     | 5, compressed after one |
| `logs/sprouts/*.log` (per-deployment stdout and stderr)          | 16 MiB     | 1, uncompressed         |

Rotation uses `copytruncate`: the services keep their file open in append mode, so no
restart or reopen is needed. Rotation is by size, not daily, so the dashboard Logs page
(which reads the last 1 MiB of the live file) is rarely emptied. After a rotation the Logs
page and `sproutboat tail` show only lines written since then; rotated files are not read.
Sprout logs are also truncated on each fresh spawn of the sprout.

The journal (Caddy, control, edge and egress output; Caddy has no access log) is capped
globally by `/etc/systemd/journald.conf.d/sproutboat.conf`: `SystemMaxUse=256M`,
`SystemMaxFileSize=32M`, `MaxRetentionSec=1month`. journald has no per-unit cap. The
installer restarts `systemd-journald` once, only when that file changed.

Changing the limits: the installer overwrites `/etc/logrotate.d/sproutboat` on every
update, so do not edit it. For the journal, add a file that sorts later, for example
`/etc/systemd/journald.conf.d/zz-local.conf`, and restart `systemd-journald`. For logrotate,
a separate `/etc/logrotate.d/sproutboat-local` only works if it names different paths
(logrotate rejects the same log in two stanzas), so to change these sizes edit the shipped
file and reapply the edit after each update.

## Secrets (#2)

Set per project with `sproutboat secrets set NAME` (or the dashboard); the sprout
reads them as `env.NAME`. A running worker keeps the values it started with — a
change applies on the next deploy or sprout restart, like Cloudflare.

Encrypted at rest with AES-256-GCM. The key is `SPROUTBOAT_SECRETS_KEY` (base64,
32 bytes) if set, otherwise `<state>/secrets.key` — 32 random bytes written mode
`0600` on first use. **The backup archive includes `secrets.key`**. Archives are encrypted with
`backup.key` (see Backups), so an off-box copy does not carry it in clear unless
you turn encryption off. To keep the two apart anyway, set `SPROUTBOAT_SECRETS_KEY` from a
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

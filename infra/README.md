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
**before** starting anything, brings up `control` + `edge` + Caddy (+ the
dashboard if you opt in), runs `runtime:preflight`, and prints the admin token,
the DNS record to create, and the CLI commands to deploy your first function.

No Docker on the server — deployments run under bubblewrap. `sproutboat build`
uses the Porffor compile toolchain image on whatever machine runs the CLI
(normally your laptop). `SB_WITH_BUILD_IMAGE=1` installs Docker + pulls that
image here so you can build on the box too.

Non-interactive: set `SB_DOMAIN`, `SB_ACME_EMAIL`, `SB_ADMIN` (and
`SB_DASHBOARD=yes` + `SB_GITHUB_CLIENT_ID`/`SB_GITHUB_CLIENT_SECRET`).

## DNS

**One record:** `*.<domain>` A → host IP, **DNS only** (grey cloud, so
Let's Encrypt reaches the box directly). Like Coolify and Pangolin, you create
it yourself in your DNS panel — the installer prompts for the domain, it doesn't
touch your provider and **needs no DNS API token**.

The wildcard covers `control.<domain>`, `dashboard.<domain>`, and every
`<project>.<admin>.<domain>` deployment. Caddy gets a per-hostname cert for each
via **HTTP-01 / TLS-ALPN-01** — `control.`/`dashboard.` at startup, deployments
on demand (gated by the control plane's `/internal/tls/allow`). No wildcard
certificate, so no DNS challenge.

`install.sh` prints the record and waits for it to resolve before starting Caddy
(skip with `SB_SKIP_DNS_CHECK=1`). Set `SB_CF_TOKEN` (Cloudflare, `Zone:Read` +
`DNS:Edit`) only if inbound `:80` is blocked — the installer then switches Caddy
to DNS-01.

## Hosts and binding

`control` (`:8787`), `edge` (`:8080`), and the dashboard (`:3000`) bind
`127.0.0.1` only. Caddy is the sole public listener (80/443). The bare
`<domain>` redirects to the dashboard; `control.<domain>` is the CLI/API origin.

## Native runtime sandbox

Each active deployment is ONE long-lived process: a native-fetch HTTP server
(Porffor `alpha-3` + uWebSockets) — see `docs/runtime-native-fetch.md`. The
supervisor (`services/supervisor/src/run.ts`) assigns it a loopback port, starts
it through `infra/sandbox/worker-sandbox.sh`, waits for it to accept a
connection, and restarts it if it exits. The edge reverse-proxies each request
to that port.

`worker-sandbox.sh` wraps the binary in bubblewrap: private
user/pid/mount/ipc/uts namespaces, an unprivileged uid, a read-only view of only
the runtime libraries plus the one artifact directory, `--die-with-parent`, and
an optional seccomp filter. It does **not** unshare the network namespace — the
worker must serve loopback for the edge to reach it. Egress isolation comes from
the edge unit instead: `IPAddressDeny=any` / `IPAddressAllow=localhost` in
`sproutboat-edge.service`, which every worker it spawns inherits, so a worker can
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
seccomp. `systemd-run` is a warning only: the POC caps the whole edge cgroup
(`MemoryMax`/`CPUQuota`/`TasksMax` in `sproutboat-edge.service`) rather than
per-worker scopes.

### 2. Seccomp filter (optional but recommended)

`worker-sandbox.sh` passes `--seccomp` when `SPROUTBOAT_WORKER_SECCOMP` points at
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
bun run sandbox:smoke     # compiles a worker, serves it through the sandbox, then
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

Off Linux the sandbox is skipped and the worker is spawned directly. On a Linux
dev box that is fine to trust, `SPROUTBOAT_WORKER_SANDBOX=none` plus
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

If you enabled the dashboard: register `https://dashboard.<domain>/api/auth/callback/github`
as the GitHub OAuth callback, run the Better Auth migration
(`bunx --bun auth@1.7.1 migrate --config apps/control/src/auth.migrate.ts --yes`),
then sign in with GitHub. A token-gated dashboard that skips GitHub for
single-admin use is planned.

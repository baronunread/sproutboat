# One-server deployment

The POC requires a Linux x86-64 host with systemd, Caddy, cgroups v2,
`bubblewrap`, unprivileged user namespaces, and a Cloudflare wildcard DNS record
for `*.sproutboat.com` pointing at the host. The build image (a C/C++ toolchain
for the Porffor native-fetch compile) is used only to produce artifacts, never
to serve requests — the edge runs each deployment as a long-lived native-fetch
HTTP server inside a bubblewrap sandbox (`infra/sandbox/worker-sandbox.sh`).
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
dashboard at `dashboard.sproutboat.com` and forwards its `/api` requests to
Control on the same origin.

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

## Provisioning

Copy `infra/ansible/inventory.example.yml`, set the real VPS address, ACME email,
and a scoped Cloudflare token, then run:

```sh
ansible-galaxy collection install ansible.posix
ansible-playbook -i infra/ansible/inventory.yml infra/ansible/site.yml
```

Before the public request path is enabled, attach `sproutboat.com` and
`www.sproutboat.com` to the Cloudflare Pages marketing project. The
`dashboard.sproutboat.com` and wildcard `*.sproutboat.com` records that point to the
VPS are managed with OpenTofu — see [tofu/README.md](tofu/README.md) — and are
kept **DNS only**: Caddy, not Cloudflare Universal SSL, presents certificates
for nested deployment names such as `hello.andrea.sproutboat.com`. The Pages
domains can remain proxied through Cloudflare. The API token needs only the
`Zone:Read` and `DNS:Edit` permissions for `sproutboat.com`, and is the same
token Caddy uses for its DNS-01 challenge.

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

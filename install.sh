#!/usr/bin/env bash
#
# Sproutboat single-VPS installer. SSH into a fresh Linux box and:
#
#   curl -fsSL https://raw.githubusercontent.com/baronunread/sproutboat/main/install.sh | sudo bash
#   # or, from a checkout:  sudo ./install.sh
#
# It asks a few questions up front, then runs unattended: packages, Caddy,
# bubblewrap, a firewall, one admin identity, and the control + edge + dashboard
# services. It pauses once to let you add a DNS record.
#
# Non-interactive: set SB_DOMAIN, SB_ACME_EMAIL, SB_ADMIN. The dashboard is
# always installed; sign in with the admin token this prints. GitHub sign-in is
# optional — set SB_GITHUB_CLIENT_ID + SB_GITHUB_CLIENT_SECRET to enable it.
# SB_CF_TOKEN — optional, only to use DNS-01 (inbound :80 blocked).
# SB_SKIP_DNS_CHECK=1 — don't wait for DNS to resolve.

set -euo pipefail

BUN_VERSION="1.4.0"
ROOT=/opt/sproutboat
STATE=/var/lib/sproutboat
ETC=/etc/sproutboat
CADDY_BIN=/usr/local/bin/caddy-sproutboat
SB_REPO=${SB_REPO:-https://github.com/baronunread/sproutboat.git}
SB_REF=${SB_REF:-main}

# Colours only when stdout is a terminal (never in CI logs / pipes).
if [ -t 1 ]; then
  C_HEAD=$'\033[1;36m'; C_DIM=$'\033[2m'; C_OK=$'\033[1;32m'; C_WARN=$'\033[1;33m'; C_ERR=$'\033[1;31m'; C_0=$'\033[0m'
else
  C_HEAD=; C_DIM=; C_OK=; C_WARN=; C_ERR=; C_0=
fi

say()  { printf '\n%s▸%s %s%s%s\n' "$C_HEAD" "$C_0" "$C_HEAD" "$*" "$C_0"; }  # section header
note() { printf '  %s%s%s\n' "$C_DIM" "$*" "$C_0"; }                          # indented detail
ok()   { printf '  %s✓%s %s\n' "$C_OK" "$C_0" "$*"; }
warn() { printf '%s !%s %s\n' "$C_WARN" "$C_0" "$*" >&2; }
die()  { printf '%s ✗%s %s\n' "$C_ERR" "$C_0" "$*" >&2; exit 1; }
rule() { printf '  %s────────────────────────────────────────────────────%s\n' "$C_DIM" "$C_0"; }
randhex() { od -An -tx1 -N32 /dev/urandom | tr -d " \n"; }  # 64 hex chars, no external deps

# `curl ... | sudo bash` leaves stdin on the pipe, not the terminal. Prompts and
# the DNS-wait keypress read from $PROMPT_TTY instead; empty means truly no
# terminal (CI / cron) and interactive input is impossible.
if [ -t 0 ]; then PROMPT_TTY=/dev/stdin
elif [ -r /dev/tty ]; then PROMPT_TTY=/dev/tty
else PROMPT_TTY=; fi

ask()  { # ask VAR "prompt" ["default"]
  local __v=$1 __p=$2 __d=${3:-} __a
  if [ -n "${!__v:-}" ]; then return; fi
  [ -n "$PROMPT_TTY" ] || die "$__v is unset and no terminal is available (set it in the environment for non-interactive installs)"
  read -r -p "$__p${__d:+ [$__d]}: " __a < "$PROMPT_TTY" || true
  printf -v "$__v" '%s' "${__a:-$__d}"
}

# SB_SKIP_SERVICES=1 provisions files + builds but does not touch systemd or the
# firewall — for testing the installer in a container/CI.
SKIP_SERVICES=${SB_SKIP_SERVICES:-0}

[ "$(id -u)" = 0 ] || die "run as root (sudo ./install.sh)"
[ "$(uname -s)" = Linux ] || die "Linux only"

# --- uninstall: `install.sh --uninstall [--keep-state]` -------------------
if [ "${1:-}" = --uninstall ]; then
  KEEP_STATE=0; [ "${2:-}" = --keep-state ] && KEEP_STATE=1
  say "Uninstall Sproutboat"
  note "removes services, Caddy config, /opt/sproutboat, users, and the sysctl drop-in"
  [ "$KEEP_STATE" = 1 ] && note "keeps $STATE (database, artifacts, backups)" \
                        || note "ALSO deletes $STATE — database, artifacts, backups"
  if [ "${SB_UNINSTALL_YES:-0}" != 1 ]; then
    [ -n "$PROMPT_TTY" ] || die "not a TTY; re-run with SB_UNINSTALL_YES=1 to confirm"
    read -r -p "  type 'remove' to confirm: " __c < "$PROMPT_TTY" || true
    [ "$__c" = remove ] || die "aborted"
  fi
  systemctl disable --now sproutboat-control sproutboat-edge caddy sproutboat-backup.timer sproutboat-backup.service >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/sproutboat-control.service /etc/systemd/system/sproutboat-edge.service \
        /etc/systemd/system/sproutboat-backup.service /etc/systemd/system/sproutboat-backup.timer
  rm -rf /etc/systemd/system/caddy.service.d
  # only remove caddy.service if this installer created it (has our marker path)
  grep -q "$CADDY_BIN" /etc/systemd/system/caddy.service 2>/dev/null && rm -f /etc/systemd/system/caddy.service
  systemctl daemon-reload
  rm -f "$CADDY_BIN" /usr/local/bin/sbctl /etc/sysctl.d/80-sproutboat-userns.conf /root/sproutboat-admin.env
  rm -rf "$ROOT" /opt/sproutboat-src /etc/sproutboat /etc/caddy
  [ "$KEEP_STATE" = 1 ] || rm -rf "$STATE"
  for u in sproutboat-control sproutboat-edge; do id "$u" >/dev/null 2>&1 && userdel "$u" || true; done
  getent group sproutboat >/dev/null && groupdel sproutboat 2>/dev/null || true
  ok "removed"
  note "firewall rules for 22/80/443 were left in place — 'ufw delete allow 80/tcp' etc. to drop them"
  exit 0
fi

[ "$(uname -m)" = x86_64 ] || die "x86-64 only (artifact target is linux-x86_64)"
if [ "$SKIP_SERVICES" != 1 ]; then
  command -v systemctl >/dev/null || die "systemd required"
  [ -f /sys/fs/cgroup/cgroup.controllers ] || die "cgroups v2 unified hierarchy required (boot with systemd.unified_cgroup_hierarchy=1)"
else
  warn "SB_SKIP_SERVICES=1 — systemd, firewall, image pull, and service start are skipped"
fi

# --- distro -----------------------------------------------------------------
. /etc/os-release
case "${ID:-}${ID_LIKE:+ $ID_LIKE}" in
  *debian*|*ubuntu*) PKG=apt ;;
  *rhel*|*fedora*|*centos*|*rocky*|*almalinux*|*amzn*) PKG=dnf ;;
  *) die "unsupported distro '${ID:-?}' — need a Debian/Ubuntu or RHEL-family host" ;;
esac
say "Host: ${PRETTY_NAME:-$ID} ($PKG)"

# --- locate (or fetch) the source tree ------------------------------------
SRC=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)
if [ -z "$SRC" ] || [ ! -f "$SRC/package.json" ] || [ ! -d "$SRC/apps/control" ]; then
  say "Fetching Sproutboat ($SB_REF)"
  command -v git >/dev/null || { [ "$PKG" = apt ] && apt-get install -y -qq git || dnf install -y -q git; }
  SRC=/opt/sproutboat-src
  if [ -d "$SRC/.git" ]; then git -C "$SRC" fetch -q --depth 1 origin "$SB_REF" && git -C "$SRC" reset -q --hard FETCH_HEAD
  else git clone -q --depth 1 --branch "$SB_REF" "$SB_REPO" "$SRC"; fi
fi

# --- ask everything up front, then run unattended -----------------------
say "Configuration"
ask SB_DOMAIN     "Deployment domain, e.g. fn.example.com (must be one you control)"
[[ "$SB_DOMAIN" =~ ^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$ ]] || die "not a valid domain: $SB_DOMAIN"
ask SB_ACME_EMAIL "Email for Let's Encrypt (cert expiry notices)"
ask SB_ADMIN      "Admin username (3-32 lowercase a-z 0-9 -)" "$(echo "${SUDO_USER:-admin}" | tr -cd 'a-z0-9-' | cut -c1-32)"
[[ "$SB_ADMIN" =~ ^[a-z0-9]([a-z0-9-]{1,30}[a-z0-9])?$ ]] || die "invalid admin username: $SB_ADMIN"
# The dashboard ships with every install. GitHub sign-in is opt-in via env; the
# admin always signs in with the bootstrap token.
SB_GITHUB_CLIENT_ID=${SB_GITHUB_CLIENT_ID:-}
SB_GITHUB_CLIENT_SECRET=${SB_GITHUB_CLIENT_SECRET:-}
DASH_URL="https://dashboard.$SB_DOMAIN"

# Reuse secrets across re-runs so an existing CLI login / session keeps working.
grep_env() { [ -f "$ETC/control.env" ] || return 0; sed -n "s/^$1=//p" "$ETC/control.env" | head -1; }
ADMIN_TOKEN=$(grep_env SPROUTBOAT_BOOTSTRAP_TOKEN)
if [ -n "$ADMIN_TOKEN" ]; then TOKEN_IS_NEW=0; else ADMIN_TOKEN=$(randhex); TOKEN_IS_NEW=1; fi
BETTER_AUTH_SECRET=$(grep_env BETTER_AUTH_SECRET); BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET:-$(randhex)}

# --- unprivileged user namespaces (bubblewrap needs them) ------------------
say "Enabling unprivileged user namespaces"
mkdir -p /etc/sysctl.d
{
  echo "# Sproutboat: bubblewrap needs unprivileged user namespaces"
  echo "kernel.unprivileged_userns_clone=1"
  echo "user.max_user_namespaces=15000"
  echo "kernel.apparmor_restrict_unprivileged_userns=0"
} > /etc/sysctl.d/80-sproutboat-userns.conf
# Apply the keys this kernel actually knows; ignore the rest.
for k in kernel.unprivileged_userns_clone user.max_user_namespaces kernel.apparmor_restrict_unprivileged_userns; do
  v=1; [ "$k" = user.max_user_namespaces ] && v=15000
  sysctl -qw "$k=$v" 2>/dev/null || true
done

# --- packages -------------------------------------------------------------
# The server only runs deployments (under bubblewrap) — it never builds them.
# No Docker. Building worker artifacts is the CLI's job (Porffor + Zig).
say "Installing host packages"
if [ "$PKG" = apt ]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl git patch rsync bubblewrap ufw unzip dnsutils
else
  dnf install -y -q ca-certificates curl git patch rsync bubblewrap ufw unzip bind-utils
fi

# --- firewall: default-deny, only SSH + Caddy -----------------------------
if [ "$SKIP_SERVICES" = 1 ]; then
  say "Firewall — skipped (SB_SKIP_SERVICES)"
else
  say "Configuring firewall (deny inbound except 22/80/443)"
  ufw --force default deny incoming >/dev/null
  ufw --force default allow outgoing >/dev/null
  for p in 22 80 443; do ufw allow "$p"/tcp >/dev/null; done
  ufw --force enable >/dev/null
fi

# --- identities + directories -------------------------------------------
say "Creating service identities and directories"
getent group sproutboat >/dev/null || groupadd --system sproutboat
for u in sproutboat-control sproutboat-edge; do
  id "$u" >/dev/null 2>&1 || useradd --system --gid sproutboat --no-create-home --shell /usr/sbin/nologin "$u"
done
install -d -m 0755 -o root "$ROOT"
install -d -m 0750 -o sproutboat-control -g sproutboat "$STATE" "$STATE/artifacts"
install -d -m 0770 -o sproutboat-edge   -g sproutboat "$STATE/logs"
install -d -m 0750 -o root -g sproutboat "$ETC"

# --- sync the tree ------------------------------------------------------
# --delete keeps $ROOT a clean mirror of the checkout, but must NOT touch the
# things provisioned INTO $ROOT afterwards (Bun, deps, the built dashboard).
say "Syncing $SRC -> $ROOT"
rsync -a --delete \
  --exclude .git --exclude node_modules --exclude .phase0 --exclude .sproutboat --exclude .local \
  --exclude /bun --exclude /apps/web/dist --exclude /apps/web/.tanstack \
  "$SRC"/ "$ROOT"/

# --- Bun (pinned) -----------------------------------------------------
if [ ! -x "$ROOT/bun/bin/bun" ]; then
  say "Installing Bun v$BUN_VERSION"
  curl -fsSL https://bun.sh/install | BUN_INSTALL="$ROOT/bun" bash -s "bun-v$BUN_VERSION"
fi
BUN="$ROOT/bun/bin/bun"

# --- Caddy ----------------------------------------------------------
# Stock Caddy is enough: per-hostname certs via HTTP-01 / TLS-ALPN-01, no DNS
# API. Only add the Cloudflare DNS module if SB_CF_TOKEN is set (DNS-01 — for
# hosts where inbound :80 is blocked).
CADDY_DL="https://caddyserver.com/api/download?os=linux&arch=amd64"
[ -n "${SB_CF_TOKEN:-}" ] && CADDY_DL="$CADDY_DL&p=github.com/caddy-dns/cloudflare"
if [ ! -x "$CADDY_BIN" ]; then
  say "Downloading Caddy${SB_CF_TOKEN:+ + caddy-dns/cloudflare}"
  curl -fsSL "$CADDY_DL" -o "$CADDY_BIN"
  chmod 0755 "$CADDY_BIN"
fi
if [ -n "${SB_CF_TOKEN:-}" ]; then
  "$CADDY_BIN" list-modules 2>/dev/null | grep -q dns.providers.cloudflare || die "Caddy build lacks the cloudflare DNS module"
fi

say "Installing application dependencies"
( cd "$ROOT" && "$BUN" install --frozen-lockfile --silent ) && ok "dependencies ready"

say "Building the dashboard"
( cd "$ROOT" && "$BUN" run --silent web:build >/dev/null ) && ok "dashboard built -> $ROOT/apps/web/dist"

# --- write env BEFORE starting services -----------------------------
say "Writing $ETC/{sproutboat,control}.env"
umask 077
printf 'SPROUTBOAT_DEPLOYMENT_DOMAIN=%s\nSPROUTBOAT_DASHBOARD_URL=%s\n' "$SB_DOMAIN" "$DASH_URL" > "$ETC/sproutboat.env"
chown root:sproutboat "$ETC/sproutboat.env"; chmod 0640 "$ETC/sproutboat.env"
{
  echo "SPROUTBOAT_DATABASE_PATH=$STATE/sproutboat.sqlite"
  echo "SPROUTBOAT_ARTIFACTS_DIR=$STATE/artifacts"
  echo "SPROUTBOAT_DEPLOYMENTS_PATH=$STATE/deployments.json"
  echo "SPROUTBOAT_BOOTSTRAP_USERNAME=$SB_ADMIN"
  echo "SPROUTBOAT_BOOTSTRAP_TOKEN=$ADMIN_TOKEN"
  echo "SPROUTBOAT_ADMIN_EMAILS=$SB_ACME_EMAIL"
  echo "BETTER_AUTH_SECRET=$BETTER_AUTH_SECRET"
  echo "BETTER_AUTH_URL=$DASH_URL"
  if [ -n "$SB_GITHUB_CLIENT_ID" ] && [ -n "$SB_GITHUB_CLIENT_SECRET" ]; then
    echo "GITHUB_CLIENT_ID=$SB_GITHUB_CLIENT_ID"
    echo "GITHUB_CLIENT_SECRET=$SB_GITHUB_CLIENT_SECRET"
  fi
} > "$ETC/control.env"
chown root:sproutboat "$ETC/control.env"; chmod 0640 "$ETC/control.env"

{
  echo "ACME_EMAIL=$SB_ACME_EMAIL"
  [ -n "${SB_CF_TOKEN:-}" ] && echo "CLOUDFLARE_API_TOKEN=$SB_CF_TOKEN"
} > "$ETC/caddy.env"
chmod 0640 "$ETC/caddy.env"
umask 022

say "Generating /etc/caddy/Caddyfile for $SB_DOMAIN"
install -d /etc/caddy
acme_line=""
[ -n "${SB_CF_TOKEN:-}" ] && acme_line=$'\n\tacme_dns cloudflare {env.CLOUDFLARE_API_TOKEN}'
# SB_ACME_STAGING=1 -> Let's Encrypt staging (untrusted certs, no rate limit) for
# a first shakeout. Remove it and `systemctl reload caddy` to switch to prod.
[ "${SB_ACME_STAGING:-0}" = 1 ] && acme_line="$acme_line"$'\n\tacme_ca https://acme-staging-v02.api.letsencrypt.org/directory'
{
  cat <<EOF
{
	email {\$ACME_EMAIL}$acme_line
	on_demand_tls {
		ask http://127.0.0.1:8787/internal/tls/allow
	}
}

# Control API (CLI + dashboard /api). Cert via HTTP-01 (or DNS-01 if configured).
control.$SB_DOMAIN {
	reverse_proxy 127.0.0.1:8787
}
EOF
  cat <<EOF

dashboard.$SB_DOMAIN {
	handle /api/* {
		reverse_proxy 127.0.0.1:8787
	}
	handle {
		root * $ROOT/apps/web/dist/client
		try_files {path} /_shell.html
		file_server
	}
}
EOF
  cat <<'EOF'

# Every <project>.<user>.<domain> deployment. Cert issued on demand,
# only for a hostname control confirms is an active route.
https:// {
	tls {
		on_demand
	}
	reverse_proxy 127.0.0.1:8080
}
EOF
} > /etc/caddy/Caddyfile

for f in routes.json deployments.json; do
  [ -s "$STATE/$f" ] || { printf '[]\n' > "$STATE/$f"; chown sproutboat-control:sproutboat "$STATE/$f"; chmod 0640 "$STATE/$f"; }
done

# --- DNS: guide the one record, then wait for it to resolve here --------
PUBLIC_IP=$(curl -fsS4 -m 5 https://api.ipify.org 2>/dev/null || true)
say "Add ONE DNS record, then Caddy can issue TLS certificates"
rule
note "Type   A"
note "Name   *.$SB_DOMAIN     (a wildcard — the name is literally  *  )"
note "Value  ${PUBLIC_IP:-<the public IPv4 of this box>}"
note "Proxy  OFF / DNS only / grey cloud"
rule
note "Covers control.$SB_DOMAIN, dashboard.$SB_DOMAIN, and every"
note "<project>.$SB_ADMIN.$SB_DOMAIN deployment. No DNS API token needed."
if [ "$SKIP_SERVICES" = 1 ] || [ "${SB_SKIP_DNS_CHECK:-0}" = 1 ] || [ -z "$PUBLIC_IP" ] || [ -z "$PROMPT_TTY" ]; then
  warn "Not waiting for DNS — the record must exist before the first HTTPS request."
else
  probe="sbdns-$RANDOM.$SB_DOMAIN"
  say "Waiting up to 5 min for *.$SB_DOMAIN -> $PUBLIC_IP"
  note "press any key to skip — you can add the record later, certs just wait for it"
  for _ in $(seq 1 60); do
    got=$(getent ahostsv4 "$probe" 2>/dev/null | awk 'NR==1{print $1}' || true)
    [ "$got" = "$PUBLIC_IP" ] && { ok "DNS is live"; break; }
    if read -r -t 5 -n 1 -s _k < "$PROMPT_TTY"; then warn "skipped the DNS wait"; break; fi
  done
fi

# --- systemd -------------------------------------------------------
say "Installing systemd units"
install -d -m 0755 /etc/systemd/system/caddy.service.d
cat > /etc/systemd/system/caddy.service.d/sproutboat.conf <<EOF
[Service]
EnvironmentFile=$ETC/caddy.env
ExecStart=
ExecStart=$CADDY_BIN run --environ --config /etc/caddy/Caddyfile
ExecReload=
ExecReload=$CADDY_BIN reload --config /etc/caddy/Caddyfile --force
EOF
[ -f /lib/systemd/system/caddy.service ] || [ -f /etc/systemd/system/caddy.service ] || cat > /etc/systemd/system/caddy.service <<EOF
[Unit]
Description=Caddy
After=network-online.target
[Service]
Type=notify
ExecStart=$CADDY_BIN run --environ --config /etc/caddy/Caddyfile
Restart=on-failure
[Install]
WantedBy=multi-user.target
EOF
for u in sproutboat-control sproutboat-edge; do
  install -m 0644 "$ROOT/infra/systemd/$u.service" "/etc/systemd/system/$u.service"
done
install -m 0644 "$ROOT/infra/systemd/sproutboat-backup.service" /etc/systemd/system/sproutboat-backup.service
install -m 0644 "$ROOT/infra/systemd/sproutboat-backup.timer"   /etc/systemd/system/sproutboat-backup.timer
install -m 0755 "$ROOT/infra/sbctl" /usr/local/bin/sbctl

# --- Better Auth schema (dashboard + admin token login) ---------------
say "Migrating the auth database"
( cd "$ROOT" && SPROUTBOAT_DATABASE_PATH="$STATE/sproutboat.sqlite" \
    BETTER_AUTH_SECRET="$BETTER_AUTH_SECRET" BETTER_AUTH_URL="$DASH_URL" \
    "$BUN" x --bun auth@1.7.1 migrate --config apps/control/src/auth.migrate.ts --yes >/dev/null ) && ok "auth schema up to date"
chown sproutboat-control:sproutboat "$STATE"/sproutboat.sqlite* 2>/dev/null || true

if [ "$SKIP_SERVICES" = 1 ]; then
  say "Services — skipped (SB_SKIP_SERVICES)"
else
  systemctl daemon-reload

  # --- start (control first — its env now exists) ----------------
  say "Starting services"
  units=(sproutboat-control sproutboat-edge caddy sproutboat-backup.timer)
  systemctl enable --now "${units[@]}" >/dev/null 2>&1
  for u in "${units[@]}"; do
    systemctl is-active --quiet "$u" && ok "$u" || warn "$u is not active — check: journalctl -u $u"
  done

  # --- verify ---------------------------------------------------
  say "Runtime preflight"
  ( cd "$ROOT" && "$BUN" run --silent runtime:preflight --quiet ) \
    && ok "sandbox ready" \
    || warn "preflight reported problems — run 'sudo sbctl preflight' for detail; deployments need bubblewrap working"
fi

# Keep the token retrievable — the SSH scrollback is not a safe home for it.
printf 'SPROUTBOAT_API_URL=https://control.%s\nSPROUTBOAT_TOKEN=%s\n' "$SB_DOMAIN" "$ADMIN_TOKEN" > /root/sproutboat-admin.env
chmod 0600 /root/sproutboat-admin.env

printf '\n%s▸ Sproutboat is up%s\n' "$C_OK" "$C_0"
rule
if [ "$TOKEN_IS_NEW" = 1 ]; then note "admin credentials (saved to /root/sproutboat-admin.env)"
else note "admin credentials (unchanged from your last install)"; fi
printf '    SPROUTBOAT_API_URL  %shttps://control.%s%s\n' "$C_HEAD" "$SB_DOMAIN" "$C_0"
printf '    SPROUTBOAT_TOKEN    %s%s%s\n' "$C_HEAD" "$ADMIN_TOKEN" "$C_0"
rule

say "Dashboard  $DASH_URL"
note "sign in with email $SB_ACME_EMAIL + the token above as the password"
if [ -n "$SB_GITHUB_CLIENT_ID" ] && [ -n "$SB_GITHUB_CLIENT_SECRET" ]; then
  note "GitHub sign-in enabled — OAuth callback: $DASH_URL/api/auth/callback/github"
fi

say "Deploy from your workstation"
note "bunx @sproutboat/cli login --api-url https://control.$SB_DOMAIN --token <token>"
note "sproutboat init hello && cd hello && sproutboat deploy"

say "Operate  (sudo sbctl <cmd>)"
note "sbctl status            health of every unit"
note "sbctl logs [control|edge|caddy]   follow logs"
note "sbctl down / sbctl up   pause / resume everything"
note "sbctl update            re-run installer, then restart"
note "sbctl uninstall         remove everything (--keep-state to keep the db)"

say "Backups"
note "daily to $STATE/backups (last 7 kept); manage under Admin -> Backups"
warn "take a provider snapshot now, and copy backups off-box"

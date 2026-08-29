#!/usr/bin/env bash
#
# Sproutboat single-VPS installer.
#
#   git clone https://github.com/<you>/sproutboat && cd sproutboat
#   sudo ./install.sh
#
# Provisions one Linux x86-64 host as a single-admin Sproutboat instance:
# Caddy (public), control + edge + dashboard on loopback, one admin identity.
# Multi-tenant / fleet deployment is a separate project (sproutboat-cloud).
#
# Non-interactive: set SB_DOMAIN, SB_ACME_EMAIL, SB_ADMIN and optionally
# SB_DASHBOARD=yes|no, SB_GITHUB_CLIENT_ID, SB_GITHUB_CLIENT_SECRET.
# SB_CF_TOKEN is optional — set it only to use DNS-01 (inbound :80 blocked).

set -euo pipefail

BUN_VERSION="1.4.0"
ROOT=/opt/sproutboat
STATE=/var/lib/sproutboat
ETC=/etc/sproutboat
CADDY_BIN=/usr/local/bin/caddy-sproutboat

say()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!  \033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mx  \033[0m %s\n' "$*" >&2; exit 1; }
ask()  { # ask VAR "prompt" ["default"]
  local __v=$1 __p=$2 __d=${3:-} __a
  if [ -n "${!__v:-}" ]; then return; fi
  if [ ! -t 0 ]; then die "$__v is unset and stdin is not a TTY (set it in the environment for non-interactive installs)"; fi
  read -r -p "$__p${__d:+ [$__d]}: " __a || true
  printf -v "$__v" '%s' "${__a:-$__d}"
}

# SB_SKIP_SERVICES=1 provisions files + builds but does not touch systemd, the
# firewall, or the Docker daemon — for testing the installer in a container/CI.
SKIP_SERVICES=${SB_SKIP_SERVICES:-0}

[ "$(id -u)" = 0 ] || die "run as root (sudo ./install.sh)"
[ "$(uname -s)" = Linux ] || die "Linux only"
[ "$(uname -m)" = x86_64 ] || die "x86-64 only (artifact target is linux-x86_64)"
if [ "$SKIP_SERVICES" != 1 ]; then
  command -v systemctl >/dev/null || die "systemd required"
  [ -f /sys/fs/cgroup/cgroup.controllers ] || die "cgroups v2 unified hierarchy required (boot with systemd.unified_cgroup_hierarchy=1)"
else
  warn "SB_SKIP_SERVICES=1 — systemd, firewall, Docker image build, and service start are skipped"
fi

# Locate the source tree.
SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
[ -f "$SRC/package.json" ] && [ -d "$SRC/apps/control" ] || die "run this from a Sproutboat checkout"

# --- distro -----------------------------------------------------------------
. /etc/os-release
case "${ID:-}${ID_LIKE:+ $ID_LIKE}" in
  *debian*|*ubuntu*) PKG=apt ;;
  *rhel*|*fedora*|*centos*|*rocky*|*almalinux*|*amzn*) PKG=dnf ;;
  *) die "unsupported distro '${ID:-?}' — need a Debian/Ubuntu or RHEL-family host" ;;
esac
say "Host: ${PRETTY_NAME:-$ID} ($PKG)"

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
say "Installing host packages"
if [ "$PKG" = apt ]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl rsync bubblewrap docker.io ufw unzip
else
  dnf install -y -q ca-certificates curl rsync bubblewrap podman-docker ufw unzip || \
    dnf install -y -q ca-certificates curl rsync bubblewrap docker ufw unzip
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
for u in sproutboat-control sproutboat-edge sproutboat-web; do
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
( cd "$ROOT" && "$BUN" install --frozen-lockfile )

if [ "$SKIP_SERVICES" = 1 ]; then
  say "Runtime image build — skipped (SB_SKIP_SERVICES)"
else
  say "Building the Linux runtime image (docker)"
  systemctl enable --now docker >/dev/null 2>&1 || true
  ( cd "$ROOT" && docker build --platform linux/amd64 -t sproutboat/build:stable -f build-image/Dockerfile . )
fi

say "Building the dashboard"
( cd "$ROOT" && "$BUN" run web:build )

# --- gather config ----------------------------------------------------
say "Configuration"
ask SB_DOMAIN      "Deployment domain (e.g. fn.example.com)"
ask SB_ACME_EMAIL  "ACME / Let's Encrypt email"
ask SB_ADMIN    "Admin username (3-32 lowercase, a-z 0-9 -)" "$(echo "${SUDO_USER:-admin}" | tr -cd 'a-z0-9-' | cut -c1-32)"
[[ "$SB_ADMIN" =~ ^[a-z0-9]([a-z0-9-]{1,30}[a-z0-9])?$ ]] || die "invalid admin username: $SB_ADMIN"
DASH_URL="https://dashboard.$SB_DOMAIN"

# Reuse secrets across re-runs so an existing CLI login / session keeps working.
grep_env() { [ -f "$ETC/control.env" ] || return 0; sed -n "s/^$1=//p" "$ETC/control.env" | head -1; }
ADMIN_TOKEN=$(grep_env SPROUTBOAT_BOOTSTRAP_TOKEN)
if [ -n "$ADMIN_TOKEN" ]; then TOKEN_IS_NEW=0; else ADMIN_TOKEN=$(openssl rand -hex 32); TOKEN_IS_NEW=1; fi

ask SB_DASHBOARD "Enable the web dashboard? Needs a GitHub OAuth app (yes/no)" "no"
DASHBOARD_ENABLED=no
if [[ "$SB_DASHBOARD" =~ ^[Yy] ]]; then
  DASHBOARD_ENABLED=yes
  ask SB_GITHUB_CLIENT_ID     "GitHub OAuth client id"
  ask SB_GITHUB_CLIENT_SECRET "GitHub OAuth client secret"
  BETTER_AUTH_SECRET=$(grep_env BETTER_AUTH_SECRET); BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET:-$(openssl rand -hex 32)}
fi

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
  if [ "$DASHBOARD_ENABLED" = yes ]; then
    echo "BETTER_AUTH_SECRET=$BETTER_AUTH_SECRET"
    echo "BETTER_AUTH_URL=$DASH_URL"
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
  if [ "$DASHBOARD_ENABLED" = yes ]; then
    cat <<EOF

dashboard.$SB_DOMAIN {
	handle /api/* {
		reverse_proxy 127.0.0.1:8787
	}
	handle {
		reverse_proxy 127.0.0.1:3000
	}
}
EOF
  fi
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
for u in sproutboat-control sproutboat-edge sproutboat-web; do
  install -m 0644 "$ROOT/infra/systemd/$u.service" "/etc/systemd/system/$u.service"
done

if [ "$SKIP_SERVICES" = 1 ]; then
  say "daemon-reload + service start + preflight — skipped (SB_SKIP_SERVICES)"
else
  systemctl daemon-reload

  # --- start (control first — its env now exists) ----------------
  say "Starting services"
  units=(sproutboat-control sproutboat-edge caddy)
  [ "$DASHBOARD_ENABLED" = yes ] && units+=(sproutboat-web)
  systemctl enable --now "${units[@]}"

  # --- verify ---------------------------------------------------
  say "Runtime preflight"
  ( cd "$ROOT" && "$BUN" run runtime:preflight ) || warn "preflight reported problems — review above; deployments need bubblewrap working"
fi

echo
if [ "$TOKEN_IS_NEW" = 1 ]; then
  say "Done. Save the admin token — it is shown once:"
else
  say "Done. Admin token unchanged from your last install:"
fi
echo
echo "    SPROUTBOAT_API_URL   https://control.$SB_DOMAIN"
echo "    SPROUTBOAT_TOKEN     $ADMIN_TOKEN"
echo
IP=$(curl -fsS4 https://api.ipify.org 2>/dev/null || echo "<this-host-ipv4>")
say "Create ONE DNS record (DNS only / grey cloud):"
echo "    *.$SB_DOMAIN    A   $IP"
covered="control.$SB_DOMAIN"
[ "$DASHBOARD_ENABLED" = yes ] && covered="$covered, dashboard.$SB_DOMAIN"
echo
echo "  A wildcard covers $covered, and every <project>.$SB_ADMIN.$SB_DOMAIN"
echo "  deployment. Prefer IaC? cd infra/tofu && tofu apply."
echo
say "Then from your workstation:"
echo "    sproutboat login --api-url https://control.$SB_DOMAIN --token <token>"
echo "    sproutboat init hello && cd hello && sproutboat deploy"
[ "$DASHBOARD_ENABLED" = yes ] && echo "    GitHub OAuth callback: $DASH_URL/api/auth/callback/github"
echo
warn "Back up $STATE (SQLite + artifacts) — take a provider snapshot now; a restic job is not yet wired."

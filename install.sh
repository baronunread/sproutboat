#!/usr/bin/env bash
#
# Sproutboat single-VPS installer. SSH into a fresh Linux box and:
#
#   curl -fsSL https://raw.githubusercontent.com/baronunread/sproutboat/main/install.sh | sudo bash
#   # or, from a checkout:  sudo ./install.sh
#
# It asks a few questions up front, then runs unattended: packages, Caddy,
# bubblewrap, a firewall, one admin identity, and the control + edge
# (+ optional dashboard) services. It pauses once to let you add a DNS record.
#
# Non-interactive: set SB_DOMAIN, SB_ACME_EMAIL, SB_ADMIN and optionally
# SB_DASHBOARD=yes|no, SB_GITHUB_CLIENT_ID, SB_GITHUB_CLIENT_SECRET.
# SB_CF_TOKEN — optional, only to use DNS-01 (inbound :80 blocked).
# SB_SKIP_DNS_CHECK=1 — don't wait for DNS to resolve.
# SB_WITH_BUILD_IMAGE=1 — also install Docker + pull the compile toolchain image,
#   so `sproutboat build` works on this box too (normally it runs on your laptop).

set -euo pipefail

BUN_VERSION="1.4.0"
ROOT=/opt/sproutboat
STATE=/var/lib/sproutboat
ETC=/etc/sproutboat
CADDY_BIN=/usr/local/bin/caddy-sproutboat
SB_REPO=${SB_REPO:-https://github.com/baronunread/sproutboat.git}
SB_REF=${SB_REF:-main}

say()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!  \033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mx  \033[0m %s\n' "$*" >&2; exit 1; }
randhex() { od -An -tx1 -N32 /dev/urandom | tr -d " \n"; }  # 64 hex chars, no external deps
ask()  { # ask VAR "prompt" ["default"]
  local __v=$1 __p=$2 __d=${3:-} __a
  if [ -n "${!__v:-}" ]; then return; fi
  if [ ! -t 0 ]; then die "$__v is unset and stdin is not a TTY (set it in the environment for non-interactive installs)"; fi
  read -r -p "$__p${__d:+ [$__d]}: " __a || true
  printf -v "$__v" '%s' "${__a:-$__d}"
}

# SB_SKIP_SERVICES=1 provisions files + builds but does not touch systemd, the
# firewall, or Docker — for testing the installer in a container/CI.
SKIP_SERVICES=${SB_SKIP_SERVICES:-0}

[ "$(id -u)" = 0 ] || die "run as root (sudo ./install.sh)"
[ "$(uname -s)" = Linux ] || die "Linux only"
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
ask SB_DASHBOARD  "Enable the web dashboard? (needs a GitHub OAuth app) yes/no" "no"
DASHBOARD_ENABLED=no
if [[ "$SB_DASHBOARD" =~ ^[Yy] ]]; then
  DASHBOARD_ENABLED=yes
  ask SB_GITHUB_CLIENT_ID     "GitHub OAuth client id"
  ask SB_GITHUB_CLIENT_SECRET "GitHub OAuth client secret"
fi
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
# The server runs deployments under bubblewrap — no Docker. Docker is only for
# `sproutboat build` (the compile toolchain), which normally runs on your
# workstation. SB_WITH_BUILD_IMAGE=1 adds it so you can also build on this box.
WITH_IMAGE=${SB_WITH_BUILD_IMAGE:-0}
say "Installing host packages"
if [ "$PKG" = apt ]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl git patch rsync bubblewrap ufw unzip dnsutils
  [ "$WITH_IMAGE" = 1 ] && apt-get install -y -qq docker.io
else
  dnf install -y -q ca-certificates curl git patch rsync bubblewrap ufw unzip bind-utils
  [ "$WITH_IMAGE" = 1 ] && { dnf install -y -q podman-docker || dnf install -y -q docker; }
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

# The Porffor compile toolchain image is a `sproutboat build` dependency and
# normally lives on your laptop (like `wrangler deploy`). Only fetch it here if
# you also want to build/deploy from this box.
if [ "$WITH_IMAGE" != 1 ] || [ "$SKIP_SERVICES" = 1 ]; then
  say "Build toolchain image — not needed on the server (set SB_WITH_BUILD_IMAGE=1 to build here too)"
elif [ "${SB_BUILD_LOCAL:-0}" = 1 ]; then
  say "Building the toolchain image locally"
  systemctl enable --now docker >/dev/null 2>&1 || true
  ( cd "$ROOT" && docker build --platform linux/amd64 -t "${SB_IMAGE:-ghcr.io/baronunread/sproutboat/build:latest}" -f build-image/Dockerfile . )
else
  SB_IMAGE=${SB_IMAGE:-ghcr.io/baronunread/sproutboat/build:latest}
  say "Pulling toolchain image $SB_IMAGE"
  systemctl enable --now docker >/dev/null 2>&1 || true
  [ -n "${SB_GHCR_TOKEN:-}" ] && printf '%s' "$SB_GHCR_TOKEN" | docker login ghcr.io -u "${SB_GHCR_USER:-x}" --password-stdin >/dev/null
  docker pull --platform linux/amd64 "$SB_IMAGE" \
    || die "could not pull $SB_IMAGE — make the GHCR package public, or set SB_GHCR_TOKEN, or SB_BUILD_LOCAL=1"
fi

say "Building the dashboard"
( cd "$ROOT" && "$BUN" run web:build )

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

# --- DNS: guide the one record, then wait for it to resolve here --------
PUBLIC_IP=$(curl -fsS4 -m 5 https://api.ipify.org 2>/dev/null || true)
covers="control.$SB_DOMAIN"
[ "$DASHBOARD_ENABLED" = yes ] && covers="$covers, dashboard.$SB_DOMAIN"
echo
say "Add ONE DNS record, then Caddy can issue TLS certificates:"
echo
echo "      Type:   A"
echo "      Name:   *.$SB_DOMAIN     (a wildcard — the name is literally  *  )"
echo "      Value:  ${PUBLIC_IP:-<the public IPv4 of this box>}"
echo "      Proxy:  OFF / DNS only / grey cloud"
echo
echo "  Covers $covers, and every <project>.$SB_ADMIN.$SB_DOMAIN"
echo "  deployment. No DNS API token needed."
echo
if [ "$SKIP_SERVICES" = 1 ] || [ "${SB_SKIP_DNS_CHECK:-0}" = 1 ] || [ -z "$PUBLIC_IP" ] || [ ! -t 0 ]; then
  warn "Not waiting for DNS — the record must exist before the first HTTPS request."
else
  probe="sbdns-$RANDOM.$SB_DOMAIN"
  say "Waiting for *.$SB_DOMAIN -> $PUBLIC_IP   (any key to skip)"
  for _ in $(seq 1 120); do
    got=$(getent ahostsv4 "$probe" 2>/dev/null | awk 'NR==1{print $1}')
    [ "$got" = "$PUBLIC_IP" ] && { say "DNS is live."; break; }
    if read -r -t 10 -n 1 -s _k; then warn "Skipped the DNS wait."; break; fi
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

# Keep the token retrievable — the SSH scrollback is not a safe home for it.
printf 'SPROUTBOAT_API_URL=https://control.%s\nSPROUTBOAT_TOKEN=%s\n' "$SB_DOMAIN" "$ADMIN_TOKEN" > /root/sproutboat-admin.env
chmod 0600 /root/sproutboat-admin.env

echo
say "Done."
echo
if [ "$TOKEN_IS_NEW" = 1 ]; then echo "  Admin credentials (also saved to /root/sproutboat-admin.env):"
else echo "  Admin credentials (unchanged from your last install):"; fi
echo
echo "      SPROUTBOAT_API_URL   https://control.$SB_DOMAIN"
echo "      SPROUTBOAT_TOKEN     $ADMIN_TOKEN"
echo
say "On your workstation, install the CLI and log in:"
echo "      bunx @sproutboat/cli login --api-url https://control.$SB_DOMAIN --token <token>"
echo "      sproutboat init hello && cd hello && sproutboat deploy"
[ "$DASHBOARD_ENABLED" = yes ] && echo "      GitHub OAuth callback URL: $DASH_URL/api/auth/callback/github"
echo
say "Check it came up:   systemctl status caddy sproutboat-control sproutboat-edge"
echo "                    journalctl -fu caddy      # watch the first certificate"
echo
warn "Back up $STATE (SQLite + artifacts). Take a provider snapshot now."

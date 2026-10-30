#!/usr/bin/env bash
#
# A staging copy of the platform next to sproutd, for design 05 phase 1. Run as root on a
# disposable Linux VM (Debian or Ubuntu, systemd, cgroup v2); never on a production host.
#
#   tools/sproutd-staging.sh install   provision and start everything
#   tools/sproutd-staging.sh update    what `sbctl update` does to the platform units
#   tools/sproutd-staging.sh status
#   tools/sproutd-staging.sh uninstall remove units, users and the prefix (keeps nothing)
#
# What it is: control, edge and egress from this checkout, unmodified, under their own prefix, users,
# ports and unit names (sbstg-*), plus sproutd and its adapter from a sproutd checkout and a built
# generation. Units are the repo's own files with paths, users and ports rewritten by sed, so what
# runs is what ships. There is no Caddy, no TLS and no DNS: tests send Host headers to the edge on
# localhost. install.sh itself is not run: it opens a firewall, writes sysctls and installs Caddy
# system-wide, none of which a staging copy should do. `update` takes the restart list from this
# checkout's install.sh instead, so a sproutd unit added to it would be restarted here too.
#
# Inputs (environment):
#   SBSTG_PREFIX       /data/sbstg
#   SBSTG_SRC          this checkout (default: the directory above this script)
#   SBSTG_SPROUTD_SRC  a sproutd checkout (deploy/ is installed from it)
#   SBSTG_GENERATION   a built generation: <dir>/native-host/{native-host,module-a.so,libsprout-native.so}
#   SBSTG_DOMAIN       stg.sproutboat.test      SBSTG_ADMIN  stgadmin
#   SBSTG_PORTS        edge, control, egress, sproutd: 18080 18787 18070 18600
set -euo pipefail

PREFIX=${SBSTG_PREFIX:-/data/sbstg}
SRC=${SBSTG_SRC:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}
SPROUTD_SRC=${SBSTG_SPROUTD_SRC:-}
GENERATION=${SBSTG_GENERATION:-}
DOMAIN=${SBSTG_DOMAIN:-stg.sproutboat.test}
ADMIN=${SBSTG_ADMIN:-stgadmin}
read -r PORT_EDGE PORT_CONTROL PORT_EGRESS PORT_SPROUTD <<<"${SBSTG_PORTS:-18080 18787 18070 18600}"
SUBUID_BASE=${SBSTG_SUBUID_BASE:-300000}

ROOT=$PREFIX/opt/sproutboat
STATE=$PREFIX/var/lib/sproutboat
ETC=$PREFIX/etc/sproutboat
SD_ROOT=$PREFIX/opt/sproutd
SD_ETC=$PREFIX/etc/sproutd
UNITS=/etc/systemd/system
BUN=/usr/local/bin/bun
PLATFORM_UNITS=(sbstg-control sbstg-egress sbstg-edge)
SPROUTD_UNITS=(sbstg-sproutd sbstg-sproutd-adapter)

die() { printf '! %s\n' "$*" >&2; exit 1; }
say() { printf '\n== %s\n' "$*"; }
[ "$(id -u)" = 0 ] || die "run as root"
[ "$(uname -s)" = Linux ] || die "Linux only"
[ "$PREFIX" != / ] && [ "$PREFIX" != /opt ] && [ -n "$PREFIX" ] || die "unsafe prefix: $PREFIX"
[ -x "$BUN" ] || die "bun not found at $BUN"
randhex() { od -An -tx1 -N32 /dev/urandom | tr -d ' \n'; }

# The repo's unit files, rewritten for the staging names. Order matters: longer names first.
stage_platform_unit() { # SOURCE
  sed -e "s#/opt/sproutboat#$ROOT#g" \
      -e "s#/var/lib/sproutboat#$STATE#g" \
      -e "s#/etc/sproutboat#$ETC#g" \
      -e "s#sproutboat-control#sbstg-control#g; s#sproutboat-edge#sbstg-edge#g; s#sproutboat-egress#sbstg-egress#g" \
      -e "s#^Group=sproutboat\$#Group=sbstg#" \
      -e "s#^Environment=PORT=8080\$#Environment=PORT=$PORT_EDGE#" \
      -e "s#^Environment=PORT=8787\$#Environment=PORT=$PORT_CONTROL#" \
      -e "s#127.0.0.1:8070#127.0.0.1:$PORT_EGRESS#g; s#--port 8070#--port $PORT_EGRESS#" \
      "$1"
}
stage_sproutd_unit() { # SOURCE
  sed -e "s#/opt/sproutd#$SD_ROOT#g; s#/etc/sproutd#$SD_ETC#g" \
      -e "s#/var/lib/sproutd-adapter#/var/lib/sbstg-sproutd-adapter#g; s#/var/lib/sproutd\\b#/var/lib/sbstg-sproutd#g" \
      -e "s#/run/sproutd-adapter#/run/sbstg-sproutd-adapter#g; s#/run/sproutd\\b#/run/sbstg-sproutd#g" \
      -e "s#^StateDirectory=sproutd-adapter\$#StateDirectory=sbstg-sproutd-adapter#; s#^StateDirectory=sproutd\$#StateDirectory=sbstg-sproutd#" \
      -e "s#^RuntimeDirectory=sproutd-adapter\$#RuntimeDirectory=sbstg-sproutd-adapter#; s#^RuntimeDirectory=sproutd\$#RuntimeDirectory=sbstg-sproutd#" \
      -e "s#^User=sproutd\$#User=sbstg-sproutd#; s#^Group=sproutd\$#Group=sbstg-sproutd#; s#^Group=sproutd-api\$#Group=sbstg-sproutd-api#" \
      -e "s#=sproutd\\.service\$#=sbstg-sproutd.service#" \
      "$1"
}

sync_tree() { # SRC DEST: a clean mirror that keeps node_modules and bun (no rsync on a stock VM)
  local from=$1 to=$2
  install -d -m 0755 "$to"
  find "$to" -mindepth 1 -maxdepth 1 ! -name node_modules ! -name bun -exec rm -rf {} +
  (cd "$from" && tar --exclude=./.git --exclude=./node_modules --exclude=./apps/web/dist --exclude=./.sproutboat -cf - .) | (cd "$to" && tar -xf -)
  chmod -R a+rX "$to"
}

write_units() {
  for u in control egress edge; do stage_platform_unit "$ROOT/infra/systemd/sproutboat-$u.service" >"$UNITS/sbstg-$u.service"; done
  if [ -d "$SD_ROOT/deploy/systemd" ]; then
    stage_sproutd_unit "$SD_ROOT/deploy/systemd/sproutd.service" >"$UNITS/sbstg-sproutd.service"
    stage_sproutd_unit "$SD_ROOT/deploy/systemd/sproutd-adapter.service" >"$UNITS/sbstg-sproutd-adapter.service"
  fi
  # The staged sbctl: the repo's script with its paths and unit names rewritten (no Caddy here).
  sed -e "s#^ROOT=/opt/sproutboat#ROOT=$ROOT#; s#^STATE=/var/lib/sproutboat#STATE=$STATE#" \
      -e "s#^TOKEN_FILE=.*#TOKEN_FILE=$ETC/admin.env#; s#^UPDATER=.*#UPDATER=$PREFIX/bin/sbstg-update#" \
      -e "s#^SERVICES=.*#SERVICES=(sbstg-control sbstg-egress sbstg-edge)#; s#^UNITS=.*#UNITS=(\"\${SERVICES[@]}\")#" \
      -e "s#sproutboat-control#sbstg-control#g; s#sproutboat-edge#sbstg-edge#g; s#sproutboat-egress#sbstg-egress#g" \
      -e "s#sproutboat-backup#sbstg-backup#g; s#chown -R sbstg-control:sproutboat#chown -R sbstg-control:sbstg#; s#sbstg-edge:sproutboat#sbstg-edge:sbstg#" \
      "$ROOT/infra/sbctl" >"$PREFIX/bin/sbctl"
  chmod 0755 "$PREFIX/bin/sbctl"
  systemctl daemon-reload
}

cmd_install() {
  say "Users and directories under $PREFIX"
  getent group sbstg >/dev/null || groupadd --system sbstg
  for u in sbstg-control sbstg-edge; do
    id "$u" >/dev/null 2>&1 || useradd --system --gid sbstg --no-create-home --shell /usr/sbin/nologin "$u"
  done
  if [ -n "$SPROUTD_SRC" ]; then
    getent group sbstg-sproutd >/dev/null || groupadd --system sbstg-sproutd
    getent group sbstg-sproutd-api >/dev/null || groupadd --system sbstg-sproutd-api
    id sbstg-sproutd >/dev/null 2>&1 || useradd --system --gid sbstg-sproutd --no-create-home --shell /usr/sbin/nologin sbstg-sproutd
    usermod -aG sbstg-sproutd-api sbstg-control
    # sproutd's per-app uids come from the daemon user's subuid range (`uids` in sproutd.conf).
    grep -q '^sbstg-sproutd:' /etc/subuid || echo "sbstg-sproutd:$SUBUID_BASE:65536" >>/etc/subuid
    grep -q '^sbstg-sproutd:' /etc/subgid || echo "sbstg-sproutd:$SUBUID_BASE:65536" >>/etc/subgid
  fi
  install -d -m 0755 "$PREFIX" "$PREFIX/bin" "$PREFIX/opt" "$PREFIX/var" "$PREFIX/var/lib" "$PREFIX/etc"
  install -d -m 0755 -o root "$ROOT"
  install -d -m 0750 -o sbstg-control -g sbstg "$STATE" "$STATE/artifacts"
  install -d -m 0770 -o sbstg-edge -g sbstg "$STATE/logs"
  install -d -m 2770 -o sbstg-edge -g sbstg "$STATE/brokers" "$STATE/resources"
  install -d -m 2770 -o sbstg-control -g sbstg "$STATE/activation"
  install -d -m 0750 -o root -g sbstg "$ETC"

  say "Syncing the platform ($SRC) to $ROOT"
  sync_tree "$SRC" "$ROOT"
  install -d "$ROOT/bun/bin" && ln -sf "$BUN" "$ROOT/bun/bin/bun"
  (cd "$ROOT" && "$BUN" install --frozen-lockfile --silent)
  chmod -R a+rX "$ROOT/node_modules"
  # install.sh builds the dashboard here; a staging copy serves the API only, so the build is skipped.

  say "Environment files"
  local token tokens_env
  token=$(val_env "$ETC/control.env" SPROUTBOAT_BOOTSTRAP_TOKEN); token=${token:-$(randhex)}
  local auth_secret; auth_secret=$(val_env "$ETC/control.env" BETTER_AUTH_SECRET); auth_secret=${auth_secret:-$(randhex)}
  umask 077
  printf 'SPROUTBOAT_DEPLOYMENT_DOMAIN=%s\nSPROUTBOAT_DASHBOARD_URL=https://dashboard.%s\n' "$DOMAIN" "$DOMAIN" >"$ETC/sproutboat.env"
  {
    echo "SPROUTBOAT_DATABASE_PATH=$STATE/sproutboat.sqlite"
    echo "SPROUTBOAT_ARTIFACTS_DIR=$STATE/artifacts"
    echo "SPROUTBOAT_DEPLOYMENTS_PATH=$STATE/deployments.json"
    echo "SPROUTBOAT_BOOTSTRAP_USERNAME=$ADMIN"
    echo "SPROUTBOAT_BOOTSTRAP_TOKEN=$token"
    echo "SPROUTBOAT_ADMIN_EMAILS=stg@example.test"
    echo "BETTER_AUTH_SECRET=$auth_secret"
    echo "BETTER_AUTH_URL=https://dashboard.$DOMAIN"
    echo "SPROUTBOAT_EDGE_INTERNAL_URL=http://127.0.0.1:$PORT_EDGE"
    if [ -n "$SPROUTD_SRC" ]; then
      echo "# design 05: control reaches sproutd only through its adapter, and only for these owners"
      echo "SPROUTBOAT_SPROUTD_ADAPTER_SOCKET=/run/sbstg-sproutd-adapter/adapter.sock"
      echo "SPROUTBOAT_SPROUTD_ADAPTER_TOKEN_FILE=$SD_ETC/adapter.token"
      echo "SPROUTBOAT_SPROUTD_URL=http://127.0.0.1:$PORT_SPROUTD"
      echo "SPROUTBOAT_SPROUTD_OWNERS=$ADMIN"
      echo "SPROUTBOAT_SPROUTD_RECONCILE_MS=5000"
    fi
  } >"$ETC/control.env"
  tokens_env=$(val_env "$ETC/egress.env" SB_EGRESS_TOKEN); echo "SB_EGRESS_TOKEN=${tokens_env:-$(randhex)}" >"$ETC/egress.env"
  printf 'SPROUTBOAT_API_URL=http://127.0.0.1:%s\nSPROUTBOAT_TOKEN=%s\nEDGE=http://127.0.0.1:%s\nDOMAIN=%s\nADMIN=%s\n' \
    "$PORT_CONTROL" "$token" "$PORT_EDGE" "$DOMAIN" "$ADMIN" >"$ETC/admin.env"
  chown root:sbstg "$ETC/sproutboat.env" "$ETC/control.env"; chmod 0640 "$ETC/sproutboat.env" "$ETC/control.env"
  chmod 0600 "$ETC/egress.env" "$ETC/admin.env"
  umask 022

  if [ -n "$SPROUTD_SRC" ]; then
    [ -d "$GENERATION/native-host" ] || die "SBSTG_GENERATION=$GENERATION has no native-host/"
    say "sproutd under $SD_ROOT"
    install -d -m 0755 "$SD_ROOT" "$SD_ROOT/generation/native-host" "$SD_ROOT/deploy" "$SD_ROOT/bun/bin"
    for f in native-host module-a.so libsprout-native.so; do install -m 0755 "$GENERATION/native-host/$f" "$SD_ROOT/generation/native-host/$f"; done
    chmod 0644 "$SD_ROOT/generation/native-host/module-a.so" "$SD_ROOT/generation/native-host/libsprout-native.so"
    rm -rf "$SD_ROOT/deploy" && install -d -m 0755 "$SD_ROOT/deploy"
    (cd "$SPROUTD_SRC/deploy" && tar --exclude='*.test.ts' -cf - .) | (cd "$SD_ROOT/deploy" && tar -xf -)
    chmod -R a+rX "$SD_ROOT/deploy"
    ln -sf "$BUN" "$SD_ROOT/bun/bin/bun"
    install -d -m 0755 "$SD_ETC"
    sed -e "s#^runtime .*#runtime $SD_ROOT/generation/native-host#" \
        -e "s#^state .*#state /var/lib/sbstg-sproutd#" \
        -e "s#^port .*#port $PORT_SPROUTD#" \
        -e "s#^admin .*#admin /run/sbstg-sproutd/admin.sock#" \
        -e "s#^uids .*#uids $SUBUID_BASE#" \
        "$SD_ROOT/deploy/sproutd.conf" >"$SD_ETC/sproutd.conf"
    [ -s "$SD_ETC/adapter.token" ] || { (umask 077; randhex >"$SD_ETC/adapter.token"); }
    chown root:sbstg-sproutd-api "$SD_ETC/adapter.token"; chmod 0640 "$SD_ETC/adapter.token"
  fi

  say "Units"
  write_units
  # `update` replaces $ROOT, so the script that runs it lives outside it, with the inputs it needs.
  install -m 0755 "$0" "$PREFIX/bin/sproutd-staging.sh"
  {
    for v in SRC SPROUTD_SRC GENERATION DOMAIN ADMIN PREFIX; do printf 'export SBSTG_%s=%q\n' "$v" "${!v}"; done
    printf 'export SBSTG_PORTS=%q\n' "$PORT_EDGE $PORT_CONTROL $PORT_EGRESS $PORT_SPROUTD"
  } >"$PREFIX/etc/staging.env"
  cat >"$PREFIX/bin/sbstg-update" <<EOF
#!/usr/bin/env bash
. "$PREFIX/etc/staging.env"
exec "$PREFIX/bin/sproutd-staging.sh" update "\$@"
EOF
  chmod 0755 "$PREFIX/bin/sbstg-update"

  say "Auth schema"
  ( cd "$ROOT" && SPROUTBOAT_DATABASE_PATH="$STATE/sproutboat.sqlite" BETTER_AUTH_SECRET="$auth_secret" \
      BETTER_AUTH_URL="https://dashboard.$DOMAIN" "$BUN" x --bun auth@1.7.1 migrate --config apps/control/src/auth.migrate.ts --yes >/dev/null ) \
    && echo "auth schema ready" || echo "! auth migrate failed; bootstrap-token API calls still work"
  for f in routes.json deployments.json; do [ -s "$STATE/$f" ] || { echo '[]' >"$STATE/$f"; chown sbstg-control:sbstg "$STATE/$f"; chmod 0640 "$STATE/$f"; }; done
  chown sbstg-control:sbstg "$STATE"/sproutboat.sqlite* 2>/dev/null || true

  say "Starting"
  systemctl enable "${PLATFORM_UNITS[@]}" >/dev/null 2>&1
  [ -n "$SPROUTD_SRC" ] && systemctl enable "${SPROUTD_UNITS[@]}" >/dev/null 2>&1
  [ -n "$SPROUTD_SRC" ] && systemctl restart sbstg-sproutd sbstg-sproutd-adapter
  systemctl restart sbstg-control sbstg-egress sbstg-edge
  cmd_status
}

val_env() { [ -f "$1" ] || return 0; sed -n "s/^$2=//p" "$1" | head -1; }

# What `sbctl update` does here. install.sh's own restart line is the source of truth: the unit
# names in it are mapped to their staging names (sproutboat-X -> sbstg-X, sproutd* -> sbstg-sproutd*),
# and caddy, which staging has none of, is skipped. A sproutd unit in that line would be restarted.
cmd_update() {
  say "Updating the platform tree from $SRC"
  sync_tree "$SRC" "$ROOT"
  (cd "$ROOT" && "$BUN" install --frozen-lockfile --silent)
  chmod -R a+rX "$ROOT/node_modules"
  write_units
  local line units=()
  line=$(grep -E '^\s*systemctl restart ' "$ROOT/install.sh" | head -1) || die "no restart line in install.sh"
  for name in ${line#*restart}; do
    case $name in
      caddy) ;;
      sproutboat-*) units+=("sbstg-${name#sproutboat-}") ;;
      sproutd-adapter) units+=(sbstg-sproutd-adapter) ;;
      sproutd) units+=(sbstg-sproutd) ;;
      *) units+=("$name") ;;
    esac
  done
  echo "restarting: ${units[*]}"
  systemctl restart "${units[@]}"
}

cmd_status() {
  for u in "${PLATFORM_UNITS[@]}" "${SPROUTD_UNITS[@]}"; do
    [ -f "$UNITS/$u.service" ] || continue
    printf '  %-26s %s  pid %s\n' "$u" "$(systemctl is-active "$u" || true)" "$(systemctl show -p MainPID --value "$u")"
  done
  echo "  edge http://127.0.0.1:$PORT_EDGE  control http://127.0.0.1:$PORT_CONTROL  sproutd http://127.0.0.1:$PORT_SPROUTD"
}

cmd_uninstall() {
  say "Removing the staging install under $PREFIX"
  systemctl disable --now "${PLATFORM_UNITS[@]}" "${SPROUTD_UNITS[@]}" >/dev/null 2>&1 || true
  rm -f "$UNITS"/sbstg-*.service
  systemctl daemon-reload
  rm -rf "$PREFIX" /var/lib/sbstg-sproutd /var/lib/sbstg-sproutd-adapter
  for u in sbstg-control sbstg-edge sbstg-sproutd; do id "$u" >/dev/null 2>&1 && userdel "$u" || true; done
  for g in sbstg sbstg-sproutd sbstg-sproutd-api; do getent group "$g" >/dev/null && groupdel "$g" || true; done
  sed -i '/^sbstg-sproutd:/d' /etc/subuid /etc/subgid
}

case ${1:-} in
  install) cmd_install ;;
  update) cmd_update ;;
  status) cmd_status ;;
  uninstall) cmd_uninstall ;;
  *) sed -n '2,24p' "$0"; exit 1 ;;
esac

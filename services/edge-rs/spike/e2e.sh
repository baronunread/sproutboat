#!/bin/bash
# Local end-to-end check of the spike (Mac or Linux): SNI selection, hot reload, h1 + h2, forwarded
# headers, the port-80 redirect, and on-demand ACME with the ask check against pebble.
#
#   PEBBLE_DIR=/path/to/pebble-checkout PEBBLE_BIN=/path/to/pebble CHALL_BIN=/path/to/pebble-challtestsrv \
#   EDGE=/path/to/sproutboat-edge TOOLS=/path/to/tools-bin ./e2e.sh
#
# Throwaway names only (`*.sproutboat.app` below is never resolved or ordered; `custom*.test` go to pebble).
# Every process is started in the background and killed by recorded PID. Never pkill.
set -u
W=$(mktemp -d); trap 'for p in $PIDS; do kill $p 2>/dev/null; done; rm -rf "$W"' EXIT; PIDS=""
EDGE=${EDGE:?}; TOOLS=${TOOLS:?}
ok() { echo "ok   $*"; }; bad() { echo "FAIL $*"; FAILED=1; }
spawn() { "$@" >>"$W/out.log" 2>&1 & PIDS="$PIDS $!"; }

"$TOOLS/certgen" --out "$W/certs" --accounts 3 >/dev/null
echo '{"version":1,"apps":[]}' > "$W/routes.json"
spawn "$TOOLS/backend" 127.0.0.1:18600
if [ -n "${PEBBLE_BIN:-}" ]; then
  sed -e 's/0.0.0.0:14000/127.0.0.1:14000/; s/0.0.0.0:15000/127.0.0.1:15000/; s/"httpPort": 5002/"httpPort": 18080/' "$PEBBLE_DIR/test/config/pebble-config.json" > "$W/pebble.json"
  ( cd "$PEBBLE_DIR" && PEBBLE_VA_NOSLEEP=1 "$PEBBLE_BIN" -config "$W/pebble.json" -dnsserver 127.0.0.1:18053 >>"$W/out.log" 2>&1 & echo $! > "$W/pebble.pid" ); PIDS="$PIDS $(cat "$W/pebble.pid")"
  spawn "$CHALL_BIN" -defaultIPv4 127.0.0.1 -defaultIPv6 "" -dnsserver 127.0.0.1:18053 -management 127.0.0.1:18055 -http01 "" -https01 "" -tlsalpn01 "" -doh ""
  cat > "$W/ask.ts" <<'TS'
Bun.serve({ hostname: "127.0.0.1", port: 18787, fetch(req) { const d = new URL(req.url).searchParams.get("domain") ?? ""; return d.startsWith("custom") ? new Response("ok") : new Response("no", { status: 403 }); } });
TS
  spawn bun "$W/ask.ts"
  ACME="SPROUTBOAT_TLS_ASK_URL=http://127.0.0.1:18787/internal/tls/allow SPROUTBOAT_TLS_ACME_DIRECTORY=https://localhost:14000/dir SPROUTBOAT_TLS_ACME_ROOT_CA=$PEBBLE_DIR/test/certs/pebble.minica.pem"
fi
env PORT=18610 SPROUTBOAT_EDGE_BACKEND=http://127.0.0.1:18600 SPROUTBOAT_ROUTE_SNAPSHOT="$W/routes.json" \
  SPROUTBOAT_TLS_LISTEN=127.0.0.1:18443 SPROUTBOAT_TLS_HTTP_LISTEN=127.0.0.1:18080 SPROUTBOAT_TLS_CERT_DIR="$W/certs" SPROUTBOAT_TLS_CHECK_SECS=1 ${ACME:-} \
  "$EDGE" >>"$W/out.log" 2>&1 & PIDS="$PIDS $!"
sleep 2
H=hello.acct-00001.sproutboat.app
c() { curl -sk --resolve "$H:18443:127.0.0.1" "$@"; }

[ "$(c --http1.1 "https://$H:18443/")" = "hello from the backend app" ] && ok "h1 over TLS reaches the backend" || bad "h1"
[ "$(c --http2 -o /dev/null -w '%{http_version}' "https://$H:18443/")" = "2" ] && ok "h2 negotiated by ALPN" || bad "h2"
hdr=$(c --http2 -H 'X-Forwarded-For: 6.6.6.6' -H 'X-Forwarded-Proto: http' "https://$H:18443/__headers")
echo "$hdr" | grep -q '^x-forwarded-for: 127.0.0.1$' && echo "$hdr" | grep -q '^x-forwarded-proto: https$' && ! echo "$hdr" | grep -q 6.6.6.6 && ok "spoofed forwarded headers are replaced" || bad "forwarded headers: $hdr"
echo "$hdr" | grep -q "^host: $H" && ok "h2 :authority becomes Host" || bad "h2 host"
curl -sk -o /dev/null --resolve hello.nobody.sproutboat.app:18443:127.0.0.1 "https://hello.nobody.sproutboat.app:18443/" && bad "unknown account answered" || ok "an account without a certificate gets no handshake"
loc=$(curl -s -o /dev/null -D - -H "Host: $H" "http://127.0.0.1:18080/a/b?c=d" | tr -d '\r' | sed -n 's/^location: //p')
[ "$loc" = "https://$H:18443/a/b?c=d" ] && ok "port 80 redirects with 308 keeping path and query" || bad "redirect: $loc"
s1=$(echo | openssl s_client -connect 127.0.0.1:18443 -servername "$H" 2>/dev/null | openssl x509 -noout -serial)
sleep 1.1; "$TOOLS/certgen" --out "$W/certs2" --accounts 3 >/dev/null; cp "$W/certs2/acct-00001/privkey.pem" "$W/certs/acct-00001/privkey.pem"; sleep 0.1; cp "$W/certs2/acct-00001/fullchain.pem" "$W/certs/acct-00001/fullchain.pem"
sleep 2.2
s2=$(echo | openssl s_client -connect 127.0.0.1:18443 -servername "$H" 2>/dev/null | openssl x509 -noout -serial)
[ -n "$s1" ] && [ "$s1" != "$s2" ] && ok "renewed files are served within the check interval, no restart" || bad "hot reload ($s1 / $s2)"

if [ -n "${PEBBLE_BIN:-}" ]; then
  cc() { curl -sk --resolve "$1:18443:127.0.0.1" "https://$1:18443/"; }
  [ "$(cc custom1.test)" = "hello from the backend app" ] && ok "on-demand ACME: first handshake for an allowed custom domain waits, then serves" || bad "acme custom1"
  iss=$(echo | openssl s_client -connect 127.0.0.1:18443 -servername custom1.test 2>/dev/null | openssl x509 -noout -issuer)
  echo "$iss" | grep -q Pebble && ok "issued by the CA ($iss)" || bad "issuer: $iss"
  cc nope.test >/dev/null && bad "denied name answered" || ok "ask refused: no certificate, no order"
  CP=""; for i in 1 2 3 4 5 6; do cc custom2.test >/dev/null & CP="$CP $!"; done; wait $CP
  [ "$(grep -c 'issued custom2.test' "$W/out.log")" = 1 ] && ok "six parallel first handshakes made one order" || bad "singleflight"
  [ "$(stat -c %a "$W/certs/hosts/custom1.test/privkey.pem" 2>/dev/null || stat -f %Lp "$W/certs/hosts/custom1.test/privkey.pem")" = 600 ] && ok "private key written 0600" || bad "key mode"
fi
[ -z "${FAILED:-}" ] && echo "all passed" || { echo "FAILED (log: $W/out.log)"; trap - EXIT; for p in $PIDS; do kill $p 2>/dev/null; done; exit 1; }

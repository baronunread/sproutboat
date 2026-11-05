# Homelab install

Run Sproutboat behind your own reverse proxy, on a LAN, or over Tailscale.
The default install assumes a public VPS: Caddy owns ports 80 and 443, `ufw`
is switched on, and the installer looks up the public IP. Homelab mode drops
all of that.

```sh
curl -fsSL https://raw.githubusercontent.com/baronunread/sproutboat/main/install.sh | sudo bash -s -- --homelab
# or: sudo SB_MODE=homelab ./install.sh
```

`install.sh --public` is the same as the default. On a fresh interactive
install the script asks once: `Install mode (public/homelab)`. A
non-interactive run is public unless `SB_MODE` is set.

What changes in homelab mode:

- No Caddy is downloaded, configured or started.
- `ufw` is not installed and not touched.
- The public IP is not looked up and DNS is not waited for.
- Control serves the dashboard itself, on port 8787.
- You point your own proxy at two ports and print them at the end of the install.

## The two upstreams

Everything your proxy has to know fits in this table.

| Hostname             | Upstream             | What it is                           |
| -------------------- | -------------------- | ------------------------------------ |
| `control.<domain>`   | `http://<bind>:8787` | CLI and API                          |
| `dashboard.<domain>` | `http://<bind>:8787` | Dashboard (control serves the files) |
| `*.<admin>.<domain>` | `http://<bind>:8080` | Your deployments (the edge)          |
| each custom domain   | `http://<bind>:8080` | Custom domains of projects           |

`<bind>` is `127.0.0.1` unless you set `SB_BIND_HOST`.

Rules for the proxy:

- Forward the `Host` header unchanged. The edge routes on it.
- Set `X-Forwarded-Proto` (and `X-Forwarded-For`).
- Pass WebSocket upgrades through.
- Do not buffer or time out streaming responses early.

DNS: point `*.<domain>` at the box's LAN or tailnet address, or at your proxy.
One wildcard record covers control, the dashboard and every deployment.
A deployment is `<project>.<admin>.<domain>`, so a certificate for it needs
`*.<admin>.<domain>` (a `*.<domain>` wildcard does not cover two labels).

## (a) Behind nginx

nginx on the same box, certificates from your own tooling.

```nginx
map $http_upgrade $connection_upgrade { default upgrade; '' close; }

server {
    listen 443 ssl;
    server_name control.fn.example.com dashboard.fn.example.com;
    ssl_certificate     /etc/ssl/fn/fullchain.pem;
    ssl_certificate_key /etc/ssl/fn/privkey.pem;
    client_max_body_size 200m;           # artifact uploads

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
    }
}

server {
    listen 443 ssl;
    server_name *.alice.fn.example.com;  # <admin>.<domain>
    ssl_certificate     /etc/ssl/fn-apps/fullchain.pem;   # cert for *.alice.fn.example.com
    ssl_certificate_key /etc/ssl/fn-apps/privkey.pem;
    client_max_body_size 0;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_buffering off;
    }
}
```

Add a `server` block like the second one for each custom domain.

## (b) Behind Traefik

Use the file provider. It also works when Traefik runs in Docker, as long as
the container can reach the upstream (see the note below).

```yaml
# /etc/traefik/dynamic/sproutboat.yml
http:
  routers:
    sproutboat-control:
      rule: "Host(`control.fn.example.com`) || Host(`dashboard.fn.example.com`)"
      entryPoints: [websecure]
      tls: { certResolver: letsencrypt }
      service: sproutboat-control
    sproutboat-apps:
      rule: "HostRegexp(`^.+\\.alice\\.fn\\.example\\.com$`)"
      entryPoints: [websecure]
      tls:
        certResolver: letsencrypt
        domains:
          - main: "*.alice.fn.example.com"
      service: sproutboat-edge
  services:
    sproutboat-control:
      loadBalancer:
        servers: [{ url: "http://127.0.0.1:8787" }]
    sproutboat-edge:
      loadBalancer:
        servers: [{ url: "http://127.0.0.1:8080" }]
```

Traefik keeps the `Host` header and adds `X-Forwarded-Proto` by default.
A wildcard certificate needs a DNS challenge resolver.

Docker labels cannot point at a process on the host, so they do not fit
here. If Traefik runs in Docker, give its container `network_mode: host` (then
`127.0.0.1` above is the host). The alternative is a non-loopback bind, see
[(g)](#g-sb_bind_host-and-sb_bind_allow).

## (c) Behind Caddy running elsewhere

Your own Caddy, on another machine or in a container. It needs a route to the
box, so set `SB_BIND_HOST` (see [(g)](#g-sb_bind_host-and-sb_bind_allow)), or
run Caddy on the same box.

One block per hostname group, no `on_demand_tls`:

```caddy
control.fn.example.com, dashboard.fn.example.com {
	reverse_proxy 192.168.1.20:8787
}

*.alice.fn.example.com {
	tls {
		dns cloudflare {env.CLOUDFLARE_API_TOKEN}
	}
	reverse_proxy 192.168.1.20:8080
}
```

Caddy passes `Host` through and sets `X-Forwarded-*` itself.

The one-line forms: a wildcard needs a DNS challenge (as above). Without one,
list the hosts you use, each gets a normal HTTP-01 certificate:

```caddy
hello.alice.fn.example.com { reverse_proxy 192.168.1.20:8080 }
```

## (d) LAN only, with local DNS

No public DNS, no certificates, or a private CA.

1. Pick a domain that only your LAN resolves, for example `fn.lan`.
2. Answer a wildcard for it from your local DNS.

   dnsmasq (Pi-hole reads `/etc/dnsmasq.d/` too):

   ```
   address=/fn.lan/192.168.1.20
   ```

   AdGuard Home: DNS rewrites, add `*.fn.lan` pointing to `192.168.1.20`.

3. Install with a plain-HTTP scheme:

   ```sh
   sudo SB_MODE=homelab SB_SCHEME=http SB_DOMAIN=fn.lan ./install.sh
   ```

4. Put a proxy on `192.168.1.20` port 80. Caddy as your own proxy:

   ```caddy
   {
   	auto_https off
   }
   http://control.fn.lan, http://dashboard.fn.lan {
   	reverse_proxy 127.0.0.1:8787
   }
   http://*.alice.fn.lan {
   	reverse_proxy 127.0.0.1:8080
   }
   ```

`SB_SCHEME=http` makes every URL `http://...`: `DASH_URL`, `BETTER_AUTH_URL`,
`SPROUTBOAT_DASHBOARD_URL` and the API URL in `/root/sproutboat-admin.env`.
The admin token and session cookie cross the network in clear text, so use it
only on a network you trust.

For HTTPS on a LAN keep `SB_SCHEME=https` and let your proxy do TLS with a
private CA. With Caddy, `tls internal`:

```caddy
control.fn.lan, dashboard.fn.lan {
	tls internal
	reverse_proxy 127.0.0.1:8787
}
*.alice.fn.lan {
	tls internal
	reverse_proxy 127.0.0.1:8080
}
```

Install Caddy's root certificate on your clients
(`/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt`).

## (e) Tailscale

`tailscale serve` can front control on the box's MagicDNS name with a real
HTTPS certificate, with no inbound ports:

```sh
sudo tailscale serve --bg --https=443 http://127.0.0.1:8787
# https://box.tailnet-name.ts.net now reaches control
```

Be clear about what that gives you:

- `tailscale serve` knows your node name only. It cannot route per `Host`, and
  MagicDNS has no wildcards. So it cannot serve `*.<admin>.<domain>` apps.
- Sign-in is tied to `dashboard.<domain>` (`BETTER_AUTH_URL`). The dashboard
  therefore needs a name under a domain of your own, not the MagicDNS name.

So apps, and the dashboard, need a domain you own:

1. Install with that domain: `SB_MODE=homelab SB_DOMAIN=fn.example.com`.
2. Make `*.fn.example.com` resolve to the box's tailnet address (`100.x.y.z`).
   Either a public DNS record with that private address, or Tailscale split DNS
   to a resolver you run (a dnsmasq line `address=/fn.example.com/100.x.y.z`).
3. Run a proxy on the box that listens on the tailnet address. The simplest is
   the bundled Caddy with DNS-01, see [(f)](#f-dns-01-with-cloudflare-and-caddy-on-the-box).

Tailscale's `100.64.0.0/10` range is in the default `SB_BIND_ALLOW`.

## (f) DNS-01 with Cloudflare and Caddy on the box

You can keep the bundled Caddy in homelab mode. Without inbound port 80 it
needs DNS-01, which `SB_CF_TOKEN` provides (a Cloudflare token with `Zone:Read`
and `DNS:Edit`).

```sh
sudo SB_MODE=homelab SB_PROXY=caddy SB_CF_TOKEN=... SB_DOMAIN=fn.example.com \
  SB_ACME_EMAIL=you@example.com SB_ADMIN=alice ./install.sh
```

- Caddy asks Let's Encrypt for certificates over DNS-01, so port 80 can stay
  closed.
- The token is stored in `/etc/sproutboat/caddy.env` and read back on every
  update, so `sbctl update` keeps DNS-01. Other settings for the Caddy process go
  in `caddy.local.env`, which updates never rewrite.
- Caddy listens on 80 and 443 of the box. Point your DNS wildcard at the
  address your clients reach (LAN or tailnet).
- `ufw` stays off unless you set `SB_FIREWALL=ufw`.
- `SB_ACME_STAGING=1` uses the Let's Encrypt staging CA. It is kept in
  `install.env`; run once with `SB_ACME_STAGING=0` to go back to production.

The Caddy build with the Cloudflare module is fetched from caddyserver.com and
is not checksum-verified (the stock build is).

## (g) SB_BIND_HOST and SB_BIND_ALLOW

By default control (8787) and the edge (8080) listen on `127.0.0.1`, and the
proxy is the only LAN listener. That is the layout to prefer.

If the proxy lives on another machine, you can bind them to a LAN address:

```sh
sudo SB_MODE=homelab SB_BIND_HOST=192.168.1.20 ./install.sh
# or every interface: SB_BIND_HOST=0.0.0.0
```

A non-loopback value is accepted only in homelab mode. The installer writes
`/etc/systemd/system/sproutboat-{control,edge}.service.d/20-sproutboat-bind.conf`
on every run, and removes it when you go back to loopback.

The edge unit has `IPAddressDeny=any` and `IPAddressAllow=localhost`. That
filter works in both directions, and it is what keeps sprouts off your network
(the sandbox does not unshare the network). A LAN client could not reach the
edge with it in place, so the edge drop-in adds `IPAddressAllow=` lines for
`SB_BIND_ALLOW`. The default is:

```
10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16 fc00::/7 fe80::/10
```

Narrow it to your own subnets: `SB_BIND_ALLOW="192.168.1.0/24"`. Entries are
validated as CIDRs.

**Warning.** Those ranges are open to the whole edge cgroup. That includes every
sprout. A sprout can then open connections to hosts in those ranges directly:
your router, your NAS, other machines on the tailnet. The isolation is relaxed
to exactly the allowed ranges. With a loopback bind none of this happens.

Also note that `/internal/*` on control (health, the TLS allow hook) is then
reachable from the LAN. Keep the allow list tight, or filter at the proxy.

`SB_EGRESS_ALLOW` is a different knob. It lets sprouts' `fetch()` reach private
addresses through the egress service. Add the addresses (comma-separated) to
`/etc/sproutboat/egress.local.env` for an app that must talk to a LAN service, and
`systemctl restart sproutboat-egress`. See [Outbound fetch](../infra/README.md#outbound-fetch).

## (h) Updates, health, backups and restore

- `sbctl update` reads `/etc/sproutboat/install.env`, so the mode, proxy,
  scheme and bind address are kept. A mode change needs an explicit
  `SB_MODE=...` on that run.
- `sbctl health` (and the update's health gate) drops the `caddy` unit and the
  port 80 check when `SB_PROXY=external`. With a specific `SB_BIND_HOST` it
  probes that address. The JSON output has the same shape.
- `sbctl status`, `up`, `down`, `restart` and `memory` leave Caddy out.
  `sbctl logs caddy` says there is no Caddy; read your proxy's own logs.
- `sbctl mode` prints the `install.env` settings.
- Backups work without Caddy: there is just no `caddy/` data in the archive.
  `sbctl restore` says "no Caddy data in the archive" and carries on. It
  rewrites `/root/sproutboat-admin.env` with the scheme from the restored
  `install.env`.
- Rollback restores `install.env` and the bind drop-ins with the rest of
  `/etc`, and skips the Caddy restart on an external install.
- If a Caddy from an earlier public install is still on the box, the installer
  leaves it alone and stops managing it. `--uninstall` keeps `/etc/caddy` on an
  external install.

## (i) install.env

`/etc/sproutboat/install.env` is root-owned, mode 0644, and has no secrets.
The installer writes it and backfills it on a re-run. An environment variable
overrides the file. A box without the file is a public install.

| Key               | Values                                             | Default                                   |
| ----------------- | -------------------------------------------------- | ----------------------------------------- |
| `SB_MODE`         | `public`, `homelab`                                | `public`                                  |
| `SB_PROXY`        | `caddy`, `external`                                | `caddy` in public, `external` in homelab  |
| `SB_FIREWALL`     | `ufw`, `off`                                       | `ufw` in public, `off` in homelab         |
| `SB_SSH_PORT`     | port number, kept open by `ufw`                    | `22`                                      |
| `SB_SCHEME`       | `https`, `http` (`http` needs `SB_PROXY=external`) | `https`                                   |
| `SB_BIND_HOST`    | IP address (non-loopback needs homelab)            | `127.0.0.1`                               |
| `SB_BIND_ALLOW`   | space-separated CIDRs for the edge                 | private, CGNAT, link-local and ULA ranges |
| `SB_ACME_STAGING` | `0`, `1`                                           | `0`                                       |

`SB_FIREWALL=off` is accepted in public mode too, if you manage `ufw` yourself.
With `ufw` the installer allows `SB_SSH_PORT`, 80 and 443, and installs the
package only then.

The Cloudflare token is not in this file. It lives in `caddy.env`, which is
mode 0640, and is read back from there. Neither file takes settings of your own
beyond the keys above; other settings live in the `*.local.env` files (see
[Where settings live](../infra/README.md#where-settings-live)).

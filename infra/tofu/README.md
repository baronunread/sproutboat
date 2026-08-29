# DNS as code (OpenTofu)

Manages the Cloudflare DNS records the POC needs, so `infra/README.md`'s
"create these records by hand" step becomes `tofu apply`.

| Record | Type | Target | Proxy |
| --- | --- | --- | --- |
| `dashboard.sproutboat.com` | A / AAAA | VPS | DNS only |
| `*.sproutboat.com` | A / AAAA | VPS | DNS only |
| `sproutboat.com`, `www` | CNAME | Pages (`pages_cname_target`) | proxied — optional |

The dashboard and wildcard records stay **unproxied**: Caddy issues exact certs
for nested hosts like `hello.andrea.sproutboat.com` over a Cloudflare DNS-01
challenge, which Universal SSL can't cover.

## Use

```sh
cd infra/tofu
cp terraform.tfvars.example terraform.tfvars   # set zone_id + vps_ipv4
export CLOUDFLARE_API_TOKEN=...                 # Zone:Read + DNS:Edit on the zone

tofu init
tofu plan
tofu apply
```

`zone_id` is on the zone's Overview tab in the Cloudflare dashboard (right
sidebar). The same scoped token drives Caddy's DNS-01 challenge
(`infra/caddy.env.example`), so reuse it.

## Notes

- State is local (`terraform.tfstate`) — fine for one operator. Move to a shared
  backend (the Restic backup bucket works) before a second person runs this.
- Leave `pages_cname_target` empty to let the Cloudflare Pages "add custom
  domain" flow own the apex/www records instead.
- `tofu` and `terraform` are interchangeable here; the config uses no
  BUSL-only features.

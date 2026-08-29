# DNS for the Sproutboat POC. Replaces the "create these records by hand" step
# in infra/README.md.
#
#   dashboard.<root>   A/AAAA -> VPS, DNS only  (Caddy presents the cert)
#   *.<root>           A/AAAA -> VPS, DNS only  (nested deploy hosts, DNS-01)
#   <root> / www       CNAME  -> Pages, proxied (marketing, optional)
#
# The wildcard and dashboard records MUST stay unproxied: Caddy issues exact
# certs for hosts like hello.andrea.sproutboat.com via a Cloudflare DNS-01
# challenge, which Cloudflare Universal SSL cannot cover.

locals {
  vps_hosts = {
    dashboard = "dashboard.${var.root_domain}"
    wildcard  = "*.${var.root_domain}"
  }
}

resource "cloudflare_dns_record" "vps_a" {
  for_each = local.vps_hosts

  zone_id = var.zone_id
  name    = each.value
  type    = "A"
  content = var.vps_ipv4
  ttl     = 1 # automatic
  proxied = false
  comment = "sproutboat POC — managed by infra/tofu"
}

resource "cloudflare_dns_record" "vps_aaaa" {
  for_each = var.vps_ipv6 == "" ? {} : local.vps_hosts

  zone_id = var.zone_id
  name    = each.value
  type    = "AAAA"
  content = var.vps_ipv6
  ttl     = 1
  proxied = false
  comment = "sproutboat POC — managed by infra/tofu"
}

resource "cloudflare_dns_record" "marketing" {
  for_each = var.pages_cname_target == "" ? toset([]) : toset([var.root_domain, "www.${var.root_domain}"])

  zone_id = var.zone_id
  name    = each.value
  type    = "CNAME"
  content = var.pages_cname_target
  ttl     = 1
  proxied = true
  comment = "sproutboat marketing (Cloudflare Pages) — managed by infra/tofu"
}

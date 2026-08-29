variable "zone_id" {
  description = "Cloudflare zone ID for sproutboat.com (Overview tab, right sidebar)."
  type        = string
}

variable "root_domain" {
  description = "Apex domain served by this zone."
  type        = string
  default     = "sproutboat.com"
}

variable "vps_ipv4" {
  description = "Public IPv4 of the single POC VPS that Caddy runs on."
  type        = string

  validation {
    condition     = can(regex("^(\\d{1,3}\\.){3}\\d{1,3}$", var.vps_ipv4))
    error_message = "vps_ipv4 must be a dotted-quad IPv4 address."
  }
}

variable "vps_ipv6" {
  description = "Public IPv6 of the VPS, or empty to skip AAAA records."
  type        = string
  default     = ""
}

variable "pages_cname_target" {
  description = <<-EOT
    Cloudflare Pages *.pages.dev target for the marketing site (e.g.
    sproutboat.pages.dev). Empty = don't manage the apex/www records here
    (leave them to the Pages "add custom domain" flow).
  EOT
  type    = string
  default = ""
}

output "dashboard_host" {
  description = "Authenticated dashboard / control API host."
  value       = local.vps_hosts.dashboard
}

output "deployment_wildcard" {
  description = "Wildcard host pattern for <project>.<username> deployments."
  value       = local.vps_hosts.wildcard
}

output "managed_records" {
  description = "Every DNS record name this configuration owns."
  value = concat(
    [for r in cloudflare_dns_record.vps_a : r.name],
    [for r in cloudflare_dns_record.vps_aaaa : r.name],
    [for r in cloudflare_dns_record.marketing : r.name],
  )
}

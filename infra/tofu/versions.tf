terraform {
  required_version = ">= 1.6"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }

  # ponytail: local state for the POC. Move to an S3-compatible backend
  # (same bucket as the Restic backups) before more than one admin runs this.
  # backend "s3" { ... }
}

provider "cloudflare" {
  # Reads CLOUDFLARE_API_TOKEN from the environment.
  # Scope the token to the sproutboat.com zone with Zone:Read + DNS:Edit only.
}

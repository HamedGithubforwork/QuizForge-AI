terraform {
  required_version = ">= 1.10.0, < 2.0.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 6.64.0, < 7.0.0" }
  }
  backend "s3" {}
}

provider "aws" {
  region = "ca-central-1"
  default_tags {
    tags = { Project = "QuizForge-AI", Environment = "domain-prerequisites" }
  }
}

# The owner registered this domain at Porkbun. This stack does not register or
# transfer domains, change registrar nameservers, or publish application traffic.
locals {
  domain   = "quizfromnotes.com"
  hostname = "staging-api.${local.domain}"
}

resource "aws_route53_zone" "domain" {
  name          = local.domain
  comment       = "QuizForge domain prerequisites; independent of disposable staging"
  force_destroy = false
  lifecycle { prevent_destroy = true }
}

resource "aws_acm_certificate" "staging_api" {
  domain_name       = local.hostname
  validation_method = "DNS"
  key_algorithm     = "RSA_2048"
  options {
    certificate_transparency_logging_preference = "ENABLED"
    export                                      = "DISABLED"
  }
  lifecycle { prevent_destroy = true }
}

resource "aws_route53_record" "validation" {
  zone_id         = aws_route53_zone.domain.zone_id
  name            = one(aws_acm_certificate.staging_api.domain_validation_options).resource_record_name
  type            = one(aws_acm_certificate.staging_api.domain_validation_options).resource_record_type
  records         = [one(aws_acm_certificate.staging_api.domain_validation_options).resource_record_value]
  ttl             = 300
  allow_overwrite = false
  lifecycle { prevent_destroy = true }
}

# Do not wait for issuance during preparation: the registrar delegation must
# happen first. The separate read-only verify operation requires real issuance.
output "zone_id" { value = aws_route53_zone.domain.zone_id }
output "name_servers" { value = sort(aws_route53_zone.domain.name_servers) }
output "staging_hostname" { value = local.hostname }
output "certificate_arn" { value = aws_acm_certificate.staging_api.arn }

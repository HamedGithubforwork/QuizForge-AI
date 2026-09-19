mock_provider "aws" {
  mock_resource "aws_acm_certificate" {
    defaults = {
      domain_validation_options = [{
        domain_name           = "staging-api.quizfromnotes.com"
        resource_record_name  = "_validation.staging-api.quizfromnotes.com"
        resource_record_type  = "CNAME"
        resource_record_value = "_token.acm-validations.aws."
      }]
    }
  }
}
run "only_registered_domain_and_nonexportable_staging_certificate" {
  command = plan
  assert {
    condition     = aws_route53_zone.domain.name == "quizfromnotes.com" && !aws_route53_zone.domain.force_destroy && length(aws_route53_zone.domain.vpc) == 0
    error_message = "Create only the registered public DNS zone and never force-delete its records."
  }
  assert {
    condition     = aws_acm_certificate.staging_api.domain_name == "staging-api.quizfromnotes.com" && aws_acm_certificate.staging_api.validation_method == "DNS" && aws_acm_certificate.staging_api.options[0].export == "DISABLED"
    error_message = "Request only the staging certificate with DNS validation and no paid export option."
  }
  assert {
    condition     = !aws_route53_record.validation.allow_overwrite && aws_route53_record.validation.ttl == 300
    error_message = "Certificate validation must never overwrite existing DNS records."
  }
}

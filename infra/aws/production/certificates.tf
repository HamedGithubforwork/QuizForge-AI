resource "aws_acm_certificate" "api" {
  domain_name       = local.hostname
  validation_method = "DNS"
  options {
    certificate_transparency_logging_preference = "ENABLED"
    export                                      = "DISABLED"
  }
  lifecycle { prevent_destroy = true }
}
resource "aws_acm_certificate" "site" {
  provider                  = aws.edge
  domain_name               = "quizfromnotes.com"
  subject_alternative_names = ["www.quizfromnotes.com"]
  validation_method         = "DNS"
  options {
    certificate_transparency_logging_preference = "ENABLED"
    export                                      = "DISABLED"
  }
  lifecycle { prevent_destroy = true }
}
resource "aws_route53_record" "api_validation" {
  zone_id         = var.zone_id
  name            = one(aws_acm_certificate.api.domain_validation_options).resource_record_name
  type            = one(aws_acm_certificate.api.domain_validation_options).resource_record_type
  records         = [one(aws_acm_certificate.api.domain_validation_options).resource_record_value]
  ttl             = 300
  allow_overwrite = false
  lifecycle { prevent_destroy = true }
}
resource "aws_route53_record" "site_validation" {
  for_each        = toset(["quizfromnotes.com", "www.quizfromnotes.com"])
  zone_id         = var.zone_id
  name            = one([for d in aws_acm_certificate.site.domain_validation_options : d.resource_record_name if d.domain_name == each.key])
  type            = one([for d in aws_acm_certificate.site.domain_validation_options : d.resource_record_type if d.domain_name == each.key])
  records         = [one([for d in aws_acm_certificate.site.domain_validation_options : d.resource_record_value if d.domain_name == each.key])]
  ttl             = 300
  allow_overwrite = false
  lifecycle { prevent_destroy = true }
}
resource "aws_acm_certificate_validation" "api" {
  certificate_arn         = aws_acm_certificate.api.arn
  validation_record_fqdns = [aws_route53_record.api_validation.fqdn]
}
resource "aws_acm_certificate_validation" "site" {
  provider                = aws.edge
  certificate_arn         = aws_acm_certificate.site.arn
  validation_record_fqdns = [for r in aws_route53_record.site_validation : r.fqdn]
}

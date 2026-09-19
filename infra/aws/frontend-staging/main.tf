terraform {
  required_version = ">= 1.10.0, < 2.0.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 5.0, < 7.0" }
  }
  backend "s3" {}
}
provider "aws" {
  region = "ca-central-1"
  default_tags {
    tags = { Project = "QuizForge-AI", Environment = "frontend-staging", Temporary = "true" }
  }
}
data "aws_caller_identity" "current" {}
variable "deadline" {
  type    = string
  default = "1970-01-01T00:00:00Z"
}
locals {
  name = "quizforge-frontend-staging"
}
resource "aws_s3_bucket" "site" {
  bucket        = "${local.name}-${data.aws_caller_identity.current.account_id}"
  force_destroy = true # Dedicated disposable artifacts only; never the state bucket.
}
resource "aws_s3_bucket_public_access_block" "site" {
  bucket                  = aws_s3_bucket.site.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_ownership_controls" "site" {
  bucket = aws_s3_bucket.site.id
  rule { object_ownership = "BucketOwnerEnforced" }
}
resource "aws_s3_bucket_server_side_encryption_configuration" "site" {
  bucket = aws_s3_bucket.site.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}
resource "aws_cloudfront_origin_access_control" "site" {
  name                              = local.name
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}
resource "aws_cloudfront_function" "routes" {
  name    = local.name
  runtime = "cloudfront-js-2.0"
  comment = "Exact SPA routes and expiry for disposable hosting validation"
  publish = true
  code    = replace(file("${path.module}/routes.js"), "__DEADLINE__", var.deadline)
}
resource "aws_cloudfront_cache_policy" "html" {
  name        = "${local.name}-html"
  min_ttl     = 0
  default_ttl = 0
  max_ttl     = 0
  parameters_in_cache_key_and_forwarded_to_origin {
    cookies_config { cookie_behavior = "none" }
    headers_config { header_behavior = "none" }
    query_strings_config { query_string_behavior = "none" }
  }
}
resource "aws_cloudfront_cache_policy" "assets" {
  name        = "${local.name}-assets"
  min_ttl     = 0
  default_ttl = 86400
  max_ttl     = 31536000
  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_brotli = true
    enable_accept_encoding_gzip   = true
    cookies_config { cookie_behavior = "none" }
    headers_config { header_behavior = "none" }
    query_strings_config { query_string_behavior = "none" }
  }
}
resource "aws_cloudfront_response_headers_policy" "site" {
  name = local.name
  security_headers_config {
    content_security_policy {
      content_security_policy = trimspace(file("${path.module}/csp.txt"))
      override                = true
    }
    content_type_options { override = true }
    frame_options {
      frame_option = "DENY"
      override     = true
    }
    referrer_policy {
      referrer_policy = "no-referrer"
      override        = true
    }
    strict_transport_security {
      access_control_max_age_sec = 31536000
      override                   = true
    }
  }
  custom_headers_config {
    items {
      header   = "X-Robots-Tag"
      value    = "noindex, nofollow, noarchive"
      override = true
    }
    items {
      header   = "Permissions-Policy"
      value    = "camera=(), microphone=(), geolocation=()"
      override = true
    }
  }
}
resource "aws_cloudfront_distribution" "site" {
  enabled             = true
  is_ipv6_enabled     = true
  comment             = local.name
  default_root_object = "index.html"
  price_class         = "PriceClass_100"
  wait_for_deployment = true
  retain_on_delete    = false
  http_version        = "http2and3"
  origin {
    domain_name              = aws_s3_bucket.site.bucket_regional_domain_name
    origin_id                = "private-s3"
    origin_access_control_id = aws_cloudfront_origin_access_control.site.id
  }
  default_cache_behavior {
    target_origin_id           = "private-s3"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    viewer_protocol_policy     = "redirect-to-https"
    compress                   = true
    cache_policy_id            = aws_cloudfront_cache_policy.html.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.site.id
    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.routes.arn
    }
  }
  ordered_cache_behavior {
    path_pattern               = "/assets/*"
    target_origin_id           = "private-s3"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    viewer_protocol_policy     = "redirect-to-https"
    compress                   = true
    cache_policy_id            = aws_cloudfront_cache_policy.assets.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.site.id
    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.routes.arn
    }
  }
  restrictions {
    geo_restriction { restriction_type = "none" }
  }
  viewer_certificate { cloudfront_default_certificate = true }
}
resource "aws_s3_bucket_policy" "site" {
  bucket = aws_s3_bucket.site.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "OnlyThisCloudFrontDistribution"
        Effect    = "Allow"
        Principal = { Service = "cloudfront.amazonaws.com" }
        Action    = "s3:GetObject"
        Resource  = "${aws_s3_bucket.site.arn}/*"
        Condition = { StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.site.arn } }
      },
      {
        Sid       = "DenyUnencryptedTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = [aws_s3_bucket.site.arn, "${aws_s3_bucket.site.arn}/*"]
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      }
    ]
  })
  depends_on = [aws_s3_bucket_public_access_block.site]
}
output "hosting" {
  value = {
    bucket       = aws_s3_bucket.site.id
    origin       = aws_s3_bucket.site.bucket_regional_domain_name
    distribution = aws_cloudfront_distribution.site.id
    domain       = aws_cloudfront_distribution.site.domain_name
    deadline     = var.deadline
  }
}

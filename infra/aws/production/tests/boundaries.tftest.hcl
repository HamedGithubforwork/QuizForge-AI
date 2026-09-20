mock_provider "aws" {
  mock_resource "aws_security_group" {
    override_during = plan
    defaults        = { id = "sg-1234567890abcdef0" }
  }
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/mock-integration" }
  }
  mock_resource "aws_lb" {
    defaults = {
      arn      = "arn:aws:elasticloadbalancing:ca-central-1:123456789012:loadbalancer/app/quizforge-production/0000000000000000"
      dns_name = "quizforge-production-123.ca-central-1.elb.amazonaws.com"
      zone_id  = "Z1234"
    }
  }
  mock_resource "aws_lb_target_group" {
    defaults = { arn = "arn:aws:elasticloadbalancing:ca-central-1:123456789012:targetgroup/qf-production-api/0000000000000000" }
  }
  mock_resource "aws_lb_listener" {
    defaults = { arn = "arn:aws:elasticloadbalancing:ca-central-1:123456789012:listener/app/quizforge-production/0000000000000000/0000000000000000" }
  }
  mock_resource "aws_ecs_task_definition" {
    defaults = { arn = "arn:aws:ecs:ca-central-1:123456789012:task-definition/quizforge-production-api:1" }
  }
}
override_data {
  target = data.terraform_remote_state.foundation
  values = {
    outputs = {
      vpc_id                  = "vpc-1234567890abcdef0"
      public_subnet_ids       = ["subnet-11111111111111111", "subnet-22222222222222222"]
      private_subnet_ids      = ["subnet-33333333333333333", "subnet-44444444444444444"]
      ecs_bootstrap_image_uri = "123456789012.dkr.ecr.ca-central-1.amazonaws.com/quizforge-api:test"
      ecs_cluster_name        = "quizforge-api"
    }
  }
}

mock_provider "aws" { alias = "edge" }
override_resource {
  target = aws_acm_certificate.api
  values = {
    arn                       = "arn:aws:acm:ca-central-1:123456789012:certificate/00000000-0000-0000-0000-000000000000"
    domain_validation_options = [{ domain_name = "api.quizfromnotes.com", resource_record_name = "_api.api.quizfromnotes.com", resource_record_type = "CNAME", resource_record_value = "_api.acm-validations.aws" }]
  }
}
override_resource {
  target = aws_acm_certificate.site
  values = {
    arn = "arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000001"
    domain_validation_options = [
      { domain_name = "quizfromnotes.com", resource_record_name = "_site.quizfromnotes.com", resource_record_type = "CNAME", resource_record_value = "_site.acm-validations.aws" },
      { domain_name = "www.quizfromnotes.com", resource_record_name = "_www.www.quizfromnotes.com", resource_record_type = "CNAME", resource_record_value = "_www.acm-validations.aws" }
    ]
  }
}
override_resource {
  target          = aws_sns_topic.alerts
  override_during = plan
  values          = { arn = "arn:aws:sns:ca-central-1:123456789012:quizforge-production-alerts" }
}
variables {
  foundation_state_bucket = "test-state-bucket"
  zone_id                 = "Z1234"
  monthly_budget_usd      = 100
  alert_email             = "operator@example.invalid"
}
run "retained_private_data_and_closed_launch" {
  command = plan
  assert {
    condition     = aws_db_instance.db.deletion_protection && !aws_db_instance.db.skip_final_snapshot && !aws_db_instance.db.delete_automated_backups && aws_db_instance.db.backup_retention_period == 7 && !aws_db_instance.db.publicly_accessible && aws_db_instance.db.storage_encrypted
    error_message = "Production history must be private, encrypted, backed up and protected from deletion."
  }
  assert {
    condition     = !aws_s3_bucket.site.force_destroy && aws_cloudfront_distribution.site.retain_on_delete && aws_s3_bucket_versioning.site.versioning_configuration[0].status == "Enabled"
    error_message = "Permanent frontend must preserve data and release versions."
  }
  assert {
    condition     = aws_ecs_service.app["api"].desired_count == 0 && aws_ecs_service.app["identity"].desired_count == 0 && length(aws_route53_record.api) == 0 && length(aws_route53_record.site) == 0 && length(aws_route53_record.site_ipv6) == 0
    error_message = "First provisioning must not start unseeded applications or publish traffic."
  }
  assert {
    condition     = aws_cognito_user_pool.browser.deletion_protection == "ACTIVE" && aws_cognito_user_pool.browser.mfa_configuration == "ON" && aws_cognito_user_pool.browser.admin_create_user_config[0].allow_admin_create_user_only && aws_cognito_user_pool.browser.auto_verified_attributes == toset(["email"])
    error_message = "Production identities require retention, verified email, MFA and a separate signup gate."
  }
  assert {
    condition     = aws_secretsmanager_secret.application.recovery_window_in_days == 30 && aws_secretsmanager_secret.identity.recovery_window_in_days == 30 && aws_secretsmanager_secret.generation.recovery_window_in_days == 30
    error_message = "Runtime credentials must not use disposable deletion settings."
  }
  assert {
    condition     = aws_lb.api.enable_deletion_protection && aws_lb_listener.https.default_action[0].type == "fixed-response" && aws_wafv2_web_acl.api.rule != null
    error_message = "The API needs retained load balancer, host isolation and its rate rule."
  }
  assert {
    condition     = !aws_budgets_budget.monthly.cost_types[0].include_credit && length(aws_budgets_budget.monthly.notification) == 4
    error_message = "Budget alerts must observe pre-credit account spend at actual and forecast thresholds."
  }
  assert {
    condition     = aws_elasticache_replication_group.cache.transit_encryption_enabled && aws_elasticache_replication_group.cache.at_rest_encryption_enabled && aws_vpc_security_group_ingress_rule.cache_app.cidr_ipv4 == null
    error_message = "Cache must remain private and encrypted."
  }
}
run "unreviewed_start_rejected" {
  command = plan
  variables { enable_api = true }
  expect_failures = [aws_ecs_service.app]
}
run "mutable_application_image_rejected" {
  command = plan
  variables { api_image = "123456789012.dkr.ecr.ca-central-1.amazonaws.com/quizforge-api:latest" }
  expect_failures = [var.api_image]
}
run "missing_cost_threshold_rejected" {
  command = plan
  variables { monthly_budget_usd = 0 }
  expect_failures = [var.monthly_budget_usd]
}

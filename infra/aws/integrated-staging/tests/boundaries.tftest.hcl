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
  mock_resource "aws_cognito_user_pool" {
    override_during = plan
    defaults        = { arn = "arn:aws:cognito-idp:ca-central-1:123456789012:userpool/ca-central-1_Staging" }
  }
  mock_resource "aws_lambda_function" {
    override_during = plan
    defaults        = { arn = "arn:aws:lambda:ca-central-1:123456789012:function:quizforge-integrated-staging-recovery" }
  }
  mock_resource "aws_cloudwatch_log_group" {
    override_during = plan
    defaults        = { arn = "arn:aws:logs:ca-central-1:123456789012:log-group:/aws/lambda/quizforge-integrated-staging-recovery" }
  }
  mock_resource "aws_lb" {
    defaults = {
      arn      = "arn:aws:elasticloadbalancing:ca-central-1:123456789012:loadbalancer/app/quizforge-integrated-staging/0000000000000000"
      dns_name = "quizforge-integrated-staging-123.ca-central-1.elb.amazonaws.com"
      zone_id  = "Z1234"
    }
  }
  mock_resource "aws_lb_target_group" {
    defaults = { arn = "arn:aws:elasticloadbalancing:ca-central-1:123456789012:targetgroup/qf-integrated-api/0000000000000000" }
  }
  mock_resource "aws_lb_listener" {
    defaults = { arn = "arn:aws:elasticloadbalancing:ca-central-1:123456789012:listener/app/quizforge-integrated-staging/0000000000000000/0000000000000000" }
  }
  mock_resource "aws_ecs_task_definition" {
    defaults = { arn = "arn:aws:ecs:ca-central-1:123456789012:task-definition/quizforge-integrated-staging-api:1" }
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
variables {
  foundation_state_bucket = "test-state-bucket"
  hostname                = "staging-api.quizfromnotes.com"
  certificate_arn         = "arn:aws:acm:ca-central-1:123456789012:certificate/00000000-0000-0000-0000-000000000000"
  zone_id                 = "Z1234"
}
run "private_data_and_stopped_tasks" {
  command = plan
  # Test the locked-down default even when workflow_dispatch explicitly
  # enables sign-up and exports TF_VAR_enable_test_signup=true. Run-level
  # variables must override inherited workflow variables.
  variables {
    enable_test_signup = false
  }
  assert {
    condition     = !aws_db_instance.db.publicly_accessible && aws_db_instance.db.storage_encrypted && aws_db_instance.db.backup_retention_period == 1 && aws_db_instance.db.delete_automated_backups
    error_message = "Disposable data must remain private, encrypted and removable with its backups."
  }
  assert {
    condition     = aws_ecs_service.app["api"].desired_count == 0 && aws_ecs_service.app["identity"].desired_count == 0
    error_message = "Application tasks must remain stopped until restricted database roles are seeded."
  }
  assert {
    condition     = aws_cognito_user_pool.browser.mfa_configuration == "OPTIONAL" && aws_cognito_user_pool.browser.admin_create_user_config[0].allow_admin_create_user_only && toset(aws_cognito_user_pool.browser.auto_verified_attributes) == toset(["email"]) && aws_cognito_user_pool_client.browser.enable_token_revocation && !aws_cognito_user_pool_client.browser.generate_secret
    error_message = "Default staging allows admin-created identities, optional TOTP and no public signup."
  }
  assert {
    condition     = aws_cognito_user_pool.browser.lambda_config[0].post_confirmation == aws_lambda_function.recovery.arn && aws_lambda_function.recovery.handler == "identity_triggers.handler" && aws_lambda_function.recovery.runtime == "python3.13" && aws_lambda_function.recovery.function_name == "quizforge-integrated-staging-recovery"
    error_message = "Staging password recovery must use production's handler in the isolated staging Lambda."
  }
  assert {
    condition     = aws_lambda_permission.recovery.source_arn == aws_cognito_user_pool.browser.arn && jsondecode(aws_iam_role_policy.recovery.policy).Statement[1].Resource == aws_cognito_user_pool.browser.arn && jsondecode(aws_iam_role_policy.recovery.policy).Statement[1].Action == ["cognito-idp:AdminUserGlobalSignOut"]
    error_message = "Recovery Lambda may revoke sessions only in the isolated staging user pool."
  }
  assert {
    condition     = aws_lb_listener.https.default_action[0].type == "fixed-response" && aws_lb_listener.https.ssl_policy == "ELBSecurityPolicy-TLS13-1-2-2021-06" && !aws_route53_record.api.allow_overwrite
    error_message = "TLS must reject unknown hosts/routes and preserve existing DNS records."
  }
  assert {
    condition     = aws_s3_bucket_public_access_block.site.block_public_policy && aws_cloudfront_origin_access_control.site.signing_behavior == "always" && aws_cloudfront_distribution.site.default_cache_behavior[0].viewer_protocol_policy == "redirect-to-https"
    error_message = "The frontend must use HTTPS and a private signed S3 origin."
  }
  assert {
    condition     = aws_elasticache_replication_group.cache.transit_encryption_enabled && aws_elasticache_replication_group.cache.transit_encryption_mode == "required" && aws_elasticache_replication_group.cache.at_rest_encryption_enabled && aws_elasticache_replication_group.cache.num_cache_clusters == 1 && aws_elasticache_replication_group.cache.snapshot_retention_limit == 0
    error_message = "The temporary cache must be one encrypted private node without retained snapshots."
  }
  assert {
    condition     = aws_vpc_security_group_ingress_rule.cache_app.cidr_ipv4 == null && aws_vpc_security_group_ingress_rule.cache_app.from_port == 6379 && aws_vpc_security_group_ingress_rule.cache_app.referenced_security_group_id == aws_security_group.app.id
    error_message = "Only the integration application security group may reach Valkey."
  }
  assert {
    condition     = jsondecode(aws_iam_role_policy.generation_secret.policy).Statement[0].Action == ["ssm:GetParameters"] && jsondecode(aws_iam_role_policy.generation_secret.policy).Statement[0].Resource == "arn:aws:ssm:ca-central-1:123456789012:parameter/quizforge/prod/OPENAI_API_KEY"
    error_message = "The execution role may inject only the already-authorized generation key."
  }
}
run "unreviewed_start_rejected" {
  command = plan
  variables { enable_api = true }
  expect_failures = [aws_ecs_service.app]
}
run "production_hostname_rejected" {
  command = plan
  variables { hostname = "api.quizfromnotes.com" }
  expect_failures = [var.hostname]
}
run "mutable_image_rejected" {
  command = plan
  variables { api_image = "123456789012.dkr.ecr.ca-central-1.amazonaws.com/quizforge-api:latest" }
  expect_failures = [var.api_image]
}


run "google_federation_disabled_by_default" {
  command = plan
  assert {
    condition     = length(aws_cognito_identity_provider.google) == 0 && toset(aws_cognito_user_pool_client.browser.supported_identity_providers) == toset(["COGNITO"])
    error_message = "The staging module must not create a Google provider unless explicitly enabled."
  }
}

run "google_federation_requires_dedicated_credentials" {
  command = plan
  variables {
    enable_google_signin = true
  }
  expect_failures = [aws_cognito_identity_provider.google[0]]
}

run "google_federation_keeps_cognito_password_provider" {
  command = plan
  variables {
    enable_google_signin       = true
    google_oauth_client_id     = "123456789000-staging.apps.googleusercontent.com"
    google_oauth_client_secret = "synthetic-staging-google-secret"
  }
  assert {
    condition     = toset(aws_cognito_user_pool_client.browser.supported_identity_providers) == toset(["COGNITO", "Google"]) && aws_cognito_identity_provider.google[0].provider_type == "Google" && contains(aws_cognito_user_pool_client.browser.explicit_auth_flows, "ALLOW_USER_PASSWORD_AUTH")
    error_message = "Google federation must remain alongside the existing Cognito sign-in provider."
  }
}

run "manual_signup_is_opt_in_with_email_verification_and_totp" {
  command = plan
  variables {
    enable_test_signup = true
  }
  assert {
    condition     = !aws_cognito_user_pool.browser.admin_create_user_config[0].allow_admin_create_user_only && toset(aws_cognito_user_pool.browser.auto_verified_attributes) == toset(["email"]) && aws_cognito_user_pool.browser.mfa_configuration == "OPTIONAL" && aws_cognito_user_pool.browser.software_token_mfa_configuration[0].enabled && aws_cognito_user_pool.browser.email_configuration[0].email_sending_account == "COGNITO_DEFAULT"
    error_message = "Opt-in manual signup must verify email with Cognito and offer optional authenticator MFA."
  }
  assert {
    condition     = aws_cognito_user_pool.browser.password_policy[0].minimum_length == 8 && aws_cognito_user_pool.browser.password_policy[0].require_lowercase && aws_cognito_user_pool.browser.password_policy[0].require_uppercase && aws_cognito_user_pool.browser.password_policy[0].require_numbers && aws_cognito_user_pool.browser.password_policy[0].require_symbols
    error_message = "Staging Cognito must match production: minimum 8 characters and all four complexity requirements."
  }
  assert {
    condition     = aws_cognito_user_pool.browser.deletion_protection == "INACTIVE" && toset([for mechanism in aws_cognito_user_pool.browser.account_recovery_setting[0].recovery_mechanism : mechanism.name]) == toset(["verified_email"])
    error_message = "Staging must provide verified-email recovery and remain disposable."
  }
}

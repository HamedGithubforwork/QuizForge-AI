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
  assert {
    condition     = !aws_db_instance.db.publicly_accessible && aws_db_instance.db.storage_encrypted && aws_db_instance.db.backup_retention_period == 1 && aws_db_instance.db.delete_automated_backups
    error_message = "Disposable data must remain private, encrypted and removable with its backups."
  }
  assert {
    condition     = aws_ecs_service.app["api"].desired_count == 0 && aws_ecs_service.app["identity"].desired_count == 0
    error_message = "Application tasks must remain stopped until restricted database roles are seeded."
  }
  assert {
    condition     = aws_cognito_user_pool.browser.mfa_configuration == "ON" && aws_cognito_user_pool.browser.admin_create_user_config[0].allow_admin_create_user_only && aws_cognito_user_pool_client.browser.enable_token_revocation && !aws_cognito_user_pool_client.browser.generate_secret
    error_message = "Only admin-created synthetic identities with mandatory MFA may use the public PKCE client."
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

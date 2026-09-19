mock_provider "aws" {
  mock_data "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/quizforge-ecs-task-execution" }
  }
  mock_resource "aws_lb" {
    defaults = {
      arn      = "arn:aws:elasticloadbalancing:ca-central-1:123456789012:loadbalancer/app/quizforge-staging-api/0000000000000000"
      dns_name = "quizforge-staging-api-123.ca-central-1.elb.amazonaws.com"
      zone_id  = "Z1234"
    }
  }
  mock_resource "aws_lb_target_group" {
    defaults = { arn = "arn:aws:elasticloadbalancing:ca-central-1:123456789012:targetgroup/quizforge-staging-api/0000000000000000" }
  }
  mock_resource "aws_lb_listener" {
    defaults = { arn = "arn:aws:elasticloadbalancing:ca-central-1:123456789012:listener/app/quizforge-staging-api/0000000000000000/0000000000000000" }
  }
  mock_resource "aws_ecs_task_definition" {
    defaults = { arn = "arn:aws:ecs:ca-central-1:123456789012:task-definition/quizforge-api-staging:1" }
  }
}
override_data {
  target = data.terraform_remote_state.foundation
  values = {
    outputs = {
      vpc_id                  = "vpc-1234567890abcdef0"
      public_subnet_ids       = ["subnet-11111111111111111", "subnet-22222222222222222"]
      private_subnet_ids      = ["subnet-33333333333333333", "subnet-44444444444444444"]
      alb_security_group_id   = "sg-11111111111111111"
      app_security_group_id   = "sg-22222222222222222"
      ecs_bootstrap_image_uri = "123456789012.dkr.ecr.ca-central-1.amazonaws.com/quizforge-api:test"
      api_log_group_name      = "/quizforge/api"
      ecs_cluster_name        = "quizforge"
    }
  }
}
variables {
  foundation_state_bucket = "test-state-bucket"
}
run "legacy_staging_remains_opt_in" {
  command = plan
  assert {
    condition     = length(aws_lb_listener.api_https) == 0 && length(aws_route53_record.staging_api) == 0
    error_message = "No TLS or DNS resources may be created without explicit configuration."
  }
  assert {
    condition     = aws_lb_listener.api_http.default_action[0].type == "forward"
    error_message = "Existing HTTP rehearsal behavior must remain available until HTTPS is configured."
  }
}
run "https_redirect_and_host_isolation" {
  command = plan
  variables {
    staging_hostname        = "staging-api.example.com"
    staging_certificate_arn = "arn:aws:acm:ca-central-1:123456789012:certificate/00000000-0000-0000-0000-000000000000"
    staging_zone_id         = "Z1234"
  }
  assert {
    condition     = aws_lb_listener.api_http.default_action[0].type == "redirect" && aws_lb_listener.api_http.default_action[0].redirect[0].host == var.staging_hostname && aws_lb_listener.api_http.default_action[0].redirect[0].protocol == "HTTPS"
    error_message = "HTTP must redirect to the fixed staging HTTPS hostname."
  }
  assert {
    condition     = aws_lb_listener.api_https[0].port == 443 && aws_lb_listener.api_https[0].ssl_policy == "ELBSecurityPolicy-TLS13-1-2-2021-06" && aws_lb_listener.api_https[0].default_action[0].type == "fixed-response"
    error_message = "HTTPS must reject unknown hosts and require TLS 1.2 or newer."
  }
  assert {
    condition     = aws_route53_record.staging_api[0].allow_overwrite == false && output.api_url == "https://staging-api.example.com"
    error_message = "Never replace an existing DNS record; publish only the HTTPS endpoint."
  }
}
run "partial_tls_fails_closed" {
  command = plan
  variables {
    staging_certificate_arn = "arn:aws:acm:ca-central-1:123456789012:certificate/00000000-0000-0000-0000-000000000000"
  }
  expect_failures = [aws_lb_listener.api_http]
}
run "production_hostname_rejected" {
  command = plan
  variables {
    staging_hostname        = "api.example.com"
    staging_certificate_arn = "arn:aws:acm:ca-central-1:123456789012:certificate/00000000-0000-0000-0000-000000000000"
    staging_zone_id         = "Z1234"
  }
  expect_failures = [var.staging_hostname]
}
run "wrong_certificate_region_rejected" {
  command = plan
  variables {
    staging_hostname        = "staging-api.example.com"
    staging_certificate_arn = "arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000000"
    staging_zone_id         = "Z1234"
  }
  expect_failures = [var.staging_certificate_arn]
}

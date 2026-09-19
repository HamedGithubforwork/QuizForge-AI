# Disposable, synthetic integration only. Never opens another rehearsal's state.
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
    tags = { Project = "QuizForge-AI", Environment = "integrated-staging", Temporary = "true" }
  }
}
variable "foundation_state_bucket" { type = string }
variable "hostname" {
  type = string
  validation {
    condition     = var.hostname == "staging-api.quizfromnotes.com"
    error_message = "Only the existing dedicated staging API hostname is allowed."
  }
}
variable "certificate_arn" { type = string }
variable "zone_id" { type = string }
variable "deadline" {
  type    = string
  default = "1970-01-01T00:00:00Z"
}
variable "api_image" {
  type    = string
  default = ""
  validation {
    condition     = var.api_image == "" || can(regex("^[0-9]{12}\\.dkr\\.ecr\\.ca-central-1\\.amazonaws\\.com/quizforge-api@sha256:[a-f0-9]{64}$", var.api_image))
    error_message = "The API must use an immutable reviewed ECR image digest."
  }
}
variable "probe_image" {
  type    = string
  default = ""
  validation {
    condition     = var.probe_image == "" || can(regex("^[0-9]{12}\\.dkr\\.ecr\\.ca-central-1\\.amazonaws\\.com/quizforge-api@sha256:[a-f0-9]{64}$", var.probe_image))
    error_message = "The probe must use an immutable trusted ECR image digest."
  }
}
variable "enable_api" {
  type    = bool
  default = false
}
data "aws_caller_identity" "current" {}
data "terraform_remote_state" "foundation" {
  backend = "s3"
  config = {
    bucket = var.foundation_state_bucket
    key    = "quizforge/foundation/terraform.tfstate"
    region = "ca-central-1"
  }
}
locals {
  name        = "quizforge-integrated-staging"
  foundation  = data.terraform_remote_state.foundation.outputs
  origin      = "https://${aws_cloudfront_distribution.site.domain_name}"
  domain      = "quizforge-integrated-${data.aws_caller_identity.current.account_id}"
  auth_origin = "https://${local.domain}.auth.ca-central-1.amazoncognito.com"
  csp         = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://${var.hostname} ${local.auth_origin} https://cognito-idp.ca-central-1.amazonaws.com; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'; upgrade-insecure-requests"
  ecr_arn     = "arn:aws:ecr:ca-central-1:${data.aws_caller_identity.current.account_id}:repository/quizforge-api"
  assume_ecs  = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" }, Action = "sts:AssumeRole" }] })
  logs        = { logDriver = "awslogs", options = { awslogs-group = aws_cloudwatch_log_group.app.name, awslogs-region = "ca-central-1", awslogs-stream-prefix = "integration" } }
  common_environment = [
    { name = "AUTH_PROVIDER", value = "cognito" },
    { name = "COGNITO_USER_POOL_ID", value = aws_cognito_user_pool.browser.id },
    { name = "COGNITO_CLIENT_ID", value = aws_cognito_user_pool_client.browser.id },
    { name = "AWS_EC2_METADATA_DISABLED", value = "true" }
  ]
}
resource "aws_cloudwatch_log_group" "app" {
  name              = "/quizforge/integrated-staging"
  retention_in_days = 1
}
resource "aws_security_group" "alb" {
  name   = "${local.name}-alb"
  vpc_id = local.foundation.vpc_id
}
resource "aws_security_group" "app" {
  name   = "${local.name}-app"
  vpc_id = local.foundation.vpc_id
}
resource "aws_security_group" "database" {
  name   = "${local.name}-db"
  vpc_id = local.foundation.vpc_id
}
resource "aws_vpc_security_group_ingress_rule" "public" {
  for_each          = toset(["80", "443"])
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = tonumber(each.value)
  to_port           = tonumber(each.value)
}
resource "aws_vpc_security_group_egress_rule" "alb_app" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.app.id
  ip_protocol                  = "tcp"
  from_port                    = 8000
  to_port                      = 8001
}
resource "aws_vpc_security_group_ingress_rule" "app_alb" {
  security_group_id            = aws_security_group.app.id
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = 8000
  to_port                      = 8001
}
resource "aws_vpc_security_group_egress_rule" "app_https" {
  security_group_id = aws_security_group.app.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}
resource "aws_vpc_security_group_egress_rule" "app_database" {
  security_group_id            = aws_security_group.app.id
  referenced_security_group_id = aws_security_group.database.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}
resource "aws_vpc_security_group_ingress_rule" "database_app" {
  security_group_id            = aws_security_group.database.id
  referenced_security_group_id = aws_security_group.app.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}
resource "aws_db_subnet_group" "db" {
  name       = local.name
  subnet_ids = local.foundation.private_subnet_ids
}
resource "aws_db_parameter_group" "tls" {
  name   = local.name
  family = "postgres17"
  parameter {
    name         = "rds.force_ssl"
    value        = "1"
    apply_method = "pending-reboot"
  }
}
resource "aws_db_instance" "db" {
  identifier                   = local.name
  engine                       = "postgres"
  engine_version               = "17"
  engine_lifecycle_support     = "open-source-rds-extended-support-disabled"
  instance_class               = "db.t4g.micro"
  allocated_storage            = 20
  storage_type                 = "gp3"
  storage_encrypted            = true
  db_name                      = "quizforge_rehearsal"
  username                     = "quizforge_owner"
  manage_master_user_password  = true
  db_subnet_group_name         = aws_db_subnet_group.db.name
  vpc_security_group_ids       = [aws_security_group.database.id]
  parameter_group_name         = aws_db_parameter_group.tls.name
  publicly_accessible          = false
  multi_az                     = false
  backup_retention_period      = 1
  auto_minor_version_upgrade   = true
  performance_insights_enabled = false
  monitoring_interval          = 0
  apply_immediately            = true
  deletion_protection          = false
  skip_final_snapshot          = true
  delete_automated_backups     = true
}
# No public signup, delivery or recovery in this synthetic integration test.
resource "aws_cognito_user_pool" "browser" {
  name                = local.name
  user_pool_tier      = "LITE"
  deletion_protection = "INACTIVE"
  username_attributes = ["email"]
  mfa_configuration   = "ON"
  username_configuration { case_sensitive = false }
  admin_create_user_config { allow_admin_create_user_only = true }
  software_token_mfa_configuration { enabled = true }
  password_policy {
    minimum_length                   = 14
    require_lowercase                = true
    require_uppercase                = true
    require_numbers                  = true
    require_symbols                  = true
    temporary_password_validity_days = 1
  }
  account_recovery_setting {
    recovery_mechanism {
      name     = "admin_only"
      priority = 1
    }
  }
}
resource "aws_cognito_user_pool_client" "browser" {
  name                                 = "quizforge-integrated-pkce"
  user_pool_id                         = aws_cognito_user_pool.browser.id
  generate_secret                      = false
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "aws.cognito.signin.user.admin"]
  supported_identity_providers         = ["COGNITO"]
  callback_urls                        = ["${local.origin}/auth/callback"]
  logout_urls                          = ["${local.origin}/"]
  explicit_auth_flows                  = ["ALLOW_REFRESH_TOKEN_AUTH"]
  prevent_user_existence_errors        = "ENABLED"
  enable_token_revocation              = true
  read_attributes                      = ["email", "email_verified", "sub"]
  write_attributes                     = ["email"]
  access_token_validity                = 5
  id_token_validity                    = 5
  refresh_token_validity               = 1
  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "hours"
  }
}
resource "aws_cognito_user_pool_client" "fixture" {
  name                          = "quizforge-integrated-iam-fixture"
  user_pool_id                  = aws_cognito_user_pool.browser.id
  generate_secret               = false
  explicit_auth_flows           = ["ALLOW_ADMIN_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]
  prevent_user_existence_errors = "ENABLED"
  enable_token_revocation       = true
  access_token_validity         = 5
  id_token_validity             = 5
  token_validity_units {
    access_token = "minutes"
    id_token     = "minutes"
  }
}
resource "aws_cognito_user_pool_domain" "browser" {
  domain                = local.domain
  user_pool_id          = aws_cognito_user_pool.browser.id
  managed_login_version = 1
}
resource "aws_secretsmanager_secret" "application" {
  name                    = "${local.name}-application"
  recovery_window_in_days = 0
}
resource "aws_secretsmanager_secret" "identity" {
  name                    = "${local.name}-identity"
  recovery_window_in_days = 0
}
resource "aws_secretsmanager_secret" "fixture" {
  name                    = "${local.name}-fixture"
  recovery_window_in_days = 0
}
resource "aws_iam_role" "execution" {
  for_each           = toset(["api", "identity", "probe"])
  name               = "${local.name}-${each.key}-exec"
  assume_role_policy = local.assume_ecs
}
resource "aws_iam_role_policy" "execution" {
  for_each = aws_iam_role.execution
  role     = each.value.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["ecr:GetAuthorizationToken"], Resource = "*" },
    { Effect = "Allow", Action = ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"], Resource = local.ecr_arn },
    { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.app.arn}:*" },
    { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = each.key == "api" ? aws_secretsmanager_secret.application.arn : each.key == "identity" ? aws_secretsmanager_secret.identity.arn : aws_db_instance.db.master_user_secret[0].secret_arn }
  ] })
}
resource "aws_iam_role" "setup" {
  name               = "${local.name}-setup"
  assume_role_policy = local.assume_ecs
}
resource "aws_iam_role_policy" "setup" {
  role = aws_iam_role.setup.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = aws_secretsmanager_secret.fixture.arn },
    { Effect = "Allow", Action = ["secretsmanager:PutSecretValue"], Resource = [aws_secretsmanager_secret.application.arn, aws_secretsmanager_secret.identity.arn] }
  ] })
}
resource "aws_ecs_task_definition" "probe" {
  family                   = "${local.name}-probe"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.execution["probe"].arn
  task_role_arn            = aws_iam_role.setup.arn
  container_definitions = jsonencode([{
    name                   = "probe", essential = true, image = var.probe_image != "" ? var.probe_image : local.foundation.ecs_bootstrap_image_uri,
    readonlyRootFilesystem = true, user = "10001:10001", linuxParameters = { capabilities = { drop = ["ALL"] } },
    environment = [
      { name = "PGHOST", value = aws_db_instance.db.address },
      { name = "PGDATABASE", value = "quizforge_rehearsal" },
      { name = "PGSSLROOTCERT", value = "/app/rds-ca.pem" },
      { name = "FIXTURE_SECRET", value = aws_secretsmanager_secret.fixture.arn },
      { name = "APPLICATION_SECRET", value = aws_secretsmanager_secret.application.arn },
      { name = "IDENTITY_SECRET", value = aws_secretsmanager_secret.identity.arn },
      { name = "AWS_DEFAULT_REGION", value = "ca-central-1" }
    ],
    secrets = [
      { name = "PGUSER", valueFrom = "${aws_db_instance.db.master_user_secret[0].secret_arn}:username::" },
      { name = "PGPASSWORD", valueFrom = "${aws_db_instance.db.master_user_secret[0].secret_arn}:password::" }
    ],
    logConfiguration = local.logs
  }])
  depends_on = [aws_iam_role_policy.execution, aws_iam_role_policy.setup]
}
# Separate tasks ensure API and identity broker cannot read each other's secrets.
resource "aws_ecs_task_definition" "app" {
  for_each                 = toset(["api", "identity"])
  family                   = "${local.name}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.execution[each.key].arn
  # No task role and no production credentials in either application process.
  container_definitions = jsonencode([{
    name                   = each.key, essential = true, image = var.api_image != "" ? var.api_image : local.foundation.ecs_bootstrap_image_uri,
    readonlyRootFilesystem = true, user = "10001:10001", linuxParameters = { capabilities = { drop = ["ALL"] } },
    portMappings           = [{ containerPort = each.key == "api" ? 8000 : 8001, protocol = "tcp" }],
    command                = concat(["uvicorn", each.key == "api" ? "main:app" : "identity_app:create_identity_app"], each.key == "api" ? [] : ["--factory"], ["--host", "0.0.0.0", "--port", each.key == "api" ? "8000" : "8001", "--no-access-log"]),
    environment = concat(local.common_environment, [
      { name = each.key == "api" ? "HISTORY_DB_HOST" : "IDENTITY_DB_HOST", value = aws_db_instance.db.address },
      { name = each.key == "api" ? "HISTORY_DB_NAME" : "IDENTITY_DB_NAME", value = "quizforge_rehearsal" },
      { name = each.key == "api" ? "HISTORY_DB_USER" : "IDENTITY_DB_USER", value = each.key == "api" ? "quizforge_app" : "quizforge_identity" },
      { name = each.key == "api" ? "HISTORY_DB_POOL_SIZE" : "IDENTITY_DB_POOL_SIZE", value = "1" }
      ], each.key == "api" ? [
      { name = "HISTORY_BACKEND", value = "postgres" }, { name = "ALLOWED_ORIGINS", value = local.origin }
    ] : [{ name = "IDENTITY_STAGING_ENABLED", value = "true" }, { name = "IDENTITY_ALLOWED_ORIGIN", value = local.origin }]),
    secrets          = [{ name = each.key == "api" ? "HISTORY_DB_PASSWORD" : "IDENTITY_DB_PASSWORD", valueFrom = "${each.key == "api" ? aws_secretsmanager_secret.application.arn : aws_secretsmanager_secret.identity.arn}:password::" }],
    logConfiguration = local.logs
  }])
  depends_on = [aws_iam_role_policy.execution]
}
resource "aws_lb" "api" {
  name                       = local.name
  internal                   = false
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.alb.id]
  subnets                    = local.foundation.public_subnet_ids
  enable_deletion_protection = false
}
resource "aws_lb_target_group" "app" {
  for_each             = toset(["api", "identity"])
  name                 = each.key == "api" ? "qf-integrated-api" : "qf-integrated-identity"
  port                 = each.key == "api" ? 8000 : 8001
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = local.foundation.vpc_id
  deregistration_delay = 10
  health_check {
    path              = each.key == "api" ? "/api/health" : "/identity/session"
    matcher           = each.key == "api" ? "200" : "403"
    interval          = 15
    healthy_threshold = 2
  }
}
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.api.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type = "redirect"
    redirect {
      protocol    = "HTTPS"
      port        = "443"
      host        = var.hostname
      path        = "/#{path}"
      query       = "#{query}"
      status_code = "HTTP_301"
    }
  }
}
resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.api.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn
  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      message_body = "Unknown staging host or route"
      status_code  = "404"
    }
  }
}
resource "aws_lb_listener_rule" "app" {
  for_each     = toset(["api", "identity"])
  listener_arn = aws_lb_listener.https.arn
  priority     = each.key == "api" ? 20 : 10
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app[each.key].arn
  }
  condition {
    host_header { values = [var.hostname] }
  }
  condition {
    path_pattern { values = [each.key == "api" ? "/api/*" : "/identity/*"] }
  }
}
resource "aws_route53_record" "api" {
  zone_id         = var.zone_id
  name            = var.hostname
  type            = "A"
  allow_overwrite = false
  alias {
    name                   = aws_lb.api.dns_name
    zone_id                = aws_lb.api.zone_id
    evaluate_target_health = true
  }
}
resource "aws_ecs_service" "app" {
  for_each                           = toset(["api", "identity"])
  name                               = "${local.name}-${each.key}"
  cluster                            = local.foundation.ecs_cluster_name
  task_definition                    = aws_ecs_task_definition.app[each.key].arn
  desired_count                      = var.enable_api ? 1 : 0
  launch_type                        = "FARGATE"
  wait_for_steady_state              = true
  health_check_grace_period_seconds  = 60
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    subnets          = local.foundation.public_subnet_ids
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = true
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.app[each.key].arn
    container_name   = each.key
    container_port   = each.key == "api" ? 8000 : 8001
  }
  lifecycle {
    precondition {
      condition     = !var.enable_api || (var.api_image != "" && var.probe_image != "")
      error_message = "Starting the API requires both reviewed immutable image digests."
    }
  }
  depends_on = [aws_lb_listener_rule.app]
}
output "integration" {
  value = {
    name           = local.name, deadline = var.deadline,
    bucket         = aws_s3_bucket.site.id, origin = aws_s3_bucket.site.bucket_regional_domain_name,
    distribution   = aws_cloudfront_distribution.site.id, domain = aws_cloudfront_distribution.site.domain_name,
    pool           = aws_cognito_user_pool.browser.id, client = aws_cognito_user_pool_client.browser.id,
    fixture_client = aws_cognito_user_pool_client.fixture.id, auth_domain = local.domain,
    api_url        = "https://${var.hostname}", alb_url = "http://${aws_lb.api.dns_name}", csp = local.csp,
    cluster        = local.foundation.ecs_cluster_name, subnets = local.foundation.public_subnet_ids,
    security_group = aws_security_group.app.id, db_security_group = aws_security_group.database.id,
    probe_task     = aws_ecs_task_definition.probe.arn, log_group = aws_cloudwatch_log_group.app.name,
    fixture_secret = aws_secretsmanager_secret.fixture.arn,
    api_image      = var.api_image, probe_image = var.probe_image, db_host = aws_db_instance.db.address
  }
}

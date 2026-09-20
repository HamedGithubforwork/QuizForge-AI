resource "aws_secretsmanager_secret" "application" {
  name                    = "${local.name}-application"
  recovery_window_in_days = 30
  lifecycle { prevent_destroy = true }
}
resource "aws_secretsmanager_secret" "identity" {
  name                    = "${local.name}-identity"
  recovery_window_in_days = 30
  lifecycle { prevent_destroy = true }
}
resource "aws_iam_role" "execution" {
  for_each           = toset(["api", "identity", "operations"])
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
    { Effect = "Allow", Action = ["secretsmanager:PutSecretValue"], Resource = [aws_secretsmanager_secret.application.arn, aws_secretsmanager_secret.identity.arn, aws_secretsmanager_secret.generation.arn] }
  ] })
}
resource "aws_ecs_task_definition" "operations" {
  family                   = "${local.name}-operations"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.execution["operations"].arn
  task_role_arn            = aws_iam_role.setup.arn
  container_definitions = jsonencode([{
    name                   = "operations", essential = true, image = var.operations_image != "" ? var.operations_image : local.foundation.ecs_bootstrap_image_uri,
    readonlyRootFilesystem = true, user = "10001:10001", linuxParameters = { capabilities = { drop = ["ALL"] } },
    environment = [
      { name = "PGHOST", value = aws_db_instance.db.address },
      { name = "REDIS_URL", value = local.redis_url },
      { name = "PGDATABASE", value = "quizforge" },
      { name = "PGSSLROOTCERT", value = "/app/rds-ca.pem" },
      { name = "APPLICATION_SECRET", value = aws_secretsmanager_secret.application.arn },
      { name = "IDENTITY_SECRET", value = aws_secretsmanager_secret.identity.arn },
      { name = "GENERATION_SECRET", value = aws_secretsmanager_secret.generation.arn },
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
  # No AWS task role; generation budget authority is a separate restricted SQL role.
  container_definitions = jsonencode(concat([{
    name                   = each.key, essential = true, image = var.api_image != "" ? var.api_image : local.foundation.ecs_bootstrap_image_uri,
    readonlyRootFilesystem = true, user = "10001:10001", linuxParameters = { capabilities = { drop = ["ALL"] } },
    portMappings           = [{ containerPort = each.key == "api" ? 8000 : 8001, protocol = "tcp" }],
    command                = concat(["uvicorn", each.key == "api" ? "main:app" : "identity_app:create_identity_app"], each.key == "api" ? [] : ["--factory"], ["--host", "0.0.0.0", "--port", each.key == "api" ? "8000" : "8001", "--no-access-log"]),
    environment = concat(local.common_environment, [
      { name = each.key == "api" ? "HISTORY_DB_HOST" : "IDENTITY_DB_HOST", value = aws_db_instance.db.address },
      { name = each.key == "api" ? "HISTORY_DB_NAME" : "IDENTITY_DB_NAME", value = "quizforge" },
      { name = each.key == "api" ? "HISTORY_DB_USER" : "IDENTITY_DB_USER", value = each.key == "api" ? "quizforge_app" : "quizforge_identity" },
      { name = each.key == "api" ? "HISTORY_DB_POOL_SIZE" : "IDENTITY_DB_POOL_SIZE", value = "1" }
      ], each.key == "api" ? [
      { name = "HISTORY_BACKEND", value = "postgres" }, { name = "ALLOWED_ORIGINS", value = local.origin },
      { name = "REDIS_URL", value = local.redis_url },
      { name = "OPENAI_API_KEY", value = "production-budget-guard" },
      { name = "OPENAI_BASE_URL", value = "http://127.0.0.1:8002/v1" }
      ] : [{ name = "IDENTITY_ENVIRONMENT", value = "production" }, { name = "IDENTITY_ALLOWED_ORIGIN", value = local.origin },
      { name = "IDENTITY_SUPABASE_URL", value = local.legacy_url },
    { name = "IDENTITY_SUPABASE_PUBLISHABLE_KEY", value = var.legacy_publishable_key }]),
    secrets          = [{ name = each.key == "api" ? "HISTORY_DB_PASSWORD" : "IDENTITY_DB_PASSWORD", valueFrom = "${each.key == "api" ? aws_secretsmanager_secret.application.arn : aws_secretsmanager_secret.identity.arn}:password::" }],
    logConfiguration = local.logs
    }], each.key == "api" ? [{
    name                   = "generation-guard", essential = true,
    image                  = var.operations_image != "" ? var.operations_image : local.foundation.ecs_bootstrap_image_uri,
    readonlyRootFilesystem = true, user = "10001:10001", linuxParameters = { capabilities = { drop = ["ALL"] } },
    command                = ["python", "generation_guard.py"],
    environment = [
      { name = "REDIS_URL", value = local.redis_url },
      { name = "PGHOST", value = aws_db_instance.db.address },
      { name = "PGDATABASE", value = "quizforge" },
      { name = "PGUSER", value = "quizforge_generation" },
      { name = "PGSSLROOTCERT", value = "/app/rds-ca.pem" },
      { name = "AWS_EC2_METADATA_DISABLED", value = "true" }
    ],
    secrets          = [{ name = "OPENAI_API_KEY", valueFrom = local.openai_parameter_arn }, { name = "PGPASSWORD", valueFrom = "${aws_secretsmanager_secret.generation.arn}:password::" }],
    logConfiguration = local.logs
  }] : []))
  depends_on = [aws_iam_role_policy.execution, aws_iam_role_policy.generation_secret]
}
resource "aws_lb" "api" {
  name                       = local.name
  internal                   = false
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.alb.id]
  subnets                    = local.foundation.public_subnet_ids
  enable_deletion_protection = true
  drop_invalid_header_fields = true
  desync_mitigation_mode     = "strictest"
  lifecycle { prevent_destroy = true }
}
resource "aws_lb_target_group" "app" {
  for_each             = toset(["api", "identity"])
  name                 = each.key == "api" ? "qf-production-api" : "qf-production-identity"
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
      host        = local.hostname
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
  certificate_arn   = aws_acm_certificate_validation.api.certificate_arn
  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      message_body = "Unknown host or route"
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
    host_header { values = [local.hostname] }
  }
  condition {
    path_pattern { values = [each.key == "api" ? "/api/*" : "/identity/*"] }
  }
}
resource "aws_route53_record" "api" {
  count           = var.publish_dns ? 1 : 0
  zone_id         = var.zone_id
  name            = local.hostname
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
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
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
      condition     = !var.enable_api || (var.api_image != "" && var.operations_image != "" && var.legacy_publishable_key != "")
      error_message = "Starting the API requires both reviewed immutable image digests and the legacy publishable key."
    }
  }
  depends_on = [aws_lb_listener_rule.app]
}

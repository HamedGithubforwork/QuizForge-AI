variable "aws_region" {
  type    = string
  default = "ca-central-1"
  validation {
    condition     = var.aws_region == "ca-central-1"
    error_message = "This disposable rehearsal is restricted to ca-central-1."
  }
}
variable "foundation_state_bucket" { type = string }
variable "rehearsal_image" {
  type    = string
  default = ""
}
variable "restore_validation" {
  type    = bool
  default = false
}
variable "api_validation" {
  type    = bool
  default = false
}
variable "api_backend_image" {
  type    = string
  default = ""
  validation {
    condition     = var.api_backend_image == "" || can(regex("^[0-9]{12}\\.dkr\\.ecr\\.ca-central-1\\.amazonaws\\.com/quizforge-api@sha256:[0-9a-f]{64}$", var.api_backend_image))
    error_message = "API validation requires a tested Canada Central ECR image digest."
  }
}
provider "aws" {
  region = var.aws_region
  default_tags {
    tags = { Project = "QuizForge AI", Environment = "rds-rehearsal", Ephemeral = "true", ManagedBy = "Terraform" }
  }
}
data "aws_caller_identity" "current" {}
data "terraform_remote_state" "foundation" {
  backend = "s3"
  config = {
    bucket = var.foundation_state_bucket
    key    = "quizforge/foundation/terraform.tfstate"
    region = var.aws_region
  }
}
locals {
  foundation = data.terraform_remote_state.foundation.outputs
  name       = "quizforge-rds-rehearsal"
}
resource "aws_db_subnet_group" "rehearsal" {
  name       = local.name
  subnet_ids = local.foundation.private_subnet_ids
}
resource "aws_security_group" "database" {
  name        = local.name
  description = "Disposable private PostgreSQL rehearsal"
  vpc_id      = local.foundation.vpc_id
}
resource "aws_vpc_security_group_ingress_rule" "from_app" {
  security_group_id            = aws_security_group.database.id
  referenced_security_group_id = local.foundation.app_security_group_id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
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
# Disposable Free-plan rehearsal: keep automated backups enabled for one day.
resource "aws_db_instance" "source" {
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
  db_subnet_group_name         = aws_db_subnet_group.rehearsal.name
  vpc_security_group_ids       = [aws_security_group.database.id]
  parameter_group_name         = aws_db_parameter_group.tls.name
  publicly_accessible          = false
  multi_az                     = false
  backup_retention_period      = 1
  copy_tags_to_snapshot        = true
  auto_minor_version_upgrade   = true
  performance_insights_enabled = false
  monitoring_interval          = 0
  apply_immediately            = true
  deletion_protection          = false
  skip_final_snapshot          = true
  delete_automated_backups     = true
}
# Created only after the source import and security checks pass.
resource "aws_db_snapshot" "verified_seed" {
  count                  = var.restore_validation ? 1 : 0
  db_instance_identifier = aws_db_instance.source.identifier
  db_snapshot_identifier = "${local.name}-verified-seed"
}
resource "aws_db_instance" "restored" {
  count                        = var.restore_validation ? 1 : 0
  identifier                   = "${local.name}-restore"
  snapshot_identifier          = aws_db_snapshot.verified_seed[0].id
  instance_class               = "db.t4g.micro"
  engine_lifecycle_support     = "open-source-rds-extended-support-disabled"
  db_subnet_group_name         = aws_db_subnet_group.rehearsal.name
  vpc_security_group_ids       = [aws_security_group.database.id]
  parameter_group_name         = aws_db_parameter_group.tls.name
  publicly_accessible          = false
  multi_az                     = false
  backup_retention_period      = 1
  storage_encrypted            = true
  storage_type                 = "gp3"
  auto_minor_version_upgrade   = true
  performance_insights_enabled = false
  monitoring_interval          = 0
  apply_immediately            = true
  deletion_protection          = false
  skip_final_snapshot          = true
  delete_automated_backups     = true
}
resource "aws_iam_role" "probe_execution" {
  name = "${local.name}-execution"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" }, Action = "sts:AssumeRole"
  }] })
}
resource "aws_iam_role_policy" "probe_execution" {
  role = aws_iam_role.probe_execution.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["ecr:GetAuthorizationToken"], Resource = "*" },
    { Effect = "Allow", Action = ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"],
    Resource = "arn:aws:ecr:${var.aws_region}:${data.aws_caller_identity.current.account_id}:repository/quizforge-api" },
    { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"],
    Resource = "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:${local.foundation.api_log_group_name}:*" },
    { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"],
    Resource = aws_db_instance.source.master_user_secret[0].secret_arn }
  ] })
}
resource "aws_ecs_task_definition" "probe" {
  family                   = local.name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.probe_execution.arn
  task_role_arn            = var.api_validation ? aws_iam_role.api_setup[0].arn : null
  container_definitions = jsonencode([{
    name                   = "probe", essential = true
    image                  = var.rehearsal_image != "" ? var.rehearsal_image : local.foundation.ecs_bootstrap_image_uri
    readonlyRootFilesystem = true
    user                   = "10001:10001"
    linuxParameters        = { capabilities = { drop = ["ALL"] } }
    environment = concat([
      { name = "PGHOST", value = aws_db_instance.source.address },
      { name = "PGDATABASE", value = "quizforge_rehearsal" },
      { name = "PGSSLROOTCERT", value = "/app/rds-ca.pem" }
      ], var.api_validation ? [
      { name = "RDS_APP_SECRET_ARN", value = aws_secretsmanager_secret.api_application[0].arn },
      { name = "RDS_SESSION_SECRET_ARN", value = aws_secretsmanager_secret.api_session[0].arn },
      { name = "AWS_DEFAULT_REGION", value = var.aws_region }
    ] : [])
    secrets = [
      { name = "PGUSER", valueFrom = "${aws_db_instance.source.master_user_secret[0].secret_arn}:username::" },
      { name = "PGPASSWORD", valueFrom = "${aws_db_instance.source.master_user_secret[0].secret_arn}:password::" }
    ]
    logConfiguration = { logDriver = "awslogs", options = {
      awslogs-group         = local.foundation.api_log_group_name, awslogs-region = var.aws_region,
      awslogs-stream-prefix = "rds-rehearsal"
    } }
  }])
  depends_on = [aws_iam_role_policy.probe_execution, aws_iam_role_policy.api_setup]
}
output "probe" {
  value = {
    cluster         = local.foundation.ecs_cluster_name
    task_definition = aws_ecs_task_definition.probe.arn
    subnets         = local.foundation.public_subnet_ids
    security_group  = local.foundation.app_security_group_id
    log_group       = local.foundation.api_log_group_name
    source_host     = aws_db_instance.source.address
    restored_host   = try(aws_db_instance.restored[0].address, "")
    database_group  = aws_security_group.database.id
    private_subnets = local.foundation.private_subnet_ids
    api_task        = try(aws_ecs_task_definition.api[0].arn, "")
    session_secret  = try(aws_secretsmanager_secret.api_session[0].arn, "")
    cognito_pool    = try(aws_cognito_user_pool.rehearsal[0].id, "")
    cognito_client  = try(aws_cognito_user_pool_client.rehearsal[0].id, "")
  }
}

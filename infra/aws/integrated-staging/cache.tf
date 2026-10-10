# One disposable private node; no retained cache snapshots.
resource "aws_security_group" "cache" {
  name   = "${local.name}-cache"
  vpc_id = local.foundation.vpc_id
}
resource "aws_vpc_security_group_ingress_rule" "cache_app" {
  security_group_id            = aws_security_group.cache.id
  referenced_security_group_id = aws_security_group.app.id
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
}
resource "aws_vpc_security_group_egress_rule" "app_cache" {
  security_group_id            = aws_security_group.app.id
  referenced_security_group_id = aws_security_group.cache.id
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
}
resource "aws_elasticache_subnet_group" "cache" {
  name       = local.name
  subnet_ids = local.foundation.private_subnet_ids
}
resource "aws_elasticache_replication_group" "cache" {
  replication_group_id       = local.name
  description                = "Disposable integrated quiz validation"
  engine                     = "valkey"
  node_type                  = "cache.t4g.micro"
  num_cache_clusters         = 1
  cluster_mode               = "disabled"
  port                       = 6379
  subnet_group_name          = aws_elasticache_subnet_group.cache.name
  security_group_ids         = [aws_security_group.cache.id]
  transit_encryption_enabled = true
  transit_encryption_mode    = "required"
  at_rest_encryption_enabled = true
  automatic_failover_enabled = false
  multi_az_enabled           = false
  snapshot_retention_limit   = 0
  apply_immediately          = true
}
locals {
  redis_url            = "rediss://${aws_elasticache_replication_group.cache.primary_endpoint_address}:6379/0"
  openai_parameter_arn = "arn:aws:ssm:ca-central-1:${data.aws_caller_identity.current.account_id}:parameter/quizforge/prod/OPENAI_API_KEY"
}
resource "aws_iam_role_policy" "generation_secret" {
  role = aws_iam_role.execution["api"].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["ssm:GetParameters"], Resource = local.openai_parameter_arn }
  ] })
}

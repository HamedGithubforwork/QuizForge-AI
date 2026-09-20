# One private encrypted cache node. Durable history and usage budgets live in RDS.
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
  description                = "QuizForge production cache"
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
  apply_immediately          = false
}

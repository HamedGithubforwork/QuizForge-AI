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
  db_name                      = "quizforge"
  username                     = "quizforge_owner"
  manage_master_user_password  = true
  db_subnet_group_name         = aws_db_subnet_group.db.name
  vpc_security_group_ids       = [aws_security_group.database.id]
  parameter_group_name         = aws_db_parameter_group.tls.name
  publicly_accessible          = false
  multi_az                     = false
  backup_retention_period      = 7
  auto_minor_version_upgrade   = true
  performance_insights_enabled = false
  monitoring_interval          = 0
  apply_immediately            = false
  deletion_protection          = true
  skip_final_snapshot          = false
  delete_automated_backups     = false
  final_snapshot_identifier    = "quizforge-production-final"
  copy_tags_to_snapshot        = true
  backup_window                = "06:00-07:00"
  maintenance_window           = "sun:08:00-sun:09:00"
  lifecycle { prevent_destroy = true }
}

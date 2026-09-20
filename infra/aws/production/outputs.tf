output "production" {
  value = {
    name            = local.name
    frontend_url    = local.origin
    api_url         = "https://${local.hostname}"
    pool            = aws_cognito_user_pool.browser.id
    client          = aws_cognito_user_pool_client.browser.id
    auth_origin     = local.auth_origin
    bucket          = aws_s3_bucket.site.id
    distribution    = aws_cloudfront_distribution.site.id
    db_host         = aws_db_instance.db.address
    cluster         = local.foundation.ecs_cluster_name
    subnets         = local.foundation.public_subnet_ids
    security_group  = aws_security_group.app.id
    operations_task = aws_ecs_task_definition.operations.arn
    log_group       = aws_cloudwatch_log_group.app.name
    legacy_url      = local.legacy_url
    dns_published   = var.publish_dns
    api_enabled     = var.enable_api
    signup_enabled  = var.public_signup
  }
}

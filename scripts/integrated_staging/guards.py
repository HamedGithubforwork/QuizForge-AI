"""No AWS calls; narrow allowlists for public artifacts and destructive operations."""
from datetime import datetime, timezone
import re

NAME = "quizforge-integrated-staging"
HOST = "staging-api.quizfromnotes.com"


def public_config(data):
    assert set(data) == {"pool", "client", "auth_origin", "frontend_url", "api_url", "deadline"}
    patterns = {
        "pool": r"ca-central-1_[A-Za-z0-9]+",
        "client": r"[a-z0-9]+",
        "auth_origin": r"https://quizforge-integrated-[0-9]{12}\.auth\.ca-central-1\.amazoncognito\.com",
        "frontend_url": r"https://[a-z0-9]+\.cloudfront\.net",
    }
    for key, pattern in patterns.items():
        assert isinstance(data[key], str) and re.fullmatch(pattern, data[key])
    assert data["api_url"] == "https://" + HOST
    deadline = datetime.fromisoformat(data["deadline"].replace("Z", "+00:00"))
    assert deadline.tzinfo is not None
    assert 0 < (deadline - datetime.now(timezone.utc)).total_seconds() <= 7300
    return data


def permitted_state(addresses):
    # This root never adopts imported modules or production resources.
    allowed = {
        "data.aws_caller_identity.current", "data.terraform_remote_state.foundation",
        "aws_s3_bucket.site", "aws_s3_bucket_public_access_block.site", "aws_s3_bucket_ownership_controls.site",
        "aws_s3_bucket_server_side_encryption_configuration.site", "aws_s3_bucket_policy.site",
        "aws_cloudfront_origin_access_control.site", "aws_cloudfront_function.routes",
        "aws_cloudfront_cache_policy.html", "aws_cloudfront_cache_policy.assets",
        "aws_cloudfront_response_headers_policy.site", "aws_cloudfront_distribution.site",
        "aws_cloudwatch_log_group.app", "aws_db_subnet_group.db", "aws_db_parameter_group.tls", "aws_db_instance.db",
        "aws_cognito_user_pool.browser", "aws_cognito_user_pool_client.browser",
        "aws_cognito_user_pool_client.fixture", "aws_cognito_user_pool_domain.browser",
        "aws_iam_role.setup", "aws_iam_role_policy.setup", "aws_ecs_task_definition.probe",
        "aws_elasticache_subnet_group.cache", "aws_elasticache_replication_group.cache", "aws_iam_role_policy.generation_secret",
        "aws_lb.api", "aws_lb_listener.http", "aws_lb_listener.https", "aws_route53_record.api",
    }
    for name in ("alb", "app", "database", "cache"):
        allowed.add("aws_security_group." + name)
    for name in ("alb_app", "app_https", "app_database", "app_cache"):
        allowed.add("aws_vpc_security_group_egress_rule." + name)
    for name in ("app_alb", "database_app", "cache_app"):
        allowed.add("aws_vpc_security_group_ingress_rule." + name)
    for port in ("80", "443"):
        allowed.add(f'aws_vpc_security_group_ingress_rule.public["{port}"]')
    for name in ("application", "identity", "fixture"):
        allowed.add("aws_secretsmanager_secret." + name)
    for name in ("api", "identity", "probe"):
        allowed.update(f'{kind}.execution["{name}"]' for kind in ("aws_iam_role", "aws_iam_role_policy"))
    for name in ("api", "identity"):
        allowed.update(f'{kind}.app["{name}"]' for kind in (
            "aws_ecs_task_definition", "aws_ecs_service", "aws_lb_target_group", "aws_lb_listener_rule"))
    assert set(addresses) <= allowed, "Unrelated resource in integrated staging state"


def owned_task(task):
    family = task["taskDefinitionArn"].split("/")[-1].split(":")[0]
    return family in {NAME + suffix for suffix in ("-api", "-identity", "-probe")}

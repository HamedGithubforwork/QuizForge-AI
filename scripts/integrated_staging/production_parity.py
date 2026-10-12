"""Credential-free source parity check: production baseline plus declared overrides.

This compares app-affecting Cognito policy and recovery code in the checked-in
production/staging definitions; it does NOT claim to inventory the live stack.
Live build ancestry is checked separately by aws_staging_preview.py.
"""
from pathlib import Path
import json
import re

ROOT = Path(__file__).resolve().parents[2]
PROD = ROOT / "infra/aws/lightsail-production/auth.tf"
STAGE = ROOT / "infra/aws/integrated-staging/main.tf"
PROD_OPS = ROOT / "infra/aws/lightsail-production/operations.tf"
RECOVERY = ROOT / "scripts/production/lightsail/identity_triggers.py"

# These are product behaviour, not provider-specific deployment details.
POOL_FIELDS = (
    "username_attributes", "auto_verified_attributes", "mfa_configuration",
    "user_pool_tier", "software_token_mfa_configuration",
    "user_attribute_update_settings", "verification_message_template",
    "password_policy", "account_recovery_setting", "email_configuration",
)
CLIENT_FIELDS = (
    "generate_secret", "allowed_oauth_flows_user_pool_client",
    "allowed_oauth_flows", "allowed_oauth_scopes",
    "supported_identity_providers", "explicit_auth_flows",
    "prevent_user_existence_errors", "enable_token_revocation",
    "read_attributes", "write_attributes", "access_token_validity",
    "id_token_validity", "refresh_token_validity", "token_validity_units",
)
DIFFERENCES = {
    "staging_hosting": "ECS/RDS/CloudFront for isolated browser integration; production uses Lightsail",
    "resource_isolation": "Disposable staging pool, test users, RDS, storage and cache; no production identities",
    "account_lifecycle": "Staging pool deletion allowed, signup opt-in and short log retention; production protected/public signup",
    "google_rollout": "Google permitted on staging for reviewed linking tests; off in production until acceptance",
    "urls_and_clients": "Independent Cognito client, redirects, API and website domains",
    "manual_shutdown": "Only an explicit Stop tears down successful staging; no duplicate environment",
}


def block(source, resource_type, name):
    anchor = f'resource "{resource_type}" "{name}" {{'
    if source.count(anchor) != 1:
        raise ValueError("Expected exactly one named Terraform resource: " + anchor)
    start = source.index(anchor) + len(anchor)
    depth = 1
    quoted = False
    escaped = False
    for i in range(start, len(source)):
        c = source[i]
        if quoted:
            if escaped:
                escaped = False
            elif c == "\\":
                escaped = True
            elif c == '"':
                quoted = False
        elif c == '"':
            quoted = True
        elif c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return source[start:i]
    raise ValueError("Unbalanced Terraform block")


def field(source, key):
    # Handle inline nested HCL and provider blocks without whitespace
    # sensitivity. Keep exact semantics for brackets/literals/code definitions.
    pattern = rf"\b{re.escape(key)}\s*=\s*([^\n}}]+)"
    matches = re.findall(pattern, source)
    if len(matches) != 1:
        raise ValueError("Missing or ambiguous required parity field: " + key)
    return re.sub(r"\s+", "", matches[0].split("#", 1)[0].strip().rstrip(","))


def compare_sources(prod, staging, prod_ops):
    findings = []
    for kind, fields in (("aws_cognito_user_pool", POOL_FIELDS),
                         ("aws_cognito_user_pool_client", CLIENT_FIELDS)):
        p = block(prod, kind, "browser")
        s = block(staging, kind, "browser")
        for key in fields:
            a, b = field(p, key), field(s, key)
            if a != b:
                findings.append({"setting": f"{kind}.{key}", "production": a, "staging": b})
    required = (
        'lambda_config { post_confirmation = aws_lambda_function.recovery.arn }',
        'resource "aws_lambda_function" "recovery"',
        'resource "aws_lambda_permission" "recovery"',
        'resource "aws_iam_role_policy" "recovery"',
        'aws_cognito_user_pool.browser.arn',
        'cognito-idp:AdminUserGlobalSignOut',
        'Resource = aws_cognito_user_pool.browser.arn',
    )
    for name, content in (("production", prod + prod_ops), ("staging", staging)):
        for item in required:
            if item not in content:
                findings.append({"setting": f"{name}.recovery.{item}", "production": "required", "staging": "missing"})
    role_policy = block(staging, "aws_iam_role_policy", "recovery")
    permission = block(staging, "aws_lambda_permission", "recovery")
    if role_policy.count('Resource = aws_cognito_user_pool.browser.arn') != 1:
        findings.append({"setting": "recovery.scoped_policy", "production": "pool-only", "staging": "unexpected"})
    if field(permission, "source_arn") != "aws_cognito_user_pool.browser.arn":
        findings.append({"setting": "recovery.scoped_invocation", "production": "pool-only", "staging": "unexpected"})
    for key in ("handler", "runtime", "memory_size", "timeout"):
        a = field(block(prod_ops, "aws_lambda_function", "recovery"), key)
        b = field(block(staging, "aws_lambda_function", "recovery"), key)
        if a != b:
            findings.append({"setting": f"recovery.{key}", "production": a, "staging": b})
    return findings


def report():
    issues = compare_sources(PROD.read_text(), STAGE.read_text(), PROD_OPS.read_text())
    return {
        "result": "PASS" if not issues else "FAIL",
        "scope": "repository-config-only; live state and deployed app versions require separate verification",
        "production_baseline": "application/production (checked in separate full-preview ancestry gate)",
        "critical_mismatches": issues,
        "intentional_differences": DIFFERENCES,
    }


if __name__ == "__main__":
    result = report()
    print(json.dumps(result, indent=2, sort_keys=True))
    if result["critical_mismatches"]:
        raise SystemExit(1)

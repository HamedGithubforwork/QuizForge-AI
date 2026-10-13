"""Fail-closed inspection of a production Google-only Terraform plan.

This checks local Terraform JSON only. Never logs planned values or credentials,
and never touches AWS. Exit code 2 from terraform plan is expected when the
exactly two authorized resources differ from the existing production state.
"""
from __future__ import annotations
import json
import os
from pathlib import Path
import sys

IDENTITY_PROVIDER = "aws_cognito_identity_provider.google[0]"
BROWSER_CLIENT = "aws_cognito_user_pool_client.browser"
USER_POOL = "aws_cognito_user_pool.browser"
ALLOWED = {
    IDENTITY_PROVIDER: ["create"],
    BROWSER_CLIENT: ["update"],
}


def authorize(document: dict, expected_google_client_id: str) -> dict:
    if document.get("format_version") not in ("1.0", "1.1", "1.2"):
        raise ValueError("Unexpected Terraform plan format")
    changes = document.get("resource_changes")
    if not isinstance(changes, list):
        raise ValueError("No Terraform resource change details")
    present = {}
    for resource in changes:
        if not isinstance(resource, dict) or not isinstance(resource.get("address"), str):
            raise ValueError("Malformed Terraform change")
        address = resource["address"]
        change = resource.get("change") or {}
        actions = change.get("actions")
        if actions == ["no-op"]:
            continue
        if address not in ALLOWED or actions != ALLOWED[address] or address in present:
            raise ValueError("Plan has a non-Google or destructive production change")
        before, after = change.get("before"), change.get("after")
        if not isinstance(after, dict):
            raise ValueError("Expected one directly scoped Cognito change")
        if address == IDENTITY_PROVIDER:
            if before is not None or after.get("provider_name") != "Google":
                raise ValueError("Google provider must be new and separate")
            if after.get("provider_type") != "Google":
                raise ValueError("Unexpected Google provider type")
            details = after.get("provider_details") or {}
            if (details.get("client_id") != expected_google_client_id
                    or details.get("authorize_scopes") != "openid email"
                    or not isinstance(details.get("client_secret"), str)
                    or len(details["client_secret"]) < 10):
                raise ValueError("Google OAuth settings mismatch")
            mapping = after.get("attribute_mapping") or {}
            if mapping.get("email") != "email" or mapping.get("email_verified") != "email_verified":
                raise ValueError("Google claim mapping mismatch")
        else:
            if not isinstance(before, dict):
                raise ValueError("Missing current browser app-client state")
            old = before.get("supported_identity_providers")
            new = after.get("supported_identity_providers")
            if set(old or []) != {"COGNITO"} or set(new or []) != {"COGNITO", "Google"}:
                raise ValueError("Must preserve existing password sign-in")
            for key in ("client_id", "name", "user_pool_id", "callback_urls", "logout_urls",
                        "allowed_oauth_flows", "allowed_oauth_scopes", "explicit_auth_flows",
                        "refresh_token_validity", "access_token_validity", "id_token_validity"):
                if before.get(key) != after.get(key):
                    raise ValueError("Unreviewed app-client configuration change")
        present[address] = actions[0]

    if present != {IDENTITY_PROVIDER: "create", BROWSER_CLIENT: "update"}:
        raise ValueError("Expected precisely one provider creation and one app-client update")
    if document.get("resource_drift"):
        raise ValueError("Unexpected Terraform drift during read-only review")
    return {"approved": True, "resources": [
        {"address": IDENTITY_PROVIDER, "action": "create"},
        {"address": BROWSER_CLIENT, "action": "update"},
    ], "production_changes_applied": False}


def classify_plan_failure(log_text: str, exit_code: int) -> str:
    """Whitelist stable error categories; never include raw Terraform diagnostics."""
    if exit_code == 0:
        return "NO_CHANGES"
    if exit_code != 1:
        return "UNEXPECTED_PLAN_EXIT"
    tests = [
        ("AccessDenied", "AWS_READ_PERMISSION_DENIED"),
        ("Access Denied", "AWS_READ_PERMISSION_DENIED"),
        ("UnauthorizedOperation", "AWS_READ_PERMISSION_DENIED"),
        ("not authorized", "AWS_READ_PERMISSION_DENIED"),
        ("Error: Missing required argument", "TERRAFORM_MISSING_ARGUMENT"),
        ("Error: Unsupported argument", "TERRAFORM_UNSUPPORTED_ARGUMENT"),
        ("Error: Invalid value for input variable", "TERRAFORM_INPUT_INVALID"),
        ("Error: Invalid value for variable", "TERRAFORM_INPUT_INVALID"),
        ("Error: Invalid function argument", "TERRAFORM_FUNCTION_INVALID"),
        ("Error: Invalid for_each argument", "TERRAFORM_CONFIGURATION_INVALID"),
        ("Error: Reference to undeclared resource", "TERRAFORM_CONFIGURATION_INVALID"),
        ("Error: Inconsistent dependency lock file", "TERRAFORM_DEPENDENCY_LOCK_INVALID"),
        ("Error: Failed to load state", "TERRAFORM_STATE_ERROR"),
        ("Error: Error loading state", "TERRAFORM_STATE_ERROR"),
        ("Error: Invalid provider configuration", "TERRAFORM_PROVIDER_CONFIGURATION_INVALID"),
        ("Error: Error in function call", "TERRAFORM_CONFIGURATION_INVALID"),
        ("Error: Invalid resource instance data", "TERRAFORM_STATE_ERROR"),
        ("Error: Incorrect attribute value type", "TERRAFORM_CONFIGURATION_INVALID"),
        ("Error: Invalid index", "TERRAFORM_CONFIGURATION_INVALID"),
        ("Error: Invalid resource instance key", "TERRAFORM_CONFIGURATION_INVALID"),
        ("Error: Cycle", "TERRAFORM_DEPENDENCY_CYCLE"),
        ("context deadline exceeded", "AWS_PROVIDER_TIMEOUT"),
        ("deadline exceeded", "AWS_PROVIDER_TIMEOUT"),
        ("request timed out", "AWS_PROVIDER_TIMEOUT"),
        ("Error: Plugin did not respond", "TERRAFORM_PROVIDER_PLUGIN_ERROR"),
        ("Error: Provider produced", "TERRAFORM_PROVIDER_PLAN_ERROR"),
        ("Error: Call to unknown function", "TERRAFORM_CONFIGURATION_INVALID"),
    ]
    for term, category in tests:
        if term.lower() in log_text.lower():
            return category
    return "OTHER_TERRAFORM_PLAN_FAILURE"



# Literal allowlist only: private text, identifiers and URL tokens in an error
# are *never* included in log messages or uploaded artifacts.
SAFE_ERROR_WORDS = frozenset("""
access accessdenied accessdeniedexception account already argument arguments
attribute attributes authentication authorization authorized backend block
bucket client code condition configuration connection credentials database
delete dependency describe detail drift duplicate error failed file for function
get google iam id identity import incorrect index insufficient invalid kms
length list lock locked missing module name not object operation optional
output parameter permission permissions plan policy provider produced read reference result
required resource resources role s3 schema secret state string terraform type
unauthorized unauthorizedoperation unexpected unknown unsupported user value
variable variables version with aws assume callback canceled cancelled cannot circular context deadline denied detail diagnostic disabled empty exceeded expired expiredtoken fetch field google identity invalid login mismatch network no out permission plan plugin produced provider read request response retry returned scope service session state sts timed timeout token unknown unavailable unexpected
""".split())


def safe_plan_error_hints(log_text: str) -> list[str]:
    """Inspect Terraform's one-line *titles*, publishing only allowlisted words."""
    import re
    hints = []
    for title in re.findall(r"(?m)^[^\r\n]*?Error:\s*([^\r\n]{1,240})", log_text)[:4]:
        words = [
            word.lower() for word in re.findall(r"[A-Za-z]+", title)
            if word.lower() in SAFE_ERROR_WORDS
        ]
        hint = "_".join(words[:9])
        if hint and hint not in hints:
            hints.append(hint)
    return hints or ["unrecognized_terraform_error"]



def safe_plan_log_metrics(log_text: str) -> dict:
    """Fixed-key numeric/boolean metrics only; not one byte of raw log content."""
    from collections import Counter
    import re
    words = Counter(w.lower() for w in re.findall(r"[A-Za-z]+", log_text)
                    if w.lower() in SAFE_ERROR_WORDS)
    lines = log_text.splitlines()
    # Emit only allowlisted words from lines containing 'error' and their next
    # line. Never emit raw text, arbitrary tokens, URLs, IDs or secret values.
    context = []
    for index, line in enumerate(lines):
        if re.search(r"\berror\b", line, re.IGNORECASE):
            excerpt = " ".join(lines[index:index+2])
            terms = [w.lower() for w in re.findall(r"[A-Za-z]+", excerpt)
                     if w.lower() in SAFE_ERROR_WORDS]
            context.append({"line": index + 1, "safe_terms": terms[:16]})
        if len(context) == 4:
            break
    return {
        "error_context": context,
        "bytes": len(log_text.encode("utf-8", errors="replace")),
        "lines": len(log_text.splitlines()),
        "terraform_error_prefix": bool(re.search(r"(?i)\berror\b", log_text)),
        "terraform_panic_prefix": bool(re.search(r"(?i)\bpanic\b", log_text)),
        "permitted_error_word_counts": {word: words[word] for word in sorted(words) if words[word] > 0},
    }



def safe_json_plan_diagnostics(log_text: str) -> list[dict]:
    """Summarize machine-readable Terraform errors without exposing diagnostic strings.

    Terraform's -json output can contain private values in both summary and
    detail. Only a fixed vocabulary and a fixed failure category leave this
    function. Never upload the original event stream.
    """
    import re
    results = []
    for line in log_text.splitlines():
        try:
            event = json.loads(line)
        except (TypeError, ValueError):
            continue
        if not isinstance(event, dict) or event.get("type") != "diagnostic":
            continue
        diagnostic = event.get("diagnostic")
        if not isinstance(diagnostic, dict) or diagnostic.get("severity") != "error":
            continue
        summary = diagnostic.get("summary")
        detail = diagnostic.get("detail", "")
        if not isinstance(summary, str):
            continue
        if not isinstance(detail, str):
            detail = ""
        safe_words = [
            term.lower() for term in re.findall(r"[A-Za-z]+", summary)
            if term.lower() in SAFE_ERROR_WORDS
        ][:12]
        detail_words = [
            term.lower() for term in re.findall(r"[A-Za-z]+", detail)
            if term.lower() in SAFE_ERROR_WORDS
        ][:32]
        source = diagnostic.get("range")
        known_files = {"auth.tf", "main.tf", "operations.tf"}
        filename = source.get("filename") if isinstance(source, dict) else None
        source_file = filename if filename in known_files else "UNSPECIFIED"
        results.append({
            "category": classify_plan_failure("Error: " + summary + "\n" + detail, 1),
            "summary_terms": safe_words,
            "detail_terms": detail_words,
            "summary_present": bool(summary.strip()),
            "source_file": source_file,
        })
        if len(results) >= 4:
            break
    return results


def classify_google_disabled_baseline(exit_code: int, diagnostic_text: str) -> str:
    """Fixed, secret-free diagnostic of the pre-existing production plan.

    This probe never authorizes a Google plan or a Terraform apply. A clean
    baseline means that the original Google-enabled plan failure needs
    investigation within the opt-in configuration. Nonzero changes with
    Google disabled are *not* authorized by this report.
    """
    if exit_code == 0:
        return "BASELINE_UNCHANGED"
    if exit_code == 2:
        return "BASELINE_HAS_UNREVIEWED_CHANGES"
    if exit_code == 1:
        return "BASELINE_FAILED_" + classify_plan_failure(diagnostic_text, exit_code)
    return "BASELINE_UNEXPECTED_EXIT"


def classify_targeted_readonly_probe(exit_code: int, private_log: str) -> str:
    """Diagnostic-only: a targeted Terraform plan NEVER authorizes deployment."""
    if exit_code == 0:
        return "TARGETED_SCOPE_NO_CHANGES_NOT_RELEASE_APPROVAL"
    if exit_code == 2:
        return "TARGETED_SCOPE_HAS_CHANGES_NOT_RELEASE_APPROVAL"
    if exit_code == 1:
        return "TARGETED_SCOPE_ERROR_" + classify_plan_failure(private_log, 1)
    return "TARGETED_SCOPE_UNEXPECTED_EXIT"


SCOPE_RESOURCES = frozenset({
    IDENTITY_PROVIDER, BROWSER_CLIENT, USER_POOL,
    "data.aws_caller_identity.current", "aws_cognito_user_pool_domain.browser",
    "aws_lightsail_key_pair.operator", "aws_lightsail_instance.server",
    "aws_lightsail_static_ip.server", "aws_lightsail_static_ip_attachment.server",
    "aws_lightsail_instance_public_ports.server", "aws_sns_topic.alerts",
    "aws_sns_topic_policy.alerts", "aws_sns_topic_subscription.operator",
    "aws_cloudwatch_metric_alarm.status", "aws_cloudwatch_log_group.recovery",
    "aws_iam_role.recovery", "aws_lambda_function.recovery",
    "aws_iam_role_policy.recovery", "aws_lambda_permission.recovery",
    "aws_iam_policy.host_health",
})
SCOPE_FIELDS = frozenset("""
client_id name user_pool_id callback_urls logout_urls allowed_oauth_flows
allowed_oauth_flows_user_pool_client allowed_oauth_scopes explicit_auth_flows
refresh_token_validity access_token_validity id_token_validity token_validity_units
supported_identity_providers read_attributes write_attributes generate_secret
enable_token_revocation prevent_user_existence_errors auth_session_validity
provider_name provider_type provider_details attribute_mapping user_data
source_code_hash filename last_modified qualified_arn qualified_invoke_arn
lambda_config password_policy mfa_configuration username_configuration
admin_create_user_config email_configuration tags tags_all policy assume_role_policy
port_info runtime handler layers environment code_sha256
""".split())
SCOPE_REJECTION_CODES = {
    "Unexpected Terraform plan format": "PLAN_FORMAT",
    "No Terraform resource change details": "MISSING_CHANGES",
    "Malformed Terraform change": "MALFORMED_CHANGE",
    "Plan has a non-Google or destructive production change": "NON_GOOGLE_OR_DESTRUCTIVE_CHANGE",
    "Expected one directly scoped Cognito change": "MISSING_AFTER_STATE",
    "Google provider must be new and separate": "PROVIDER_NOT_NEW",
    "Unexpected Google provider type": "PROVIDER_TYPE",
    "Google OAuth settings mismatch": "OAUTH_SETTINGS",
    "Google claim mapping mismatch": "CLAIM_MAPPING",
    "Missing current browser app-client state": "MISSING_BROWSER_STATE",
    "Must preserve existing password sign-in": "PASSWORD_PROVIDER_BOUNDARY",
    "Unreviewed app-client configuration change": "BROWSER_CONFIGURATION_CHANGE",
    "Expected precisely one provider creation and one app-client update": "EXPECTED_RESOURCE_PAIR",
    "Unexpected Terraform drift during read-only review": "RESOURCE_DRIFT",
}


def safe_scope_change_summary(document: dict) -> list[dict]:
    """Fixed resource/field vocabulary only; never disclose planned values."""
    changes = document.get("resource_changes")
    if not isinstance(changes, list):
        return []
    result = []
    for resource in changes[:100]:
        if not isinstance(resource, dict):
            continue
        change = resource.get("change")
        if not isinstance(change, dict) or change.get("actions") == ["no-op"]:
            continue
        address = resource.get("address")
        address = address if isinstance(address, str) and address in SCOPE_RESOURCES else "UNLISTED_RESOURCE"
        actions = change.get("actions")
        actions = actions if isinstance(actions, list) else []
        actions = [a if isinstance(a, str) and a in {"create", "update", "delete", "read", "no-op"}
                   else "UNLISTED_ACTION" for a in actions[:4]]
        before, after = change.get("before"), change.get("after")
        fields = []
        if isinstance(before, dict) and isinstance(after, dict):
            changed = {key for key in before.keys() | after.keys()
                       if before.get(key) != after.get(key)}
            fields = sorted(changed & SCOPE_FIELDS)
            if changed - SCOPE_FIELDS:
                fields.append("UNLISTED_FIELD")
        result.append({"resource": address, "actions": actions, "changed_fields": fields})
    return result


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python -m scripts.production.lightsail.google_plan_guard <tfplan.json>")
    document = None
    try:
        expected_id = os.environ["PROD_GOOGLE_OAUTH_CLIENT_ID"]
        document = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
        report = authorize(document, expected_id)
    except Exception as error:
        print("Plan rejection category: " +
              SCOPE_REJECTION_CODES.get(str(error), "UNCLASSIFIED_FAILURE"))
        if isinstance(document, dict):
            print("Sanitized rejected plan changes: " +
                  json.dumps(safe_scope_change_summary(document), sort_keys=True))
        raise SystemExit("FAIL: Google-only Terraform scope not verified; NO APPLY made") from None
    # Output contains only the stable, nonsecret resource names and action types.
    print(json.dumps(report, sort_keys=True))


if __name__ == "__main__":
    main()

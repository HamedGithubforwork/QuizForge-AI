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
variable variables version with
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
        results.append({
            "category": classify_plan_failure("Error: " + summary + "\n" + detail, 1),
            "summary_terms": safe_words,
        })
        if len(results) >= 4:
            break
    return results

def main():
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python -m scripts.production.lightsail.google_plan_guard <tfplan.json>")
    try:
        expected_id = os.environ["PROD_GOOGLE_OAUTH_CLIENT_ID"]
        document = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
        report = authorize(document, expected_id)
    except Exception:
        raise SystemExit("FAIL: Google-only Terraform scope not verified; NO APPLY made") from None
    # Output contains only the stable, nonsecret resource names and action types.
    print(json.dumps(report, sort_keys=True))


if __name__ == "__main__":
    main()

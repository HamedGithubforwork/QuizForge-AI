"""Apply the reviewed QuizForge style to the classic Cognito hosted UI.

The production user pool is on Cognito Lite, where the classic hosted UI is the
supported hosted experience. This controller changes only the app client's
hosted-UI CSS. It never changes users, MFA, signup policy, OAuth settings,
domains, application routing, or credentials.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
from typing import Any

import boto3
from botocore.exceptions import ClientError

REGION = "ca-central-1"
POOL_NAME = "quizforge-production-lightsail"
CLIENT_NAME = "quizforge-production-pkce"
CSS_PATH = Path("scripts/production/lightsail/cognito-hosted-ui.css")
RESULT = Path("lightsail-cognito-style-results/summary.json")
POOL_RE = re.compile(r"^ca-central-1_[A-Za-z0-9]{1,55}$")
CLIENT_RE = re.compile(r"^[a-z0-9]{1,128}$")

ALLOWED_SELECTORS = {
    ".background-customizable",
    ".banner-customizable",
    ".errorMessage-customizable",
    ".idpDescription-customizable",
    ".inputField-customizable",
    ".inputField-customizable:focus",
    ".label-customizable",
    ".legalText-customizable",
    ".passwordCheck-valid-customizable",
    ".passwordCheck-notValid-customizable",
    ".redirect-customizable",
    ".submitButton-customizable",
    ".submitButton-customizable:hover",
    ".textDescription-customizable",
}
ALLOWED_PROPERTIES = {
    "background-color",
    "padding",
    "font-weight",
    "color",
    "width",
    "height",
    "border",
    "border-color",
    "outline",
    "padding-top",
    "padding-bottom",
    "display",
    "font-size",
    "margin",
    "text-align",
    "background",
    "box-sizing",
}


def pages(client, method: str, result_key: str, **kwargs) -> list[dict[str, Any]]:
    values: list[dict[str, Any]] = []
    token = None
    while True:
        request = dict(kwargs)
        if token:
            request["NextToken"] = token
        response = getattr(client, method)(**request)
        values.extend(response.get(result_key, []))
        token = response.get("NextToken")
        if not token:
            return values


def discover(cognito) -> tuple[str, str]:
    pools = [
        item for item in pages(cognito, "list_user_pools", "UserPools", MaxResults=60)
        if item.get("Name") == POOL_NAME
    ]
    if len(pools) != 1 or not POOL_RE.fullmatch(str(pools[0].get("Id", ""))):
        raise ValueError("Expected exact production Cognito pool")
    pool_id = pools[0]["Id"]

    clients = [
        item for item in pages(
            cognito,
            "list_user_pool_clients",
            "UserPoolClients",
            UserPoolId=pool_id,
            MaxResults=60,
        )
        if item.get("ClientName") == CLIENT_NAME
    ]
    if len(clients) != 1 or not CLIENT_RE.fullmatch(str(clients[0].get("ClientId", ""))):
        raise ValueError("Expected exact production Cognito browser client")
    return pool_id, clients[0]["ClientId"]


def validate_css(text: str) -> str:
    encoded = text.encode("utf-8")
    if not 0 < len(encoded) <= 3072:
        raise ValueError("Hosted UI CSS exceeds the reviewed 3 KB bound")
    lowered = text.lower()
    if any(item in lowered for item in ("@import", "@media", "@supports", "@page", "javascript:", "url(")):
        raise ValueError("Hosted UI CSS contains a prohibited construct")

    stripped = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    blocks = re.findall(r"([^{}]+)\{([^{}]*)\}", stripped)
    remainder = re.sub(r"[^{}]+\{[^{}]*\}", "", stripped).strip()
    if not blocks or remainder:
        raise ValueError("Hosted UI CSS structure is invalid")

    for raw_selector, raw_body in blocks:
        selector = raw_selector.strip()
        if selector not in ALLOWED_SELECTORS:
            raise ValueError("Hosted UI CSS selector is not reviewed")
        declarations = [item.strip() for item in raw_body.split(";") if item.strip()]
        if not declarations:
            raise ValueError("Hosted UI CSS block is empty")
        for declaration in declarations:
            if ":" not in declaration:
                raise ValueError("Hosted UI CSS declaration is invalid")
            prop, value = (part.strip() for part in declaration.split(":", 1))
            if prop not in ALLOWED_PROPERTIES or not value or any(ch in value for ch in "{}"):
                raise ValueError("Hosted UI CSS property is not reviewed")
    return text


def safe_code(value: Any, fallback: str = "UNKNOWN") -> str:
    text = str(value or "")
    return text if re.fullmatch(r"[A-Za-z0-9._:+~-]{1,120}", text) else fallback


def write_report(report: dict[str, Any]) -> None:
    raw = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if re.search(r"\b\d{12}\b", raw) or re.search(r"ca-central-1_[A-Za-z0-9]+", raw):
        raise ValueError("Private Cognito identifier reached hosted-UI summary")
    RESULT.parent.mkdir(parents=True, exist_ok=True)
    RESULT.write_text(raw, encoding="utf-8")


def main() -> int:
    report: dict[str, Any] = {
        "schema": 1,
        "operation": "style_production_cognito_hosted_ui",
        "result": "style_failed",
        "production_pool_found": False,
        "production_client_found": False,
        "existing_custom_logo_present": False,
        "css_changed": False,
        "css_readback_matches": False,
        "identity_configuration_changed": False,
        "dns_changed": False,
        "application_changed": False,
    }
    try:
        if (
            os.environ.get("GITHUB_EVENT_NAME") != "push"
            or os.environ.get("GITHUB_REF") != "refs/heads/main"
            or os.environ.get("GITHUB_RUN_ATTEMPT") != "1"
            or os.environ.get("GITHUB_REPOSITORY") != "HamedGithubforwork/QuizForge-AI"
        ):
            raise ValueError("Live hosted-UI styling requires the first trusted main-branch push")

        css = validate_css(CSS_PATH.read_text(encoding="utf-8"))
        cognito = boto3.client("cognito-idp", region_name=REGION)
        pool_id, client_id = discover(cognito)
        report["production_pool_found"] = True
        report["production_client_found"] = True

        before = cognito.get_ui_customization(UserPoolId=pool_id, ClientId=client_id).get("UICustomization", {})
        image_url = before.get("ImageUrl")
        if isinstance(image_url, str) and image_url.strip():
            report["existing_custom_logo_present"] = True
            raise ValueError("Existing custom logo requires an explicit preserve-and-style review")

        if before.get("CSS", "") != css:
            cognito.set_ui_customization(UserPoolId=pool_id, ClientId=client_id, CSS=css)
            report["css_changed"] = True

        after = cognito.get_ui_customization(UserPoolId=pool_id, ClientId=client_id).get("UICustomization", {})
        if after.get("CSS", "") != css:
            raise ValueError("Hosted UI CSS read-back differs from reviewed style")
        report["css_readback_matches"] = True
        report["result"] = "quizforge_hosted_ui_style_applied"
    except ClientError as error:
        report["error_code"] = safe_code(error.response.get("Error", {}).get("Code"), "AWS_COGNITO_STYLE_FAILED")
    except Exception as error:
        report["error_code"] = safe_code(type(error).__name__, "COGNITO_STYLE_FAILED")
    finally:
        try:
            write_report(report)
        except Exception:
            RESULT.unlink(missing_ok=True)

    return 0 if report["result"] == "quizforge_hosted_ui_style_applied" else 1


if __name__ == "__main__":
    raise SystemExit(main())

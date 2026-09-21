"""Create only the owner's fixed USD20 alert budget; never modify existing budgets.

The email is a private repository secret. Output omits addresses, account IDs,
balances and raw AWS errors. Alerts are notifications, not a spending stop.
"""
from decimal import Decimal
import json
import os
from pathlib import Path
import re
import sys

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

NAME = "quizforge-monthly-account-cost"
COST_TYPES = {"IncludeCredit": False, "IncludeRefund": False,
    "IncludeDiscount": True, "IncludeSubscription": True, "IncludeRecurring": True,
    "IncludeUpfront": True, "IncludeSupport": True, "IncludeTax": True,
    "IncludeOtherSubscription": True, "UseBlended": False, "UseAmortized": False}
NOTIFICATIONS = [{"NotificationType": kind, "ComparisonOperator": "GREATER_THAN",
                  "Threshold": threshold, "ThresholdType": "PERCENTAGE"}
                 for kind, threshold in (("ACTUAL", 50), ("ACTUAL", 80), ("ACTUAL", 100), ("FORECASTED", 100))]


def require(condition, message):
    if not condition:
        raise ValueError(message)


def recipient(value):
    require(isinstance(value, str) and value == value.strip()
            and re.fullmatch(r"[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+", value)
            and not value.endswith(".invalid") and len(value) <= 254,
            "Set the approved recipient in AWS_BUDGET_ALERT_EMAIL")
    return value


def expected():
    return {"BudgetName": NAME, "BudgetType": "COST", "TimeUnit": "MONTHLY",
            "BudgetLimit": {"Amount": "20", "Unit": "USD"},
            "CostFilters": {}, "CostTypes": COST_TYPES.copy()}


def get_budget(client, account):
    try:
        return client.describe_budget(AccountId=account, BudgetName=NAME)["Budget"]
    except ClientError as error:
        if error.response["Error"]["Code"] == "NotFoundException":
            return None
        raise


def verify(client, account, email, budget):
    require(budget is not None, "Approved budget is absent")
    require(all(budget.get(key) == expected()[key] for key in ("BudgetName", "BudgetType", "TimeUnit")),
            "Existing budget differs; no further changes attempted")
    limit = budget.get("BudgetLimit", {})
    require(limit.get("Unit") == "USD" and Decimal(limit.get("Amount", "-1")) == Decimal("20"),
            "Existing budget amount differs; no further changes attempted")
    require(not any(budget.get(key) for key in ("CostFilters", "FilterExpression", "Metrics", "PlannedBudgetLimits", "AutoAdjustData", "BillingViewArn")),
            "Existing budget scope differs; no further changes attempted")
    require(budget.get("CostTypes") == COST_TYPES, "Existing budget cost accounting differs; no further changes attempted")
    period = budget.get("TimePeriod", {})
    if period.get("End"):
        from datetime import datetime, timezone
        require(period["End"] > datetime.now(timezone.utc), "Existing budget has ended; no further changes attempted")
    response = client.describe_notifications_for_budget(AccountId=account, BudgetName=NAME, MaxResults=100)
    require(not response.get("NextToken"), "Unexpected notification pagination")
    notices = [dict(notice) for notice in response.get("Notifications", [])]
    # AWS omits the optional ThresholdType for its percentage default. Explicit
    # ABSOLUTE_VALUE and null/unknown values must still fail verification.
    for notice in notices:
        notice.setdefault("ThresholdType", "PERCENTAGE")
    keys = tuple(NOTIFICATIONS[0])
    canonical = lambda notice: tuple(notice.get(key) for key in keys)
    matched = len(notices) == 4 and {canonical(n) for n in notices} == {canonical(n) for n in NOTIFICATIONS}
    if not matched:
        # Only approved enums and finite numeric thresholds leave this diagnostic;
        # never serialize an arbitrary AWS response or subscriber address.
        import math
        safe = []
        for notice in notices:
            value = {}
            for key, allowed in (("NotificationType", {"ACTUAL", "FORECASTED"}),
                    ("ComparisonOperator", {"GREATER_THAN", "LESS_THAN", "EQUAL_TO"}),
                    ("ThresholdType", {"PERCENTAGE", "ABSOLUTE_VALUE"})):
                value[key] = notice.get(key) if notice.get(key) in allowed else "missing_or_unknown"
            number = notice.get("Threshold")
            value["Threshold"] = number if type(number) in (int, float) and math.isfinite(number) else None
            safe.append(value)
        print("Notification threshold diagnostic: " + json.dumps(safe))
    require(matched, "Existing notification thresholds differ; no further changes attempted")
    for notice in notices:
        response = client.describe_subscribers_for_notification(AccountId=account, BudgetName=NAME,
            Notification={key: notice[key] for key in keys}, MaxResults=100)
        require(not response.get("NextToken") and response.get("Subscribers") == [{"SubscriptionType": "EMAIL", "Address": email}],
                "Existing alert recipients differ; no further changes attempted")


def execute(client, account, email, operation):
    require(re.fullmatch(r"[0-9]{12}", account) is not None, "Invalid account identity")
    recipient(email)
    require(operation in {"inspect", "activate"}, "Unknown operation")
    budget = get_budget(client, account)
    created = False
    if budget is None and operation == "activate":
        # No automatic retry on an ambiguous CreateBudget response. A subsequent
        # explicit run reads and verifies the existing object before any write.
        client.create_budget(AccountId=account, Budget=expected(),
            NotificationsWithSubscribers=[{"Notification": notice.copy(),
                "Subscribers": [{"SubscriptionType": "EMAIL", "Address": email}]} for notice in NOTIFICATIONS])
        created = True
        budget = get_budget(client, account)
    if budget is not None:
        verify(client, account, email, budget)
    return {"budget_present": budget is not None, "created": created,
            "configuration_verified": budget is not None, "monthly_usd": 20,
            "actual_alert_percentages": [50, 80, 100], "forecast_alert_percentage": 100,
            "recipient_verified": budget is not None, "delivery_verified": False,
            "spending_stop": False, "production_deployed": False}


def main():
    require(os.environ.get("GITHUB_EVENT_NAME") == "workflow_dispatch"
            and os.environ.get("GITHUB_REF") == "refs/heads/main", "Trusted manual main workflow required")
    config = Config(connect_timeout=10, read_timeout=20, retries={"total_max_attempts": 1},
                    ignore_configured_endpoint_urls=True)
    account = boto3.client("sts", config=config).get_caller_identity()["Account"]
    report = execute(boto3.client("budgets", region_name="us-east-1", config=config), account,
                     os.environ.get("AWS_BUDGET_ALERT_EMAIL", ""), os.environ.get("OPERATION", "inspect"))
    destination = Path("budget-results")
    destination.mkdir(exist_ok=True)
    (destination / "result.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    require(report["configuration_verified"], "Approved budget is not active")


if __name__ == "__main__":
    try:
        main()
    except ClientError as error:
        print("AWS budget operation refused: " + error.response["Error"]["Code"], file=sys.stderr)
        sys.exit(1)
    except ValueError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        print("Budget verification failed: " + type(error).__name__, file=sys.stderr)
        sys.exit(1)

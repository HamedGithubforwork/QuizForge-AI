"""Validate the pinned AWS provider's credential-free mocked plan shape.

Terraform's mock provider intentionally leaves many computed/default fields unknown.
Those unknowns are not live-plan evidence and must not be normalized into claims.
This bridge therefore checks only source-configured values that the mock plan
materializes, plus the exact 13-create structure. The stricter saved-plan contract
is exercised by the unit suite and remains unchanged for live inspection.
"""
from __future__ import annotations

import json
from pathlib import Path
import sys

from scripts.backup_activation.contract import (
    EXPECTED, PROVIDER_NAME, Refused, expected_values, policy_canonical, require,
)
from scripts.backup_activation.tests.fixtures import SETTINGS


def one(values, code):
    require(isinstance(values, list) and len(values) == 1, code)
    return values[0]


def equal(actual, expected, code="MOCK_PROVIDER_CONFIG_MISMATCH"):
    require(type(actual) is type(expected) or (
        type(expected) in {int, float} and type(actual) in {int, float}
    ), code)
    require(actual == expected, code)


def configured_contract(address: str, actual: dict, expected: dict) -> None:
    """Check values explicitly configured by the immutable Terraform source.

    Provider-computed defaults may be None/unknown under mock_provider. They are
    deliberately not accepted as live evidence here; live review_plan remains
    fail-closed for required safety fields.
    """
    require(isinstance(actual, dict), "MOCK_PROVIDER_VALUES_MISSING")

    if address == "aws_s3_bucket.backups":
        equal(actual.get("bucket"), expected["bucket"])
        equal(actual.get("force_destroy"), False)
        equal(actual.get("tags"), expected["tags"])
        return

    if address == "aws_s3_bucket_public_access_block.backups":
        for key in ("bucket", "block_public_acls", "block_public_policy",
                    "ignore_public_acls", "restrict_public_buckets"):
            equal(actual.get(key), expected[key])
        return

    if address == "aws_s3_bucket_ownership_controls.backups":
        equal(actual.get("bucket"), expected["bucket"])
        rule = one(actual.get("rule"), "MOCK_OWNERSHIP_RULE_MISSING")
        equal(rule.get("object_ownership"), "BucketOwnerEnforced")
        return

    if address == "aws_s3_bucket_versioning.backups":
        equal(actual.get("bucket"), expected["bucket"])
        rule = one(actual.get("versioning_configuration"), "MOCK_VERSIONING_RULE_MISSING")
        equal(rule.get("status"), "Enabled")
        return

    if address == "aws_s3_bucket_server_side_encryption_configuration.backups":
        equal(actual.get("bucket"), expected["bucket"])
        rule = one(actual.get("rule"), "MOCK_ENCRYPTION_RULE_MISSING")
        default = one(rule.get("apply_server_side_encryption_by_default"),
                      "MOCK_ENCRYPTION_DEFAULT_MISSING")
        equal(default.get("sse_algorithm"), "AES256")
        return

    if address == "aws_s3_bucket_lifecycle_configuration.backups":
        equal(actual.get("bucket"), expected["bucket"])
        rules = actual.get("rule")
        require(isinstance(rules, list) and len(rules) == 2, "MOCK_LIFECYCLE_RULES_MISSING")
        by_id = {rule.get("id"): rule for rule in rules}
        require(set(by_id) == {"bounded-recovery-window", "remove-expired-markers"},
                "MOCK_LIFECYCLE_RULES_MISMATCH")
        bounded = by_id["bounded-recovery-window"]
        equal(bounded.get("status"), "Enabled")
        equal(one(bounded.get("expiration"), "MOCK_EXPIRATION_MISSING").get("days"), 7)
        equal(one(bounded.get("noncurrent_version_expiration"),
                  "MOCK_NONCURRENT_EXPIRATION_MISSING").get("noncurrent_days"), 7)
        equal(one(bounded.get("abort_incomplete_multipart_upload"),
                  "MOCK_MULTIPART_RULE_MISSING").get("days_after_initiation"), 1)
        require(not bounded.get("transition") and not bounded.get("noncurrent_version_transition"),
                "MOCK_UNEXPECTED_LIFECYCLE_TRANSITION")
        markers = by_id["remove-expired-markers"]
        equal(markers.get("status"), "Enabled")
        equal(one(markers.get("expiration"), "MOCK_MARKER_EXPIRATION_MISSING")
              .get("expired_object_delete_marker"), True)
        require(not markers.get("transition") and not markers.get("noncurrent_version_transition"),
                "MOCK_UNEXPECTED_LIFECYCLE_TRANSITION")
        return

    if address == "aws_s3_bucket_policy.backups":
        equal(actual.get("bucket"), expected["bucket"])
        require(policy_canonical(actual.get("policy")) == policy_canonical(expected["policy"]),
                "MOCK_BUCKET_POLICY_MISMATCH")
        return

    if address in {"aws_iam_policy.uploader", "aws_iam_policy.recovery", "aws_iam_policy.health"}:
        equal(actual.get("name"), expected["name"])
        equal(actual.get("tags"), expected["tags"])
        require(policy_canonical(actual.get("policy")) == policy_canonical(expected["policy"]),
                "MOCK_IAM_POLICY_MISMATCH")
        # path is a provider default and is null under mock_provider; if materialized
        # it must remain the reviewed root path.
        if actual.get("path") is not None:
            equal(actual.get("path"), "/")
        return

    if address == "aws_sns_topic.alerts":
        equal(actual.get("name"), expected["name"])
        equal(actual.get("tags"), expected["tags"])
        if actual.get("fifo_topic") is not None:
            equal(actual.get("fifo_topic"), False)
        if actual.get("kms_master_key_id") is not None:
            require(actual.get("kms_master_key_id") in ("", None), "MOCK_TOPIC_KMS_MISMATCH")
        return

    if address == "aws_sns_topic_subscription.owner":
        equal(actual.get("topic_arn"), expected["topic_arn"])
        equal(actual.get("protocol"), "email")
        equal(actual.get("endpoint"), SETTINGS.email)
        if actual.get("raw_message_delivery") is not None:
            equal(actual.get("raw_message_delivery"), False)
        return

    if address == "aws_cloudwatch_metric_alarm.backup":
        for key in ("alarm_name", "alarm_description", "namespace", "metric_name",
                    "comparison_operator", "threshold", "period", "evaluation_periods",
                    "datapoints_to_alarm", "statistic", "treat_missing_data",
                    "alarm_actions", "ok_actions", "dimensions", "tags"):
            equal(actual.get(key), expected[key])
        if actual.get("actions_enabled") is not None:
            equal(actual.get("actions_enabled"), True)
        require(actual.get("insufficient_data_actions") in (None, []),
                "MOCK_UNEXPECTED_ALARM_ACTIONS")
        require(actual.get("metric_query") in (None, []), "MOCK_UNEXPECTED_METRIC_QUERY")
        return

    raise Refused("MOCK_UNEXPECTED_RESOURCE")


def main(path: Path) -> None:
    events = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    summaries = [e["test_summary"] for e in events if e.get("type") == "test_summary"]
    if len(summaries) != 1 or summaries[0].get("status") != "pass":
        raise RuntimeError("Pinned Terraform boundary tests did not pass")

    plans = [e["test_plan"] for e in events if e.get("type") == "test_plan"]
    if len(plans) != 1 or plans[0].get("plan_format_version") != "1.2":
        raise RuntimeError("Expected one supported mocked-provider plan")

    changes = plans[0].get("resource_changes", [])
    managed = [r for r in changes if r.get("mode") == "managed"]
    require(len(managed) == 13 and {r.get("address") for r in managed} == EXPECTED,
            "MOCK_EXPECTED_13_RESOURCES")

    expected = expected_values(SETTINGS.account, SETTINGS.email)
    failures = []
    for resource in managed:
        address = resource.get("address")
        change = resource.get("change", {})
        try:
            require(resource.get("type") == address.split(".")[0]
                    and resource.get("provider_name") == PROVIDER_NAME,
                    "MOCK_UNEXPECTED_PROVIDER")
            require(change.get("actions") == ["create"] and change.get("before") is None,
                    "MOCK_INITIAL_CREATES_ONLY")
            require(not change.get("replace_paths") and not change.get("importing")
                    and not resource.get("previous_address") and not resource.get("deposed"),
                    "MOCK_ADOPTION_OR_REPLACEMENT")
            configured_contract(address, change.get("after"), expected[address])
        except (Refused, KeyError, TypeError) as error:
            failures.append(address)
            # All values here come only from the public synthetic mock plan.
            print(json.dumps({"resource": address, "failure": str(error),
                              "mocked_values": change.get("after")}, sort_keys=True))

    if failures:
        raise RuntimeError(f"Mocked-provider configured contract rejected {len(failures)} resources")

    print("PASS: pinned mock provider exposes the reviewed configured values for all 13 creates; "
          "computed/default unknowns are not treated as live evidence")


if __name__ == "__main__":
    main(Path(sys.argv[1]))

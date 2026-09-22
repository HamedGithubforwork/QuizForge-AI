"""Check actual mocked-provider changes against the activation contract.

Input is credential-free `terraform test -json -verbose` output from the pinned
candidate. Terraform's test_plan omits the saved-plan configuration and header;
those fields are supplied by the explicitly synthetic fixture. This checks the
provider's value/unknown shapes, NOT a live saved plan, permissions, or AWS state.
This module is validation-only and must never process a private cloud plan.
"""
from __future__ import annotations

import copy
import json
from pathlib import Path
import sys

from scripts.backup_activation.contract import (
    Refused, compare, expected_values, no_extra_settings, resolve_named_links,
    review_plan, unknown,
)
from scripts.backup_activation.tests.fixtures import SETTINGS, plan


def main(path: Path) -> None:
    events = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    summaries = [e["test_summary"] for e in events if e.get("type") == "test_summary"]
    if len(summaries) != 1 or summaries[0].get("status") != "pass":
        raise RuntimeError("Pinned Terraform boundary tests did not pass")
    plans = [e["test_plan"] for e in events if e.get("type") == "test_plan"]
    if len(plans) != 1 or plans[0].get("plan_format_version") != "1.2":
        raise RuntimeError("Expected one supported mocked-provider plan")
    document = plan()
    document["resource_changes"] = plans[0]["resource_changes"]
    document["resource_drift"] = plans[0].get("resource_drift", [])
    expected = expected_values(SETTINGS.account, SETTINGS.email)
    configs = {r["address"]: r for r in document["configuration"]["root_module"]["resources"]}
    failures = []
    for resource in document["resource_changes"]:
        if resource.get("mode") != "managed":
            continue
        address = resource["address"]
        values = copy.deepcopy(resource["change"]["after"])
        mask = copy.deepcopy(resource["change"].get("after_unknown", {}))
        try:
            resolve_named_links(address, values, mask, configs[address]["expressions"], expected[address])
            no_extra_settings(address, values, mask)
            compare(values, expected[address], mask)
        except (Refused, KeyError) as error:
            failures.append(address)
            # These values originate solely from the public synthetic test.
            print(json.dumps({"resource": address, "failure": str(error),
                              "unknown_fields": sorted(k for k, v in mask.items() if unknown(v)),
                              "mocked_values": values}, sort_keys=True))
    if failures:
        raise RuntimeError(f"Mocked-provider contract rejected {len(failures)} resources")
    review_plan(document, SETTINGS)
    print("PASS: 13 actual mocked-provider creates satisfy the resource contract; no AWS evidence implied")


if __name__ == "__main__":
    main(Path(sys.argv[1]))

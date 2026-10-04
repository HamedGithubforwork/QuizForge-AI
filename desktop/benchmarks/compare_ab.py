"""Compare same-run Local AI benchmark reports without selecting a model automatically."""
from __future__ import annotations

import argparse
import json
from pathlib import Path


EXPECTED_FIXTURES = {
    "facts",
    "multi_page",
    "instruction_in_notes",
    "french_notes",
    "long_notes",
    "insufficient_source",
}


def load_report(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path}: report must be an object")
    return value


def validate_report(name: str, report: dict) -> list[str]:
    errors: list[str] = []
    runs = report.get("runs")
    if report.get("schema") != 1:
        errors.append("schema")
    if report.get("suite") != "all":
        errors.append("suite")
    if not isinstance(runs, list) or len(runs) != len(EXPECTED_FIXTURES):
        errors.append("run_count")
        return errors
    fixture_ids = {row.get("fixture") for row in runs if isinstance(row, dict)}
    if fixture_ids != EXPECTED_FIXTURES:
        errors.append("fixtures")
    if report.get("structurally_valid") != len(EXPECTED_FIXTURES):
        errors.append("structural_count")
    if any(not isinstance(row, dict) or row.get("errors") for row in runs):
        errors.append("run_errors")
    if report.get("platform") != "Windows":
        errors.append("platform")
    if report.get("runtime_version") != "b11317":
        errors.append("runtime_version")
    if errors:
        print(f"{name} validation errors: {', '.join(errors)}")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--candidate-source-revision", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    baseline = load_report(args.baseline)
    candidate = load_report(args.candidate)
    baseline_errors = validate_report("baseline", baseline)
    candidate_errors = validate_report("candidate", candidate)

    same_settings = (
        baseline.get("generation_settings")
        == candidate.get("generation_settings")
    )
    same_runtime = (
        baseline.get("runtime_version")
        == candidate.get("runtime_version")
    )
    baseline_median = float(baseline.get("median_seconds", 0))
    candidate_median = float(candidate.get("median_seconds", 0))
    latency_ratio = (
        candidate_median / baseline_median
        if baseline_median > 0
        else None
    )
    baseline_bytes = int(baseline.get("model_bytes", 0))
    candidate_bytes = int(candidate.get("model_bytes", 0))
    size_ratio = (
        candidate_bytes / baseline_bytes
        if baseline_bytes > 0
        else None
    )

    comparison = {
        "schema": 1,
        "decision": "manual_semantic_review_required",
        "candidate_source_revision": args.candidate_source_revision,
        "same_runner_job": True,
        "same_generation_settings": same_settings,
        "same_runtime_version": same_runtime,
        "baseline": {
            "model_sha256": baseline.get("model_sha256"),
            "model_bytes": baseline_bytes,
            "median_seconds": baseline_median,
            "structurally_valid": baseline.get("structurally_valid"),
        },
        "candidate": {
            "model_sha256": candidate.get("model_sha256"),
            "model_bytes": candidate_bytes,
            "median_seconds": candidate_median,
            "structurally_valid": candidate.get("structurally_valid"),
        },
        "candidate_vs_baseline": {
            "median_latency_ratio": (
                round(latency_ratio, 4)
                if latency_ratio is not None
                else None
            ),
            "model_size_ratio": (
                round(size_ratio, 4)
                if size_ratio is not None
                else None
            ),
            "latency_screen": (
                "pass"
                if latency_ratio is not None and latency_ratio <= 1.25
                else "review"
            ),
            "size_screen": (
                "pass"
                if size_ratio is not None and size_ratio <= 1.15
                else "review"
            ),
        },
        "automated_gate": (
            "pass"
            if not baseline_errors
            and not candidate_errors
            and same_settings
            and same_runtime
            else "fail"
        ),
        "limitations": [
            "Synthetic fixtures do not establish general factual accuracy.",
            "Outputs still require manual semantic review before changing the product default.",
            "A hosted Windows runner is not representative consumer hardware.",
            "Latency is secondary evidence because shared-runner CPU performance varies.",
        ],
    }
    args.output.write_text(
        json.dumps(comparison, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(comparison, indent=2))
    return 0 if comparison["automated_gate"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())

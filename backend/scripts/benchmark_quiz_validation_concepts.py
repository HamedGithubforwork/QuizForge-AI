from __future__ import annotations

import argparse
import json
import math
import platform
import statistics
import sys
import time
from pathlib import Path
from types import SimpleNamespace

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from quiz_validation import get_quiz_validation_errors


QUESTION_COUNT = 15
PAGE_COUNT = QUESTION_COUNT


def _build_quiz_fixture():
    questions = []

    for index in range(QUESTION_COUNT):
        groups = [
            [
                f"alpha concept {index}",
                f"alpha {index}",
                f"alpha topic {index}",
            ],
            [
                f"beta concept {index}",
                f"beta {index}",
                f"beta topic {index}",
            ],
            [
                f"gamma concept {index}",
                f"gamma {index}",
                f"gamma topic {index}",
            ],
        ]
        correct_answer = (
            f"alpha concept {index}; beta concept {index}; "
            f"gamma concept {index}"
        )
        accepted_answer = (
            f"alpha {index}; beta {index}; gamma {index}"
        )
        grading = SimpleNamespace(
            grading_mode="concepts",
            answer_groups=groups,
            required_group_count=3,
            numeric_value=0,
            numeric_tolerance=0,
            numeric_unit="",
        )
        questions.append(
            SimpleNamespace(
                question_type="short_answer",
                question=f"Describe the three concepts in case {index}?",
                choices=[],
                correct_index=-1,
                correct_answer=correct_answer,
                accepted_answers=[correct_answer, accepted_answer],
                grading=grading,
                explanation=f"The source describes all three concepts in case {index}.",
                source_pages=[index + 1],
            )
        )

    return SimpleNamespace(
        title="Deterministic concept validation benchmark",
        questions=questions,
    )


def _percentile_95(samples_ms: list[float]) -> float:
    ordered = sorted(samples_ms)
    index = max(0, math.ceil(len(ordered) * 0.95) - 1)
    return ordered[index]


def run_benchmark(*, warmups: int, samples: int, batch_size: int) -> dict[str, object]:
    quiz = _build_quiz_fixture()

    def validate_batch() -> None:
        for _ in range(batch_size):
            errors = get_quiz_validation_errors(
                quiz,
                question_count=QUESTION_COUNT,
                requested_question_type="short_answer",
                page_count=PAGE_COUNT,
            )
            if errors:
                raise RuntimeError("Concept-heavy benchmark fixture failed validation: " + "; ".join(errors))

    for _ in range(warmups):
        validate_batch()

    samples_ms = []
    for _ in range(samples):
        started_at = time.perf_counter_ns()
        validate_batch()
        samples_ms.append((time.perf_counter_ns() - started_at) / 1_000_000)

    median_ms = statistics.median(samples_ms)
    p95_ms = _percentile_95(samples_ms)
    return {
        "benchmark": "quiz_validation_15_concept_questions",
        "python": platform.python_version(),
        "platform": platform.platform(),
        "questions_per_validation": QUESTION_COUNT,
        "operations_per_sample": batch_size,
        "warmup_samples": warmups,
        "sample_count": samples,
        "median_batch_ms": round(median_ms, 3),
        "p95_batch_ms": round(p95_ms, 3),
        "median_per_validation_ms": round(median_ms / batch_size, 4),
        "p95_per_validation_ms": round(p95_ms / batch_size, 4),
        "all_fixtures_valid": True,
        "samples_ms": [round(sample, 3) for sample in samples_ms],
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Benchmark deterministic short-answer concept rubric validation."
    )
    parser.add_argument("--warmups", type=int, default=3)
    parser.add_argument("--samples", type=int, default=25)
    parser.add_argument("--batch-size", type=int, default=100)
    args = parser.parse_args()
    if args.warmups < 0 or args.samples < 2 or args.batch_size < 1:
        parser.error("warmups must be nonnegative; samples must be at least 2; batch-size must be positive")

    print(json.dumps(run_benchmark(
        warmups=args.warmups,
        samples=args.samples,
        batch_size=args.batch_size,
    ), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

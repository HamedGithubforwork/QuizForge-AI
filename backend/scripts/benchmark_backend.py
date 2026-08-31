from __future__ import annotations

import argparse
import json
import math
import statistics
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import pymupdf

from quiz_service import (
    Quiz,
    QuizQuestion,
    ShortAnswerGradingSpec,
    extract_pdf_pages,
)
from quiz_validation import get_quiz_validation_errors

PDF_PAGE_COUNT = 40
PDF_WARMUP_RUNS = 2
PDF_SAMPLE_RUNS = 12
VALIDATION_BATCH_SIZE = 100
VALIDATION_WARMUP_RUNS = 2
VALIDATION_SAMPLE_RUNS = 12

P95_BUDGETS_MS = {
    "pdf_extraction_40_pages": 50.0,
    "quiz_validation_100x15_questions": 120.0,
}


@dataclass(frozen=True)
class BenchmarkResult:
    name: str
    samples_ms: list[float]
    operations_per_sample: int

    @property
    def median_ms(self) -> float:
        return statistics.median(self.samples_ms)

    @property
    def p95_ms(self) -> float:
        ordered = sorted(self.samples_ms)
        index = max(
            0,
            math.ceil(len(ordered) * 0.95) - 1,
        )
        return ordered[index]

    def as_dict(self) -> dict[str, float | int | str]:
        return {
            "name": self.name,
            "samples": len(self.samples_ms),
            "operations_per_sample": self.operations_per_sample,
            "median_ms": round(self.median_ms, 3),
            "p95_ms": round(self.p95_ms, 3),
            "p95_budget_ms": P95_BUDGETS_MS[self.name],
        }


def _measure(
    *,
    name: str,
    operation: Callable[[], None],
    warmup_runs: int,
    sample_runs: int,
    operations_per_sample: int = 1,
) -> BenchmarkResult:
    for _ in range(warmup_runs):
        operation()

    samples_ms: list[float] = []

    for _ in range(sample_runs):
        started_at = time.perf_counter_ns()
        operation()
        elapsed_ns = time.perf_counter_ns() - started_at
        samples_ms.append(elapsed_ns / 1_000_000)

    return BenchmarkResult(
        name=name,
        samples_ms=samples_ms,
        operations_per_sample=operations_per_sample,
    )


def _build_pdf_fixture() -> bytes:
    document = pymupdf.open()

    try:
        for page_number in range(1, PDF_PAGE_COUNT + 1):
            page = document.new_page()
            lines = [
                (
                    f"QuizForge benchmark page {page_number}, line {line_number}. "
                    "Deterministic study material exercises text extraction "
                    "without network, Redis, database, or OpenAI latency."
                )
                for line_number in range(1, 13)
            ]
            text = "\n".join(lines)
            remaining = page.insert_textbox(
                pymupdf.Rect(48, 48, 547, 794),
                text,
                fontsize=9,
                fontname="helv",
            )
            if remaining < 0:
                raise RuntimeError(
                    "Benchmark PDF fixture text overflowed the page."
                )

        return document.tobytes(
            garbage=4,
            deflate=True,
        )
    finally:
        document.close()


def _none_grading() -> ShortAnswerGradingSpec:
    return ShortAnswerGradingSpec(
        grading_version=2,
        grading_mode="none",
        answer_groups=[],
        required_group_count=0,
        numeric_value=0,
        numeric_tolerance=0,
        numeric_unit="",
    )


def _build_quiz_fixture() -> Quiz:
    questions: list[QuizQuestion] = []

    for index in range(5):
        mc_answer = f"Correct option {index}"
        questions.append(
            QuizQuestion(
                question_type="multiple_choice",
                question=f"Benchmark multiple choice question {index}?",
                choices=[
                    mc_answer,
                    f"Distractor A {index}",
                    f"Distractor B {index}",
                    f"Distractor C {index}",
                ],
                correct_index=0,
                correct_answer=mc_answer,
                accepted_answers=[mc_answer],
                grading=_none_grading(),
                explanation=f"Explanation for multiple choice {index}.",
                source_pages=[index + 1],
            )
        )

        tf_answer = "True" if index % 2 == 0 else "False"
        tf_index = 0 if tf_answer == "True" else 1
        questions.append(
            QuizQuestion(
                question_type="true_false",
                question=f"Benchmark true false statement {index}.",
                choices=["True", "False"],
                correct_index=tf_index,
                correct_answer=tf_answer,
                accepted_answers=[tf_answer],
                grading=_none_grading(),
                explanation=f"Explanation for true false {index}.",
                source_pages=[index + 6],
            )
        )

        if index % 3 == 0:
            correct_answer = (
                f"alpha concept {index} and beta concept {index}"
            )
            grading = ShortAnswerGradingSpec(
                grading_version=2,
                grading_mode="concepts",
                answer_groups=[
                    [f"alpha concept {index}", f"alpha {index}"],
                    [f"beta concept {index}", f"beta {index}"],
                ],
                required_group_count=2,
                numeric_value=0,
                numeric_tolerance=0,
                numeric_unit="",
            )
            accepted_answers = [
                correct_answer,
                f"alpha {index} beta {index}",
            ]
        elif index % 3 == 1:
            correct_answer = "1000 g"
            grading = ShortAnswerGradingSpec(
                grading_version=2,
                grading_mode="numeric",
                answer_groups=[],
                required_group_count=0,
                numeric_value=1000,
                numeric_tolerance=0.1,
                numeric_unit="g",
            )
            accepted_answers = [
                correct_answer,
                "1 kg",
            ]
        else:
            correct_answer = f"HTTP 40{index}"
            grading = ShortAnswerGradingSpec(
                grading_version=2,
                grading_mode="exact",
                answer_groups=[],
                required_group_count=0,
                numeric_value=0,
                numeric_tolerance=0,
                numeric_unit="",
            )
            accepted_answers = [
                correct_answer,
                f"40{index}",
            ]

        questions.append(
            QuizQuestion(
                question_type="short_answer",
                question=f"Benchmark short answer question {index}?",
                choices=[],
                correct_index=-1,
                correct_answer=correct_answer,
                accepted_answers=accepted_answers,
                grading=grading,
                explanation=f"Explanation for short answer {index}.",
                source_pages=[index + 11],
            )
        )

    quiz = Quiz(
        title="Deterministic benchmark quiz",
        questions=questions,
    )

    errors = get_quiz_validation_errors(
        quiz,
        question_count=15,
        requested_question_type="mixed",
        page_count=PDF_PAGE_COUNT,
    )
    if errors:
        raise RuntimeError(
            "Benchmark quiz fixture is invalid: "
            + "; ".join(errors)
        )

    return quiz


def run_benchmarks() -> list[BenchmarkResult]:
    pdf_fixture = _build_pdf_fixture()
    quiz_fixture = _build_quiz_fixture()

    def extract_pdf() -> None:
        pages = extract_pdf_pages(pdf_fixture)
        if len(pages) != PDF_PAGE_COUNT:
            raise RuntimeError(
                "Benchmark PDF extraction returned the wrong page count."
            )
        if any(not page["text"] for page in pages):
            raise RuntimeError(
                "Benchmark PDF extraction returned an empty text page."
            )

    def validate_quiz_batch() -> None:
        for _ in range(VALIDATION_BATCH_SIZE):
            errors = get_quiz_validation_errors(
                quiz_fixture,
                question_count=15,
                requested_question_type="mixed",
                page_count=PDF_PAGE_COUNT,
            )
            if errors:
                raise RuntimeError(
                    "Benchmark quiz validation unexpectedly failed."
                )

    return [
        _measure(
            name="pdf_extraction_40_pages",
            operation=extract_pdf,
            warmup_runs=PDF_WARMUP_RUNS,
            sample_runs=PDF_SAMPLE_RUNS,
        ),
        _measure(
            name="quiz_validation_100x15_questions",
            operation=validate_quiz_batch,
            warmup_runs=VALIDATION_WARMUP_RUNS,
            sample_runs=VALIDATION_SAMPLE_RUNS,
            operations_per_sample=VALIDATION_BATCH_SIZE,
        ),
    ]


def _budget_failures(
    results: list[BenchmarkResult],
) -> list[str]:
    failures: list[str] = []

    for result in results:
        budget_ms = P95_BUDGETS_MS[result.name]
        if result.p95_ms > budget_ms:
            failures.append(
                f"{result.name} p95 {result.p95_ms:.3f} ms "
                f"exceeded {budget_ms:.3f} ms budget"
            )

    return failures


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Run deterministic CPU-local QuizForge backend performance benchmarks."
        )
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Fail when a benchmark exceeds its p95 regression budget.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit machine-readable JSON only.",
    )
    args = parser.parse_args()

    results = run_benchmarks()
    failures = _budget_failures(results) if args.check else []
    payload = {
        "python": sys.version.split()[0],
        "results": [result.as_dict() for result in results],
        "budget_failures": failures,
    }

    if args.json:
        print(json.dumps(payload, sort_keys=True))
        return 1 if failures else 0

    print("QuizForge deterministic backend benchmark")
    print(f"Python: {payload['python']}")
    for result in results:
        budget_ms = P95_BUDGETS_MS[result.name]
        print(
            f"- {result.name}: median={result.median_ms:.3f} ms, "
            f"p95={result.p95_ms:.3f} ms, "
            f"budget={budget_ms:.3f} ms, "
            f"operations/sample={result.operations_per_sample}"
        )

    if failures:
        print("Performance budget failures:")
        for failure in failures:
            print(f"- {failure}")
        return 1

    if args.check:
        print("All performance budgets passed.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

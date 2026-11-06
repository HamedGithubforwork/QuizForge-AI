# Pilot progress

## Current state

- Status: one cycle completed and kept; pilot stopped before cycle 2 implementation because no safe, meaningful non-overlapping opportunity is available on this `main` checkout.
- Branch: `pilot/qfn-five-cycle-optimization` from `main` at `50ced51d965bce0e7bde69b4b90b1cff383ee6d3`.
- Working tree started clean. No application code has changed.
- Roles and concurrency: the merged team has Coordinator plus ten original specialists and `merge_manager`; `.codex/config.toml` retains a maximum of three concurrent threads.

## Kickoff findings

- Open Qwen/local-AI work already covers inference profiling/model comparisons (#649–#650, #654), recovery and grounding (#651–#663), stage timing and candidate reduction (#664–#665), and a same-runner ABBA comparison (#666). Do not duplicate or adopt those unmerged changes.
- Existing findings flag risk: a six-fact targeted-practice case was reported at 331.637 seconds against a 210-second limit; #665 reports a critical-biology/visible-quality failure. #666's same-runner check passed, but its artifact evidence still needs independent examination before drawing a conclusion.
- PR #656 covers Actions OCR parallelization; #667 covers temporary artifact pruning. Avoid duplicating CI/storage changes.
- `main` contains only `desktop/benchmarks/prompt-v3` and `prompt-v4`; the desktop local-Qwen service and its tests are absent. Those model comparisons pin historical source and require Windows x64, llama.cpp, and model files. Their latest successful full runs were about 38–41 minutes, so they will not be rerun casually.
- Attempted existing baseline: `python backend/scripts/benchmark_backend.py --json` failed before measuring because Python 3.14 has no `pymupdf` installed (`ModuleNotFoundError`). Python 3.12 ARM64 is available but has none of the backend test dependencies. No dependency installation or Actions run has been started.
- Disjoint candidate selected: repeated normalization in backend concept-rubric validation. It affects answer grading and is separate from the active desktop/Qwen and CI PRs. Any change must preserve all existing normalization, answer acceptance, uniqueness, and validation behavior.

## Cycle log

| Cycle | Opportunity / status | Baseline | Change | Quality and tests | Decision |
|---|---|---|---|---|---|
| 1 | Reduce repeated normalization in concept-rubric validation; a disjoint backend CPU path while Qwen source/tooling is unavailable on `main`. | On Python 3.12.6 ARM64 / Windows 11, command `py -3.12 backend/scripts/benchmark_quiz_validation_concepts.py --warmups 3 --samples 25 --batch-size 100`; 15 valid concept questions per quiz, 100 validations/sample, 25 measured samples. Baseline median 302.403 ms/batch (3.024 ms/validation); p95 319.240 ms/batch (3.1924 ms/validation). All fixtures passed. | Precompute alias tokens once per concept rubric and tokenize each answer once per grading call; bounded local memory only. Added a deterministic stdlib benchmark and four focused stdlib unit tests. | Coordinator post-run: median 147.173 ms/batch (-51.3%); p95 185.751 ms/batch (-41.8%). Independent QA repeat: median 154.200 ms/batch (-49.0%); p95 165.123 ms/batch (-48.3%). Four focused tests passed; `git diff --check` passed. Reviewer found no actionable issues; AI Quality approved semantic equivalence for concept grouping, partial answers, normalized aliases, and Unicode/spelling behavior. Full pytest/backend benchmark remains unavailable without PyMuPDF and backend dependencies; no dependency install, model run, or workflow trigger. | Keep: measured gain is far above the 10% threshold on the same host/runtime, p95 improved, fixture validity and focused grading checks passed. No memory reduction is claimed. |
| 2 | Opportunity assessment only: quiz-history analytics was evaluated as a disjoint local candidate. Product work is bounded to a 20-row loaded page and 30 document-analysis attempts; reported same-host p50 was ~0.008 ms at 20 rows and ~1.662 ms for an artificial 5,000 rows. The focused Node test passes. Both Investigator and Performance Engineer judged it immaterial at product limits. No implementation or cycle baseline was started. | Not applicable: no candidate met the measurable/user-relevant benefit bar. | None | No new tests/workflows; relied on the existing focused Node test result reported by Investigator. | Do not spend a cycle on negligible bounded work. Stop further cycles: Qwen implementation/tooling is absent from `main` and active PRs already cover Qwen plus CI/artifact work; no other disjoint measurable candidate emerged. |
| 3 | Not attempted: same stop reason as cycle 2; no safe, non-overlapping candidate with meaningful measurable benefit. | — | — | — | — |
| 4 | Not attempted: same stop reason as cycle 2; no safe, non-overlapping candidate with meaningful measurable benefit. | — | — | — | — |
| 5 | Not attempted: same stop reason as cycle 2; no safe, non-overlapping candidate with meaningful measurable benefit. | — | — | — | — |

## Resume notes

Do not repeat the kickoff audit, cycle 1 baseline, or cycle 1 implementation. Cycle 1 is validated and retained on the pilot branch. The pilot is stopped before cycle 2 implementation; resume only after the desktop/Qwen source and its supported runtime are available on `main`, or a new disjoint opportunity has credible product-scale impact, reproducible measurements, and focused tests. Do not claim that the backend grading benchmark measures Qwen generation or model quality.

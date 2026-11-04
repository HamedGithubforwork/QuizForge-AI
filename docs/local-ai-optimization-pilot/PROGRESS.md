# Local Qwen optimization pilot progress

Repository: `HamedGithubforwork/QuizForge-AI`
Pilot branch: `pilot/local-qwen-three-cycles-20261104`
Base branch: `diagnostic/targeted-practice-stage-timing-20261103` (PR #664)
Base commit: `fa78f5944381aa5cc6edbfa3c7f43e8211e226c0`

## Scope and safeguards

This pilot may attempt up to three optimization cycles. Each change requires a
same-fixture baseline, focused implementation, local regression checks, an
independent Reviewer and QA assessment, and comparable performance evidence.
Windows x64 model runs are limited to one acceptance run per validated change;
no run is started without a focused change that has passed local checks. No
application changes are accepted without preserving source grounding, question
uniqueness, grading, reliability, and existing security validation. This pilot
does not merge pull requests, deploy, or start paid infrastructure.

## Branch selection and existing work

The starting point is PR #664, the latest branch in the Local Qwen stack with a
green full product acceptance run. Its head is
`fa78f5944381aa5cc6edbfa3c7f43e8211e226c0`. PR #665's candidate-batching
descendant showed a two-trial speed signal but its latest full acceptance had
critical-biology and factual-quality failures, so it was not used as a base.
PR #666 supplies the ABBA comparison harness. Existing recovery routing in
#663/#664 and batching work in #665 are treated as active work and are not
duplicated here.

## Cycle 1 — recovery-path opportunity review (no change kept)

**Question.** Can weak-area recovery be shortened safely without repeating
existing routing or candidate-batching work?

**Baseline.** Windows x64, Qwen3-4B Q4_K_M, CPU inference, 4 logical CPUs and
16 GiB host memory. PR #664 product acceptance run `41733439968` passed. Across
six generated runs, median quiz time was **128.537 s**, maximum was **175.795
s**, maximum working set was **6,586,454,016 bytes** (about 6.14 GiB), and
maximum process CPU time was **518.27 s**. The latency and process-resource
screens passed. The targeted-practice fixture took **175.795 s**. Its single
stage trace recorded generation at **20.835 s**, weak-area recovery at
**107.192 s**, and retry generation at **172.343 s**. The final quiz contained
five questions cited to source pages 2 and 4. This is one targeted sample and
does not isolate prompt processing from generated-token time.

**Local baseline checks.** On Node `v24.16.0`, ran:

```text
node --test --test-name-pattern="targeted practice|targeted-practice|false insufficient-source|targeted retry" desktop/test/local-quiz-service.test.cjs desktop/test/local-ai-recovery.test.cjs
```

Result: 17 passed, 0 failed, 0 skipped; duration 290.86 ms. These tests use
deterministic fixtures and do not measure Qwen inference speed.

**Assessment.** Investigator and Performance Engineer independently found the
weak-area recovery stage is a plausible hotspot but agreed the single sample
does not establish a stable target. Shortening its full-context request or
skipping it could affect grounding and question coverage; those choices need a
controlled Windows x64 comparison. Recovery routing is already covered by
#663/#664, and candidate batching is under active development in #665 with
quality failures. No focused, non-duplicative implementation had credible
supporting evidence, so no application code was changed and no costly model
workflow was triggered.

**Outcome.** Attempt unsuccessful; no improvement measured, no change kept.
This is not a completed optimization cycle. Reviewer and QA are asked to
independently inspect this record and confirm that the branch contains no
application changes. Do not claim a Qwen speedup from this attempt.

## Remaining cycles

Cycles 2 and 3 were not attempted. Resume only after a repeatable profile or
same-fixture measurements identify a distinct opportunity and its baseline,
quality checks, and resource budget are defined. Current evidence is not enough
to justify a change to recovery behavior.

## Evidence links

- PR #664: https://github.com/HamedGithubforwork/QuizForge-AI/pull/664
- PR #664 full acceptance run: https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/41733439968
- PR #665: https://github.com/HamedGithubforwork/QuizForge-AI/pull/665
- PR #666: https://github.com/HamedGithubforwork/QuizForge-AI/pull/666

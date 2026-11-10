# Local Qwen optimization pilot progress

Repository: `HamedGithubforwork/QuizForge-AI`
Pilot branch: `pilot/local-qwen-three-cycles-20261104`
Base branch: `diagnostic/targeted-practice-stage-timing-20261103` (PR #664)
Base commit: `fa78f5944381aa5cc6edbfa3c7f43e8211e226c0`

## Scope and safeguards

This pilot may attempt up to three optimization cycles. Each change requires a
same-fixture baseline, focused implementation, local regression checks, an
independent Reviewer and QA assessment, and comparable performance evidence.
When an evidence gap blocks safe prioritization, the pilot allows at most one
bounded, targeted Windows x64 diagnostic before the first proposed change.
Implementation acceptance runs remain limited to what is needed to validate a
focused change after local checks. No application changes are accepted without
preserving source grounding, question uniqueness, grading, reliability, and
existing security validation. This pilot does not merge pull requests, deploy,
or start paid infrastructure.

## Branch selection and existing work

The starting point is PR #664, the latest branch in the Local Qwen stack with a
green full product acceptance run. Its head is
`fa78f5944381aa5cc6edbfa3c7f43e8211e226c0`. PR #665's candidate-batching
descendant showed a two-trial speed signal but its latest full acceptance had
a critical-biology runtime availability failure and a separate targeted
factual-quality failure, so it was not used as the implementation base.
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
stage trace records cumulative offsets from fixture start: primary generation
at **20.835 s**, weak-area recovery at **107.192 s**, and retry generation at
**172.343 s**. The derived intervals are about **20.8 s**, **86.4 s**, and
**65.2 s**. The final quiz contained five questions cited to source pages 2
and 4. This is one targeted sample and does not isolate prompt processing from
generated-token time.

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

## Follow-up evidence and diagnostic workflow decision

The next workflow branch rechecked the existing PR artifacts instead of
triggering a new workflow:

- PR #665 acceptance run `41878992364` used the same synthetic fixture and
  Windows x64 CPU conditions. The targeted trace records cumulative offsets:
  primary response at **50.005 s**, weak-area recovery at **128.860 s**, retry
  responses at **179.395 s** and **244.044 s**, then
  `candidate_pool_exhausted` at **244.047 s**. Derived intervals are about
  **50.0 s**, **78.9 s**, **50.5 s**, and **64.6 s**. Its product-acceptance
  artifact omitted validator counters for the final recovery issue.
- In that same run, the separate critical biology job failed with
  `runtime_unavailable` before any generation attempt or validation. This is a
  runtime setup failure, not evidence of lower biology question quality. The
  factual-quality job failed only after targeted recovery exhausted its
  candidate pool. The latency/resource gate was skipped.
- PR #666 run `41748544318` measured its synthetic ABBA fixture on the same
  host: baseline median **101.349 s / 3 calls**, optimized median **75.439 s /
  2 calls**, two trials per variant, all four semantic checks passed. This is
  useful evidence for that fixture but does not explain the #665 recovery
  failure; its batching change remains in #665 and is not duplicated here.

Investigator, Performance Engineer, and AI Quality independently agreed that
existing evidence is sufficient to identify a specific unresolved question:
which validator categories reject targeted-practice candidates, and what
portion of each generation call is prompt prefill versus token decode when
llama.cpp exposes those timings. One manual, targeted Windows x64 diagnostic is
justified before any implementation change. Its planned fixture is
`selected_pages_targeted_practice`; it derives prior-question exclusions from
one warm-up quiz, then measures the targeted quiz once. The report retains only
numeric timing/token/counter data, bounded outcome codes, and fixture/hardware
labels. It does not retain raw prompts, responses, quiz text, source notes, or
rejected candidate text. The workflow has a 25-minute timeout and does not run
on pull requests. Dispatch was attempted once; GitHub did not create a run
because the workflow is not on the default branch.

## Diagnostic workflow implementation

On branch `workflow/diagnostic-first-local-qwen-20261104`, the protocol now
separates diagnostic measurements from implementation cycles. The new manual
workflow can select only the allowlisted #664 or #665 source branch, checks out
that exact app commit, and runs one warm-up plus one targeted-practice quiz on
the synthetic selected-pages fixture. It records per-response time intervals,
per-call timing/token data when available, and fixed validator/oracle reason
counts. The report excludes all source notes, prompts, generated responses,
questions, source facts, and rejected candidate text. The job is limited to
hosted Windows x64 CPU, 25 minutes, read-only repository access, a verified
pinned model/runtime, and a three-day artifact retention window. It has no
pull-request trigger.

Local validation on Node `v24.16.0`: diagnostic script and test syntax checks
passed; four focused sanitizer/summary tests passed; `git diff --check` passed.
A local YAML parser was unavailable on this host; the workflow was validated
with `actionlint 1.7.12` on Windows ARM64. The first manual dispatch attempt,
before the workflow reached `main`, returned **HTTP 404: workflow not found on
the default branch**. After infrastructure PR #676 merged to `main` as
`aad0afeda769a6715f2ba8351294b61839ff5fe6`, one manual dispatch succeeded.

## Diagnostic run — PR #665 targeted recovery

Run `42046508800` completed successfully on hosted `windows-2025`, x64 CPU,
using the pinned Qwen3-4B Q4_K_M model and verified llama.cpp runtime. The
diagnostic app source was PR #665 branch
`perf/local-practice-minimal-replacement-batch-20261103` at exact SHA
`85518cf6240836448ef331260d16ba2401d7bfa7`. It executed one warm-up quiz and
one `selected_pages_targeted_practice` quiz.

The targeted generation took **124.389 s** and passed the strict synthetic
semantic oracle, produced **5 questions / 5 distinct wordings**, and avoided
both prior questions. This establishes success only for this run and fixture.
The earlier run `41878992364` on the same source SHA took **244.047 s** and
failed with `candidate_pool_exhausted`; the timing difference is run
variability, not a demonstrated optimization. The diagnostic did not reproduce
that failure. Its 3-day artifact expired before this report update, so the
available results below were recovered from the retained numeric-only Actions
log.

| Call | Phase | Elapsed interval | Inference | Prefill | Decode | Prompt / completion tokens |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | Primary generation | 22.539 s | 16.751 s | 15.326 s | 1.412 s | 1,347 / 18 |
| 2 | Weak-area recovery | 48.382 s | 48.380 s | 6.199 s | 42.146 s | 604 / 549 |
| 3 | Targeted retry | 24.717 s | 24.714 s | 8.573 s | 16.097 s | 1,644 / 184 |
| 4 | Targeted retry | 24.857 s | 24.854 s | 8.985 s | 15.856 s | 1,726 / 177 |
| 5 | Semantic distinctness review | 3.891 s | 3.891 s | 3.491 s | 0.357 s | 355 / 6 |

The fifth inference had no generation-response callback because it is the
stack's separate semantic duplicate review, not an untracked generation retry.
Investigator matched its short request and response to
`reviewQuizDistinctness`; it must remain enabled. The primary call was
prefill-heavy, while weak-area recovery was decode-heavy. The latter is a
plausible cost center, but this single successful sample does not justify
shortening or skipping it.

The only captured validation category was `insufficient_source` on the primary
attempt. `responseCategoryCounts` contained `other: 9`, which is an
unclassified diagnostic bucket, not evidence of quality failure or success for
those candidates. Investigator found that `candidate_pool_exhausted` is thrown
with numeric `filterStats`, but the final recovery callback in the #665 source
omits `error.details`; this explains why the earlier failed run has no rejection
counts. The exact candidate rejection cause remains unknown.

Investigator, Performance Engineer, and AI Quality independently reviewed the
run. AI Quality confirmed the five-question result passed the fixture's
grounding, uniqueness, and prior-question checks; this does not generalize to
natural notes or verify answer-grading quality. All three recommended no Qwen
behavior change from this evidence. No optimization cycle was completed.

**Next action:** if follow-up work is authorized, first add a nonbehavioral,
unit-tested path to expose only bounded `filterStats` on terminal
`candidate_pool_exhausted`, and improve the diagnostic mapping so `other` is
not mistaken for a specific rejection. Do not rerun Qwen under this one-run
diagnostic allowance. Consider a behavior optimization only after the rejection
cause is understood and a comparable validation budget is authorized.

## Evidence links

- PR #664: https://github.com/HamedGithubforwork/QuizForge-AI/pull/664
- PR #664 full acceptance run: https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/41733439968
- PR #665: https://github.com/HamedGithubforwork/QuizForge-AI/pull/665
- PR #666: https://github.com/HamedGithubforwork/QuizForge-AI/pull/666
- Diagnostic-first workflow PR #675: https://github.com/HamedGithubforwork/QuizForge-AI/pull/675
- Main-available diagnostic infrastructure PR #676: https://github.com/HamedGithubforwork/QuizForge-AI/pull/676
- Targeted diagnostic run: https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/42046508800

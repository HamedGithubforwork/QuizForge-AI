# Local AI optimization protocol

## Purpose

Improve Local Qwen speed, reliability, CPU and memory use while preserving
source grounding, question uniqueness, grading accuracy, security checks, and
generation reliability. A pilot may complete up to three implementation
cycles. Do not make a change only to finish a cycle.

## Evidence-first sequence

1. Coordinator selects the latest safe development branch and checks open PRs,
   recent benchmark artifacts, test outcomes, and in-progress work. Reuse
   existing GitHub Actions evidence first; do not reproduce a failure that an
   artifact or log already explains.
2. Investigator, Performance Engineer, and AI Quality independently review
   relevant evidence before a quality-sensitive optimization. Keep their
   findings distinct until the Coordinator reconciles them.
3. If an implementation opportunity is already supported by comparable
   measurements, record its baseline and proceed to an implementation cycle.
   If evidence is insufficient, the Coordinator may authorize **one** bounded
   Windows x64 diagnostic model run before any proposed improvement. The
   diagnostic must state one concrete uncertainty, the fixture and conditions,
   numeric measurements it will collect, quality oracle, artifact contents,
   timeout, and why existing evidence cannot answer the question.
4. A diagnostic run is measurement work, not an optimization cycle. It does
   not count as a code improvement, cannot relax a validator, and must not
   launch a full model-comparison matrix. Prefer a single synthetic fixture,
   cached SHA-verified model/runtime, hosted Windows x64, and a hard 25-minute
   timeout. The diagnostic may be run at most once before the first proposed
   code change. Do not rerun it merely because the result is noisy; record the
   limitation and choose a safe next step or stop.
5. Persist diagnostics as numeric, allowlisted metadata only: fixture ID,
   platform/model/hardware, per-call and per-stage timing, prompt/completion
   token counts and prefill/decode timings when the runtime exposes them,
   aggregate validator-category counts, pass/fail outcome, and a bounded error
   code. Never persist source notes, prompts, model responses, questions,
   source facts, rejected candidate text, or user data.
6. Before every implementation cycle, record the comparable baseline, quality
   oracle, relevant tests, and a resource budget. Developer implements one
   focused, non-overlapping change. Run inexpensive deterministic checks first.
7. Reviewer, QA, and AI Quality independently assess the result. Run the
   smallest relevant real-model acceptance only when needed to establish
   comparable performance and quality. Do not run full model-comparison
   matrices unless separately justified and approved.
8. Compare before/after results under equivalent fixture, model, runtime,
   acceleration, and host conditions. Keep a change only if relevant tests
   pass, quality is preserved, and the measured benefit exceeds known noise.
   Revert or reject changes that fail a gate or lack credible benefit.
9. Continue automatically through at most three implementation cycles while a
   measurable, safe, distinct opportunity remains. Stop when no justified next
   step exists, two consecutive cycles do not improve meaningfully, a safety or
   correctness regression cannot be fixed, required tools are unavailable, or
   a resource/approval boundary is reached.

## Resource and safety limits

- Maximum three concurrent subagents.
- No more than one pre-change Windows x64 diagnostic run per pilot.
- No paid infrastructure, production deployment, automatic merge, or
  protection bypass.
- Reuse existing Actions artifacts, model caches, and local deterministic
  tests. Avoid duplicate builds, large artifacts, and unnecessary workflows.
- Preserve all source-grounding, uniqueness, answer-grading, security, and
  reliability validators.
- Do not duplicate an open PR's implementation; inspect its diff and either
  build on it, identify a distinct gap, or stop.

## Persistent record requirements

Update `PROGRESS.md` after each investigation, diagnostic, implementation
cycle, rejected attempt, blocker, or decision to stop. Each record states the
branch/commit, evidence source, test command and outcome, exact measurements
and conditions, quality/reliability result, specialists involved, kept or
rejected decision, and the next action. Separate diagnostic measurements from
completed implementation cycles. Never describe an attempted or inconclusive
measurement as a completed optimization.

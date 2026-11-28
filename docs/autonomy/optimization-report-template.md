# Optimization cycle report

## Scope and checkpoint

- Pilot ID:
- Cycle:
- Branch and commit:
- Task and domain:
- Metric name and direction:
- Baseline value and evidence:
- Result value and evidence:

## Verification

- Focused tests and result:
- Reviewer: actual agent task/thread reference, target commit SHA, completion state, assessment, output/evidence references:
- QA: actual agent task/thread reference, target commit SHA, completion state, assessment, output/evidence references:
- Quality: actual agent task/thread reference, target commit SHA, completion state, assessment, output/evidence references:
- Security: actual agent task/thread reference, target commit SHA, completion state, assessment, output/evidence references:
- Review findings (ID, specialist, severity, location, impact, status, resolution evidence):
- Performance interpretation:
- Regression check:

Keep the invocation trace distinct from the assessment/checkpoint fields. A
role marked passed without a completed invocation and output reference is
pending. Do not claim specialist sign-off based only on a PR description or
checkpoint assertion.

## Backlog status counts

- Actionable:
- Awaiting approval:
- Blocked (include blocker and evidence):
- Completed:
- Rejected (include reason and evidence):

## Exhaustion audit

- Audited all required dimensions: performance, memory, CPU, code quality,
  security, reliability, backend, Local AI, quiz generation, grading, frontend
  UX, desktop UX, tests, and GitHub Actions efficiency.
- Evidence-backed independent findings from Reviewer, QA, Security/Privacy,
  AI Quality, Performance Efficiency, UI/UX, Release Reliability, and Data
  Integrity:
- Consecutive complete clean audit count:
- Persisted audit IDs and evidence references:
- Credible specialist improvement assessment:
- Gate state: `ACTIVE` / `BLOCKED` / `STOPPED` / `OPTIMIZATION_EXHAUSTED`
- Stop or blocker reason, if any (`budget`, `security`, `correctness`, `approval`):

## Restart criteria

List the new evidence, actionable task, specialist assessment, or required
approval that permits work to resume. Do not restart a blocked investigation
without distinct evidence. Do not restart after a budget or security stop
without the appropriate authorization and a safe revised scope.

For any approval or STOPPED-gate release, record the verified approver
identities and roles, approval evidence references, authorized scope reference,
and exact reviewed commit SHA. State that the Coordinator verified authority
and evidence contents externally; the CLI only stores the attestation and does
not authenticate it.


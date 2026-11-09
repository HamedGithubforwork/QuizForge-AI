# Supervised autonomous merge protocol

The repository remains in **Manual** merge mode by default. Existing
repository/PR/head/base-specific approval remains required in Manual mode.
`fully_autonomous` is reserved for future work and is rejected by the
orchestrator.

This document covers only the bounded pilot-scoped supervised mode. A separate
standing low-risk policy is specified in
`docs/autonomy/automatic-merge-policy.md`; it has its own explicit activation
boundary, defaults disabled, and does not authorize the PR that implements it.
Do not treat authorization for a bounded pilot or approval to merge the policy
implementation as activation of that standing policy.

## Run scope

Supervised mode can be enabled only when the Coordinator starts one prepared
pilot with a machine-readable authorization bound to its exact repository,
pilot/run ID, objectives, low-risk change categories, maximum selected tasks,
cycle limit, resource budget, evidence reference, authorizing identity, start
time, expiry, policy version and digest, and revocation state. The current
policy allows at most ten selected tasks and ten cycles, a run duration of at
most seven days, at most 30 CI runs, at most 240 local benchmark minutes, and
zero paid workflow runs. Each candidate requires a cumulative usage snapshot
with evidence; missing, unverifiable, decreasing, paid, or over-budget usage
fails closed. The authorization is stored in the version-controlled
checkpoint and must not be edited mid-run. Each candidate must match an
authorized objective and category and pass the current policy digest.

Authorization never applies retroactively to PRs that existed before the run
started. Existing integration PRs #695, #690, #691, #692, and #694 remain on
the Manual, PR-specific approval path; do not automatically merge them using a
new optimization-run authorization.

The CLI records a Coordinator-verified claim. It does **not** authenticate the
user, verify the source of approval, fetch GitHub state, or perform a merge.
Evidence URLs and review/check/protection claims are also recorded claims. The
Merge Manager must independently fetch and verify all live GitHub evidence
before it uses a GitHub mutation tool. Never treat checkpoint contents as
external proof.

The valid run removes only the repeated per-PR approval prompt for a candidate
that passes every supervised eligibility check. It does not waive normal
checks, reviews, protections, side-effect checks, or the immediate pre-merge
checklist. An active task may finish after the authorized distinct-task
selection cap is consumed, but no additional task may be selected. A candidate
that is high risk, uncertain, out of scope, or has missing/stale evidence is
rejected and remains on the normal manual route. Authentication or
authorization, secrets/security, database/user data, AWS/cloud spend, CI or
branch protections, agent permissions, merge policy, deployment, destructive
changes, and unexpected side effects are always excluded, even if their
label/title/path appears low-risk. Labels, titles, paths, or an asserted empty
risk list cannot qualify a candidate; the exact final diff hash and PR files
view are required, and the Merge Manager must independently inspect that same
diff.

## Start, monitor, stop, and revoke

Commands below operate only on the chosen checkpoint. Use a disposable state
file for rehearsal. `--state` may be placed anywhere after the command.

```powershell
node scripts/autonomy/optimization-orchestrator.cjs prepare-pilot pilot-example
node scripts/autonomy/optimization-orchestrator.cjs start-pilot '{"pilotId":"pilot-example","maxCycles":10,"approverIdentity":"coordinator@example.com","approvalEvidenceRef":"https://github.com/OWNER/REPO/pull/123","mergeMode":"supervised_autonomous","mergeAuthorization":{...}}'
node scripts/autonomy/optimization-orchestrator.cjs status
node scripts/autonomy/optimization-orchestrator.cjs revoke-supervised-merges https://github.com/OWNER/REPO/issues/456
```

To stop the current run, stop/interrupt the Coordinator session. The active
task and checkpoint remain recoverable within the original, unexpired run
scope; resuming does not create new authorization or expand that scope. Use
`revoke-supervised-merges` when no further automatic merges are authorized for
this run, even if ordinary in-scope work may continue.

`start-pilot` requires the exact prepared pilot ID and limit. The authorization
JSON must include all fields from `validateRunAuthorization` in
`scripts/autonomy/supervised-merge-policy.cjs`, including the current exported
`POLICY_VERSION` and `POLICY_DIGEST`. `status` reports current mode, scope, and
append-only decisions. `revoke-supervised-merges` immediately stops further
supervised merge eligibility for the active run. It requires an allowlisted
repository evidence reference and persists the revocation in the same
checkpoint. Revoking merge authority does not stop ordinary investigation or
implementation within the run's remaining scope.

## Candidate decision and result audit

After a task has passing implementation, focused tests, Reviewer, QA,
quality, and security records, the Coordinator may record the full exact-PR
evidence object:

```powershell
node scripts/autonomy/optimization-orchestrator.cjs record-supervised-merge '{"taskId":"task-id","repository":"OWNER/REPO","prNumber":123,...}'
```

Every candidate needs an exact PR head/base, SHA-256 and final-diff reference,
impact evidence, passing exact-head Reviewer/QA and applicable specialist
assessments, successful PR-associated `Required PR gate`, no blocking reviews,
current verified protections/ruleset, no excluded side effects, and a passing
Merge Manager decision proving independent inspection of the same diff hash.
Include `resourceUsage` as a cumulative, evidence-backed snapshot with
`ciRunsUsed`, `localBenchmarkMinutesUsed`, `paidWorkflowRuns`, and `evidenceRef`.
Counters must be nondecreasing across decisions in the run. Missing or
unverifiable usage, a decreasing counter, any paid workflow run, or exceeding
the authorized budget rejects the candidate and fails closed for supervised
merging.
Rejected decisions are still recorded and do not prevent the Coordinator from
continuing to another independent task.

Only after the Merge Manager actually performs the specifically scoped GitHub
merge and receives its response may the Coordinator record it:

```powershell
node scripts/autonomy/optimization-orchestrator.cjs record-supervised-merge-result '{"taskId":"task-id","prNumber":123,"headSha":"<40 hex>","baseSha":"<40 hex>","githubResponse":{"merged":true,"number":123,"headSha":"<40 hex>","baseSha":"<40 hex>","mergeCommitSha":"<40 hex>","mergedAt":"<ISO timestamp>","message":"<GitHub response message>"}}'
```

The result must match a prior eligible decision in this run and a structured
response with `merged: true`; a standalone SHA or URL never records a merge.
This local schema still cannot authenticate that a supplied response came
from GitHub, so the Manager must retain and independently verify the real API
response before recording it. The checkpoint library never calls GitHub.

Any missing or ambiguous authorization, changed policy digest, stale PR head
or base, unsuccessful/missing Required PR gate, unavailable protections,
unresolved material review, or side effect stops the merge path. Use Manual
mode for that PR and obtain the existing explicit repo/PR/head/base approval.
Do not merge, deploy, spend, or bypass branch protections through this protocol.

# QuizForge optimization loop

The Coordinator owns task discovery and assignment. The persistent structured
backlog and resume checkpoint live in `optimization-state.json`; the
`scripts/autonomy/optimization-orchestrator.cjs` command-line tool validates
that state, selects the highest-value actionable task, records lifecycle
events, and moves immediately to an independent task after a blocker.

## Safety boundary

The orchestrator is a state manager. It does not execute commands listed in
tasks, interpret issue/PR/model text as instructions, call models, write to
GitHub, commit, merge, deploy, provision paid resources, or delete resources.
Only sanitized task metadata, numeric measurements, allowlisted role results,
agent invocation references, and evidence references belong in the state file.
Store no notes, prompts, responses, PDFs, secrets, or user study data.

Every newly prepared pilot has a ten-cycle cap. Selecting a task consumes one
cycle, including a task that is later blocked. A task must have a numeric baseline,
focused test evidence, independent Reviewer and QA passes, quality and security
passes, a local benchmark result, and a dedicated `codex/` branch commit before
it can be validated. Expensive benchmarks are recorded as blockers and cause
selection of another actionable task. Blocked tasks are excluded until new,
distinct evidence is recorded.

Each new Reviewer, QA, Quality, and Security assessment records an
`invocationRef`, output `artifactRef`, and exact `targetCommitSha`; the
orchestrator requires the assessment SHA to match the implementation commit
and stores the invocation trace separately in task assessments and event
history. The Coordinator must verify that the referenced agent task actually
ran. The orchestrator only validates the reference shape and commit binding;
it does not authenticate agent invocations. Keep unresolved material review
findings in the cycle report and do not record a pass while one remains open.

Schema-v1 checkpoints migrate without fabricated invocation IDs. Previously
validated tasks remain explicitly marked as legacy/unverified history. Tasks
saved mid-review return to `tests_passed` with old role attestations cleared;
their prior event records are retained and fresh commit-bound reviews are
required. Blocked and rejected tasks preserve their blocker/rejection records
and matching lifecycle snapshots.

## CLI

Run `node scripts/autonomy/optimization-orchestrator.cjs status` to inspect the
backlog. Use `prepare-pilot [unique-id]` to create a pending ten-cycle pilot.
Preparation only records its ID and budget; it does not change the current gate,
select a task, consume a cycle, or start work. Preparation is available only
for a fresh checkpoint with no pilot history, after the prior pilot stopped at
its cycle budget, or after an independently recorded actionable task reopened
a previously exhausted gate. `start-pilot
'<json-attestation>'` is the explicit transition that archives the prior pilot
and activates the pending pilot. The attestation must include the exact pending
`pilotId`, its `maxCycles`, `approverIdentity`, and an allowlisted
`approvalEvidenceRef`. The transition stores that claim; it does not authenticate
the approver or independently verify the evidence. A pending pilot is never
started implicitly. Use `begin` when no pilot is pending,
`resume` to continue the selected checkpoint or select the next task, and
`new-cycle` after a terminal task.

Before blocking a selected task, record an Investigator diagnosis with
`diagnose-recovery <task-id> '<json>'`. The diagnosis contains an allowlisted
root-cause code, an exact allowlisted original check, evidence references, an
allowlisted blocker class, and whether recovery is safely supported. No raw
diagnosis prose or rationale is stored. A non-recoverable diagnosis needs an
allowlisted reason code and immediately records the blocker and selects
independent work. A recoverable diagnosis permits at most two attempts, each
with a different fixed allowlisted strategy identifier and distinct evidence
references, via `recovery-attempt <task-id> '<json>'`. Each attempt records
evidence and the verification result for the same original check. The
orchestrator records the Coordinator's claim; it does not run or independently
verify that check. The Coordinator must run the original check and confirm its
result before recording an attempt. A passing check resumes the same task with
its prior baseline and implementation intact; two distinct failed attempts
block the task and select independent work. Strategy identifiers must differ
within a case, and diagnosis, attempt, and verification references must remain
unique across the task's complete recovery history. A later case may repeat a
strategy only with a new diagnosis and entirely new evidence. Task text and
strategy identifiers are never executed as shell commands, model prompts, or
workflow instructions. `block <task-id>
<allowlisted-code> [evidence-reference]`
is permitted only after the diagnosis and recovery policy are complete.
`evidence <task-id> <new-reference>` reopens a blocked task only after distinct
evidence arrives. `--state <path>` selects an isolated state file for
deterministic tests or a separately managed pilot.
`approve <task-id> <json-attestation>` releases a task in
`awaiting_approval` only after an allowlisted JSON attestation is supplied.
The attestation records `approverIdentity`, `approverRole`,
`approvalEvidenceRef`, `authorizedScopeRef`, and the exact 40-character
`scopeCommitSha`. `release-stop '<json>'` releases only a security/correctness
stop and records `remediationEvidenceRef`, `authorizedScopeRef`,
`scopeCommitSha`, and distinct Reviewer, QA, and Security approval objects
(`role`, `identity`, `evidenceRef`); correctness stops also require AI Quality.
The Coordinator must independently verify the approver's authority, evidence
contents, and exact scope before attesting. The CLI stores these assertions; it
does not authenticate identities, inspect external evidence, or verify Git
commits.

The exhaustion gate requires two consecutive complete repo-wide audits before it
sets `OPTIMIZATION_EXHAUSTED`. Each audit must explicitly cover performance,
memory, CPU, code quality, security, reliability, Local AI, quiz generation,
backend, grading, frontend UX, desktop UX, tests, and GitHub Actions
efficiency. Missing any category invalidates the audit. Each audit also needs
one evidence-backed finding from each of these independent roles: Reviewer,
QA, Security/Privacy, AI Quality, Performance Efficiency, UI/UX, Release
Reliability, and Data Integrity. Missing specialist evidence or a specialist
finding marked `blocked` keeps the gate `BLOCKED`. A temporary blocker sets
`BLOCKED`, never exhausted. New actionable work or a credible specialist
improvement assessment reopens the gate. `STOPPED` is sticky across ordinary
audits. A budget stop can be cleared only by starting a new explicitly bounded
pilot. Security/correctness stops require the explicit `release-stop` evidence
transition; audit input cannot release them. Missing approval sets `BLOCKED`
with an approval reason. Audit counts are derived from the persisted backlog,
not caller input.
Use `audit '<json>'` with a unique `auditId`, complete `auditedDimensions`,
`evidenceRefs`, and `specialistAssessments` metadata; the CLI rejects repeated
IDs or incomplete role/category sets. Each audit is preserved with its full
evidence in the checkpoint. Improvement findings require a different role's
`improvement_confirmed` finding with `confirmsRole` pointing to the original
role. A later audit that discovers actionable work restores `ACTIVE` and task
selection. Adding ready work or receiving distinct blocker evidence also
reopens an exhausted gate.

Use [the optimization report template](optimization-report-template.md) for
cycle evidence, final statuses, and restart criteria.

The Coordinator still performs code discovery, implementation, test selection,
specialist delegation, interpretation of results, and branch creation. The
state file is the durable handoff, not permission to automate those external
actions.

## Checkpoint integrity and lock recovery

State files are validated against their lifecycle before they can be resumed.
Validated records must contain baseline and implementation evidence, passing
tests, Reviewer and QA approval, quality and security approval, and a measured
improvement in the task's declared metric direction. Older task entries that
omit `metricName` are read with the task ID as their metric name.
Legacy `task_discovered` events without `initialStatus` are treated as ready;
new discoveries persist their initial status. A task discovered as
`awaiting_approval` cannot move to ready or another stage unless a later,
structured `approval_recorded` event is present and valid.

Every state update holds an exclusive lock while comparing the checkpoint
revision read from disk with the writer's revision. A stale writer fails rather
than overwriting newer work; successful writes increment the revision. Pilot
starts move the prior bounded summary and all prior events into append-only
archives, and event archives rotate in bounded chunks so the active log does
not become a permanent 500-event dead end. Lifecycle events carry pilot
attribution, including pilot preparation and start transitions.

The writer uses an exclusive lock. It can recover a same-host lock only when
the recorded process is proven absent. It may recover a malformed lock only
after it has been unchanged for at least 24 hours; live, foreign-host, recent,
or ambiguous locks stop the write. Recovery itself uses an exclusive guard and
rechecks lock identity before unlinking it. If a process crashes while holding
the `.lock.recovery` guard, the tool deliberately refuses automatic recovery.
An operator must verify that no orchestrator is active, inspect the lock and
checkpoint, then remove only the abandoned guard file before retrying. Never
remove an active `.lock` or recovery guard based only on age.


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
and evidence references belong in the state file. Store no notes, prompts,
responses, PDFs, secrets, or user study data.

Every pilot is capped at ten cycles. A task must have a numeric baseline,
focused test evidence, independent Reviewer and QA passes, quality and security
passes, a local benchmark result, and a dedicated `codex/` branch commit before
it can be validated. Expensive benchmarks are recorded as blockers and cause
selection of another actionable task. Blocked tasks are excluded until new,
distinct evidence is recorded.

## CLI

Run `node scripts/autonomy/optimization-orchestrator.cjs status` to inspect the
backlog. Use `begin` for a new bounded pilot, `resume` to continue the selected
checkpoint or select the next task, and `new-cycle` after a terminal task.
`block <task-id> <allowlisted-code> [evidence-reference]` records the blocker
and returns the next independent task in the same transaction. `evidence
<task-id> <new-reference>` reopens a blocked task only after distinct evidence
arrives. `--state <path>` selects an isolated state file for deterministic
tests or a separately managed pilot.
`approve <task-id> <evidence-reference>` releases a task in
`awaiting_approval` only after an allowlisted approval reference is supplied;
it does not create approval automatically. `release-stop '<json>'` releases
only a security/correctness stop and requires distinct remediation evidence,
safe-scope review, Reviewer and QA evidence, Security evidence, and AI Quality
evidence for correctness stops.

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

The writer uses an exclusive lock. It can recover a same-host lock only when
the recorded process is proven absent. It may recover a malformed lock only
after it has been unchanged for at least 24 hours; live, foreign-host, recent,
or ambiguous locks stop the write. Recovery itself uses an exclusive guard and
rechecks lock identity before unlinking it. If a process crashes while holding
the `.lock.recovery` guard, the tool deliberately refuses automatic recovery.
An operator must verify that no orchestrator is active, inspect the lock and
checkpoint, then remove only the abandoned guard file before retrying. Never
remove an active `.lock` or recovery guard based only on age.


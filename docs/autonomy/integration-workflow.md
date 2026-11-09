# Durable integration workflow

`integration-coordinator.cjs` is a small state machine for Coordinator-led,
multi-task repository objectives such as reconciling dependent pull requests.
It stores a versioned checkpoint, selects the next eligible task after a task
completes or blocks, and can be resumed in a later Codex session. The module
does not call agents, run commands, inspect GitHub, push commits, merge, deploy,
or infer permission. The Coordinator performs those actions only when already
authorized and records the resulting evidence.

## Continuation behavior

Create the workflow with a unique objective ID, an explicit selection budget,
and the known task/dependency graph. Keep task IDs stable between sessions.
Ordinary tasks begin `ready`; merge tasks begin `awaiting_approval`. A task is
eligible only when it is ready and every dependency is completed. Priority
breaks ties deterministically by task ID. Completing or blocking a task picks
the next eligible task as part of the same state transition, so the Coordinator
can continue within the active session without another user prompt. A blocked
task is preserved and does not stop unrelated ready work.

After every meaningful transition, save the checkpoint to
`docs/autonomy/integration-checkpoint.json` with `saveCheckpoint`. The writer
uses an exclusive lock, an atomic rename, and a revision check; stale writers
fail closed. For completion, blocker, approval, retry, and PR-scope transitions,
prefer `transitionAndSave`: it applies one allowlisted transition to a copy,
persists completion and the automatically selected next task atomically, and
returns that next task only after the checkpoint write succeeds. Commit the
checkpoint together with any code changes whose state must survive GitHub-based
handoffs. Keep evidence in sanitized references and do not put prompts, model
responses, secrets, or private user data in it.

The current checkpoint records PR 678 as merged, PR 695 reconciliation and
PR 698 review as completed with their recorded Actions-run evidence and result
commits, and the dependency chain PR 690 → PR 691 → PRs 692 and 694. PR 698 is
independent of PR 695. Each open PR has a separate merge task that remains
`awaiting_approval`; all six merge tasks currently have no stored approval.
Completing a review or reconciliation task alone never unlocks the next stack
level. The recorded PR 695 reconciliation result is commit
`176fc7961781d622519597a4c8268b33d40d4514`; PR 698 review result is
`6add3dac88d211f5bdc127bd8c1a1ea7c4a3d845`. The refreshed merge scopes record
those heads against the current `main` SHA
`46f3412f673b0522cc1dfce2769e7e8d7d9d6aff`. These are checkpoint snapshots,
not substitutes for re-fetching live PR state before resuming or seeking
approval.

Completed review tasks intentionally retain the PR metadata snapshot from
when each evaluation began: PR 695 head `2e58e03cdf8e48a2025b307f696c359e3dad2d3d`
and PR 698 head `e36eed8e453fd724557224353e2e7470184efbb0`. Their result
commits and Actions-run evidence are recorded separately. The corresponding
merge tasks contain the later refreshed heads (`176fc7961781d622519597a4c8268b33d40d4514`
and `6add3dac88d211f5bdc127bd8c1a1ea7c4a3d845`). Treat completed-task PR
objects as historical evaluation snapshots; use the merge-task scope only as a
checkpointed reference, and still refresh live GitHub state before approval or
merge.

PR 698's Required PR run `42563047575` is recorded as attached to head
`f955` (abbreviated here), but it ran against `main` before PR 695's
workflow-policy changes landed. Therefore,
that run did not exercise the unconditional CI trigger-policy job introduced
by PR 695 and is insufficient for readiness after the CI policy changes.
Integrate PR 695 first. Once it is on `main`, refresh PR 698 against the
updated target and obtain a new Required PR gate on PR 698's exact current head,
confirming that workflow-policy tests ran and succeeded before readiness or
approval.

The checkpoint retains PR 695's earlier API base report
`aad0afeda769a6715f2ba8351294b61839ff5fe6` as historical metadata and records
`46f3412f673b0522cc1dfce2769e7e8d7d9d6aff` as the canonical target SHA from the
live `main` branch used during scope refresh. The earlier mismatch is evidence
history, not proof of current mergeability. The refreshed scope records the
reconciliation result head, but approval is still absent. Re-fetch the PR,
target branch, checks, reviews, protections, and mergeability before any
readiness decision or merge.

At checkpoint revision 9 the workflow is `blocked` with stop reason
`no_actionable_task`: PR 695 and PR 698 review work is complete, while their
merge tasks await explicit approval. PR 690 and later stack tasks cannot be
selected until their predecessor merge is actually recorded as completed.
This is an approval/dependency stop, not global completion. No approval is
stored for any outstanding PR.

## Vercel deployment review 2026-11-09

PR 695 remains open at approved head
`176fc7961781d622519597a4c8268b33d40d4514`, targeting `main` at
`46f3412f673b0522cc1dfce2769e7e8d7d9d6aff`; GitHub currently reports it ready
for review (`draft: false`) and mergeable. Its exact-head Required PR run
`42561665578` passed.

The repository has `frontend/vercel.json` with
`git.deploymentEnabled: false`, added by commit
`8780505c7b25128a438961dad769183aeb1b1e78`. The Vercel API confirms the
project is linked but does not expose its Root Directory or effective Git
deployment settings. Therefore the committed setting's applicability is not
verified, and a merge must remain blocked until an authenticated administrator
confirms the project root, Production Branch, automatic deployments, Ignored
Build Step, and deploy hooks/callers. Missing recent production deployments
are not proof that auto-deploy is disabled. The former Vercel/Render canary
workflows are absent; the remaining opt-in test now requires explicitly
configured trusted HTTPS endpoints. The active AWS production canary remains
unchanged. A separate local Vercel-retirement branch contains the focused
code/doc cleanup; its publication remains on hold until the live Vercel
settings are verified.

This is a metadata refresh only: PR #695's repository, number, target, base
SHA, and head SHA are unchanged. The checkpoint keeps the merge task
`awaiting_approval` with no recorded approval, emits no merge-authorization
event, and leaves the overall workflow blocked.

On session resume, load the checkpoint, independently re-fetch live PR heads,
bases, checks, reviews, conflicts, protections, and side effects, then call
`begin`. If a PR's approved head or target changed, its old authorization no
longer matches. Pass the verified scope to `refreshMergeScope`; this clears the
old approval, preserves it in the event history, returns the task to
`awaiting_approval`, and continues with independent work. Never infer current
GitHub state from saved evidence.

## Approval and stop rules

The coordinator never merges. It only allows a merge task to become selectable
after a recorded approval exactly matches repository, PR number, head SHA,
target branch, and action. Before any actual merge, the Merge Manager and
Coordinator must re-verify every live safeguard and exact-scope approval. A
missing approval leaves the merge task awaiting approval and the workflow
blocked only if no other eligible task exists.

Selection budgets are explicit and capped at 50. Task execution attempts are
capped at three (initial plus two evidence-distinct retries). A blocked task
can be retried only with new evidence, and a retry never reuses the same failure
evidence. Budget exhaustion is persisted as `budget_reached`; all terminal
tasks produce `completed`; no eligible work while blockers, approvals, or
dependencies remain produces `blocked`. These states are not interchangeable.

The checkpoint supports continuation only while a Coordinator session is
active or when a later session resumes it. It is not a background service and
does not claim to continue after Codex ends. The deterministic tests show that
the state machine selects and persists the next task; they do not demonstrate
an actual LLM Coordinator invocation or fresh-session agent execution. Resume
from the committed checkpoint instead of reconstructing completed work from
conversation memory.

## Transition sketch

```js
const workflow = createWorkflow({ objectiveId: 'integration-stack', maxSelections: 10, tasks })
await saveCheckpoint(DEFAULT_CHECKPOINT, workflow) // initialize once

// After verifying the result and storing a sanitized evidence reference:
const outcome = await transitionAndSave(DEFAULT_CHECKPOINT, workflow, {
  type: 'complete', taskId: workflow.selectedTaskId, payload: { evidenceRef },
})
// `outcome.task` is selected and committed in the checkpoint before it is returned.
```

Use the deterministic suite at `scripts/autonomy/test/integration-coordinator.test.cjs`
to verify automatic continuation, blocker fallback, scoped approval,
dependency reconsideration, checkpoint recovery, terminal completion, and
selection/retry limits.

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

The initial integration ledger in `integration-checkpoint.json` records PR 678
as merged, the current local PR 695 reconciliation as active and unpublished,
PR 698 as independent draft work, and the dependent chain PR 690 → PR 691 →
PRs 692 and 694. Each open PR has a separate merge task that remains
`awaiting_approval` until fresh exact-scope approval is recorded; completing a
review task alone never unlocks the next stack level. Pending merge tasks have
no stored approval. The checkpoint distinguishes PR 695's remote head from its
local candidate commit. Refresh these refs from GitHub before resuming; never
treat the initial snapshot as current after branches or PR states move.

The November 9 snapshot records PR 695 as non-mergeable. The pull-request API
reported base SHA `aad0afeda769a6715f2ba8351294b61839ff5fe6`, while the live
`main` branch resolved to `46f3412f673b0522cc1dfce2769e7e8d7d9d6aff`. The
checkpoint stores the live target SHA as canonical `baseSha` and preserves the
API value separately as `reportedBaseSha`; this discrepancy still requires a
fresh API/branch check before readiness or merge. Re-fetch the PR and branch
before any continuation that relies on its mergeability.

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

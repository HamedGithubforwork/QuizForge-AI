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

The current checkpoint is revision 14 and records PRs 678 and 695 as merged,
with exact user authorization, PR head/base, merge commit, and post-merge CI
evidence for #695. The Coordinator selected `pr-690-reconcile` immediately
after recording the #695 merge. The remaining integration chain is PR 690 →
PR 691 → PRs 692 and 694; PR 698 is independent of that stack. Unmerged PRs
remain separately approval-gated. The #690 reconciliation is active; the other
unmerged merge tasks remain `awaiting_approval`. Completing a review or
reconciliation task alone never unlocks a merge. Checkpoint scopes are
snapshots, not substitutes for re-fetching live PR state before resuming or
seeking approval.

Completed review tasks retain historical PR metadata from when those
evaluations began. PR #695's reconciliation result was head
`176fc7961781d622519597a4c8268b33d40d4514`, merged as
`4213fe2b7160bdc2e12c5e9661611544e251ae48`. PR #698's recorded review result
predates #695 and its current remote head is `25d21088b548411b3005d19f49cc382af8851658`;
its old review and Actions evidence are not current readiness proof. The #698
merge scope has been refreshed to the current main SHA and remote head, and
GitHub currently reports it non-mergeable. Reconcile its branch/base and obtain
a new exact-head Required PR gate before considering it ready.

PR 698's previously recorded Required PR runs predate PR 695's workflow-policy
changes. PR 695 is now on `main`, so #698 must be reconciled against the new
base, and its fresh exact-head Required PR gate must show the policy test
passing before readiness or approval.

The checkpoint retains earlier PR base reports as historical evidence. Current
`main` is `4213fe2b7160bdc2e12c5e9661611544e251ae48`. Re-fetch each PR, target
branch, checks, reviews, protections, and mergeability before any readiness
decision or merge.

At revision 14 the workflow is `active`, with `pr-690-reconcile` selected.
After that task is recorded, downstream merge tasks will remain gated by
separate, exact-scope approvals. This is an integration workflow, not a grant
of standing merge permission.

## PR 695 deployment and merge record — 2026-11-09

Before integration, the repository owner reported uninstalling the Vercel,
Render, and Cursor GitHub Apps and confirmed the repository has no webhooks.
The Render connection independently reported service `quizforge-ai-api` with
`autoDeploy: no` and `autoDeployTrigger: off`. GitHub workflow inspection found
no merge-triggered deploy workflow in the PR diff. The Vercel and repository
webhook settings were owner-confirmed rather than independently read through
the available GitHub API; no old Vercel account access was required. The
former Vercel/Render canary workflows are absent; the remaining opt-in test
requires explicitly configured trusted HTTPS endpoints. The active AWS
production canary was not modified. A separate local Vercel-retirement branch
contains the focused code/doc cleanup at local commit
`dd63e0404864b965c9ce49dc093242a4fc19c284` (branch
`codex/retire-vercel-canary-20261109`). It removes hardcoded legacy canary
hosts, requires a trusted exact-host allowlist, and disables canary traces,
screenshots, and video. Focused Playwright configuration tests passed 6/6 and
the canary discovery command listed one test without contacting an endpoint.
That branch remains local and was not part of PR #695.

PR #695's description was reconciled before merge to match its live
`draft: false` state and exact-head CI evidence; unsupported claims of
untraceable independent assessments were removed.

### PR 695 merge authorization 2026-11-09

The repository owner explicitly authorized merge of PR 695 at head
`176fc7961781d622519597a4c8268b33d40d4514` to `main`, then at base
`46f3412f673b0522cc1dfce2769e7e8d7d9d6aff`. This is a Coordinator
transcription of user-provided authorization, not a GitHub review or signed
approval record. Immediately before merge, GitHub reported the PR open,
non-draft, mergeable, exact head/base unchanged, `Required PR gate` passing,
and the active `Protect main` ruleset satisfied. GitHub merged PR #695 at
`https://github.com/HamedGithubforwork/QuizForge-AI/commit/4213fe2b7160bdc2e12c5e9661611544e251ae48`.

Post-merge Actions run
`https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/42689434199`
passed on that merge commit. It was the only workflow run observed for that
SHA: CI passed; the autonomy bridge was skipped. No deployment workflow ran.
The active integration checkpoint records the user authorization, merge SHA,
post-merge run, and immediate continuation to PR #690. This approval is only
for PR #695; every other PR remains unapproved for merge.

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

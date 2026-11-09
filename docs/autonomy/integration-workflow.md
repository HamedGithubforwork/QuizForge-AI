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

The current integration checkpoint is revision 23. It records PRs 678 and 695 as merged, including #695's exact user authorization, merge commit, and post-merge CI. After #695 merged, the Coordinator selected and completed `pr-690-reconcile` using the current PR head and exact-head Required PR gate. It then stopped with `blocked/no_actionable_task` because PR #690's merge still awaits explicit, PR-specific authorization. This is an approval boundary, not optimization exhaustion or a failed test. The checkpoint's standing automatic-merge policy is explicitly `disabled`, with no activation events. The policy implementation PR remains ineligible for its own policy.

The prepared dependency order is PR 690 → PR 691 → PRs 692 and 694; PR 698 is independent. The recorded PR scopes and gates below are a revision-22 snapshot, not current readiness evidence. In particular, PR #698's head/run entry predates its latest policy changes; obtain new exact-head CI after that candidate is published.

- PR #690: head `190f6d98ca59baedddf9e7242bb8c3e63de4ec38`, target `main` at `4213fe2b7160bdc2e12c5e9661611544e251ae48`, gate run [42692660221](https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/42692660221) passed.
- PR #691: head `baddbbc98c5a14bc14f664a01f2d79390e9d70c9`, target PR #690's branch at `190f6d98ca59baedddf9e7242bb8c3e63de4ec38`, gate run [42695584837](https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/42695584837) passed.
- PR #692: head `8dda007e79afe77dc77a5c186e6e16ab1fa1cc6b`, target PR #691's branch at `baddbbc98c5a14bc14f664a01f2d79390e9d70c9`, gate run [42697462238](https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/42697462238) passed.
- PR #694: head `03eb7c038c972fb49909019d846c02a69767b18f`, target PR #691's branch at `baddbbc98c5a14bc14f664a01f2d79390e9d70c9`, gate run [42698118455](https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/42698118455) passed.
- PR #698: head `ee9e6d2fd10f29f41ac255016358595a215d3a61`, target `main` at `4213fe2b7160bdc2e12c5e9661611544e251ae48`, gate run [42694126716](https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/42694126716) passed.

Every unmerged PR remains draft or unapproved in the checkpoint, with null merge authorization. Exact-head CI is not formal GitHub review. The current #691 branch merge is conflict-free; #692 preserves numeric grading, and #694 preserves recovery safeguards. The #698 candidate runs both autonomy suites when relevant and adds a dormant standing low-risk auto-merge policy; neither change becomes active on `main` until #698 is separately reviewed and manually integrated. Any later activation requires separate explicit owner authorization and a verified policy implementation merge SHA. PR #692 also triggered Lightsail validation-only and a local Docker image build; the release build and ECR push jobs were skipped, and no deployment or image publication occurred. Mutation runs for these PRs were skipped.

Checkpoint scopes are snapshots, not a substitute for re-fetching live PR state. Before any merge, re-check the current PR, base/head, exact required check association, formal review requirements, conflicts, rulesets, and side effects. Completing reconciliation never unlocks a merge. The current blocker is specific: explicit merge authorization for PR #690 at its exact current head/target is required to proceed with the dependency chain. No other PR is authorized for merge.

The checkpoint retains earlier PR base reports and events as historical evidence. Current `main` is `4213fe2b7160bdc2e12c5e9661611544e251ae48`. The workflow is `blocked` with `stopReason: no_actionable_task`; all remaining unmerged merge tasks remain `awaiting_approval`. It is not complete or exhausted. This workflow is not a grant of standing merge permission.
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
`176fc7961781d622519597a4c8268b33d40d4514` to `main`. The Coordinator
independently observed and bound the then-current base SHA
`46f3412f673b0522cc1dfce2769e7e8d7d9d6aff` in its exact-scope checkpoint;
that base SHA was not part of the user's authorization text. This is a
Coordinator transcription of user-provided authorization, not a GitHub review
or signed approval record. Immediately before merge, GitHub reported the PR open,
non-draft, mergeable, exact head/base unchanged, `Required PR gate` passing,
and the active `Protect main` ruleset satisfied. GitHub merged PR #695 at
`https://github.com/HamedGithubforwork/QuizForge-AI/commit/4213fe2b7160bdc2e12c5e9661611544e251ae48`.

Post-merge Actions run
`https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/42689434199`
passed on that merge commit. Observed run results were: CI succeeded and the
autonomy bridge was skipped. No deployment workflow ran.
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

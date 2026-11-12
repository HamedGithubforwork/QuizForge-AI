# Active-session live-verification procedure

The active Codex Coordinator and Merge Manager can use connected host tools to
read GitHub and launch real specialist subagents. Repository JavaScript cannot
invoke those tools or authenticate their results; no durable host-call or
cross-session invocation attestation is available. The policy evaluator
therefore continues to return `trusted_live_verification_unavailable` for
otherwise-valid candidates. This procedure supports read-only assessment only.
It does not authorize an automatic merge or replace the fail-closed evaluator.
There is no always-on runner. A checkpoint is an audit/continuation record,
not proof of GitHub state, specialist invocation, policy activation, or merge
authority.

The authenticated Windows GitHub CLI helper documented in
`docs/autonomy/supervised-merge.md` is only a supervised manual-preflight aid.
Its output is a local, time-scoped observation; repository JavaScript cannot
authenticate it, and it does not bind a later merge to an atomic target/base.
Never pass its output or a checkpoint copy into the policy evaluator as trusted
evidence. It cannot change `trusted_live_verification_unavailable`.

Automatic merging must remain blocked until a reviewed trusted provider is
integrated and the policy evaluator can accept its authenticated evidence. A
checkpoint activation claim or Manager host-tool access alone cannot override
the current blocked evaluator result. PR #698 is excluded from any policy it
enables. Manual merges remain subject to separate, exact PR/head/base
authorization.

## Candidate verification

1. The Coordinator may identify a candidate and give the Merge Manager its
   repository and PR number. That handoff is a locator only, not evidence or
   authorization. Do not treat a checkpoint eligibility field as a capability.
2. The Merge Manager independently calls connected GitHub tools to fetch the
   live PR, complete paginated changed-file list and patch, exact head/base
   commits, PR-associated Required PR gate and constituent job results,
   formal reviews and unresolved threads, repository rulesets/details and
   branch-protection evidence, and workflow/merge side effects. Confirm the PR
   is open, non-draft, targets `main`, mergeable, created after activation,
   and outside all high-risk exclusions. Missing, stale, conflicting, or
   inaccessible evidence blocks the candidate.
   Use `github_fetch_pr`, `github_list_pr_changed_filenames`,
   `github_fetch_pr_patch`, `read_pull_request_check_diagnostics`,
   `github_list_pull_request_reviews`, `github_list_pull_request_review_threads`,
   and `github_fetch` for the applicable ruleset endpoints. Paginate until the
   host tool confirms the full list/diff and request diagnostics for the exact
   head revision.
3. The Merge Manager cannot inspect the Coordinator's sibling subagent tree.
   It therefore originates fresh independent Reviewer, QA, Security, and
   applicable specialist assessments inside its own visible collaboration
   tree and checks the active collaboration-tool record for those invocations.
   Inspect actual completed invocation results and require each to name
   the exact current head and report no unresolved material finding. Never
   accept invocation IDs, checkpoint claims, or Coordinator summaries as
   proof. Keep concurrent subagents at three or fewer. If an actual invocation
   cannot be observed or authenticated, stop.
4. The Merge Manager reads the complete diff and classifies its full effects.
   Authentication/authorization, security, secrets, infrastructure, data
   migrations, billing/spending, deployments, CI or branch protections, agent
   permissions, merge safeguards, cloud spend, destructive effects, and uncertain risk
   always require human approval and are ineligible. Inspect actual workflow
   triggers and downstream effects; path-based guesses alone are insufficient.
5. Require passing exact-head Required PR CI, all formal review requirements,
   current effective protections, no conflicts, and no unresolved material
   findings. On strict `main` checks, a stacked PR must be based on the latest
   target and its checks must apply to that base/head. Merge dependency stacks
   bottom-up and re-run required CI when advancing a dependent branch.
6. The Merge Manager must also evaluate the candidate with the repository
   policy evaluator. If it returns `trusted_live_verification_unavailable`,
   stop. Do not bypass this result by directly calling the GitHub merge tool,
   even if all checklist fields or a checkpoint claim say `eligible`.

## Current merge-execution status

The GitHub connector exposes `github_merge_pull_request` with
`expected_head_sha`; that parameter guards the PR head only. It does not bind
the target branch name or expected base SHA. Strict required status checks
ensure an up-to-date topic branch for a PR targeting protected `main`, so a
main advance makes old checks inapplicable until the branch is updated. They
do not atomically prevent a concurrent retarget to an unprotected branch
between preflight and the merge request. The current ruleset has no merge
queue, and the workflows are not configured for `merge_group`. No currently
verified atomic target/base guard closes that race.

Because live host calls cannot be authenticated to repository code, the local
policy evaluator is fail-closed, the target ref cannot be atomically bound by
the available merge call, and a matching post-merge checkpoint transition
cannot prove that the merge occurred, **do not execute standing-policy
merges**. The connected GitHub tools have demonstrated live reads and actual
specialist invocations in an active session, but no production merge was
performed to demonstrate execution. A future complete implementation must
provide a verifiable host-to-policy boundary and a protected merge-queue or
equivalent atomic target guard, with corresponding `merge_group` checks and
independent review. Those changes require separate authorization.

There is no host-merge completion transition. The coordinator rejects
eligible/completed automatic-merge ledger claims while the trusted provider is
unavailable, and its `complete_auto_merge` transition is disabled. This is
not full checkpoint authenticity. Without a trusted GitHub verification
provider, pending merge-shaped tasks cannot be selected by the coordinator;
caller-provided approval fields remain audit claims. Merge-shaped completion
records do not satisfy dependencies or count toward workflow completion, even
when the checkpoint contains approval, merged status, a matching SHA, or a
completion event. Descendants of those tasks are also excluded. The records
remain for audit, and independent tasks can proceed. `completeTask` cannot
turn caller-supplied merge fields into trusted dependency completion.

A whole-checkpoint rewrite that removes all merge markers and changes the task
graph can hide the original merge relationship. The current code has no
authenticated canonical task manifest or host verifier to detect that attack.
After any separately authorized manual merge, the active Coordinator/Merge
Manager must still fetch GitHub directly and verify the actual merged PR,
original exact-scope approval, exact approved head and target, and merge commit
before relying on it. Repeat after handoff; otherwise block the dependency
chain. Automatic merging remains blocked until an authenticated host-to-policy
boundary and an atomic target guard are implemented and independently tested.

## Stacked PR verification

Strict required status checks require the topic branch to be up to date with
its target. For stacked PRs, use the actual stack trunk and current base/head
relationship shown by GitHub. Integrate dependencies bottom-up, then update
the next PR's base and re-run its Required PR gate where needed. Do not assume
that a prior green run remains applicable after a base change. Merge queue
verification is not used unless the active ruleset requires it and the current
workflows explicitly handle the `merge_group` event.

The policy remains disabled. Separate integration and activation approvals do
not make automatic merging operational until the trusted provider and atomic
target guard above are independently verified. No PR can activate the policy
through its own checkpoint or merge result.

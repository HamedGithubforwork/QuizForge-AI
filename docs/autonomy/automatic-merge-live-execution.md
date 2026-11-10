# Active-session automatic-merge procedure

This procedure is executed by the active Codex Coordinator and Merge Manager
using connected host tools. Repository JavaScript cannot invoke GitHub or
collaboration tools and does not authenticate their results. There is no
always-on runner. The checkpoint is a versioned audit/continuation record, not
proof of current GitHub state, specialist invocation, policy activation, or
merge authority. Only the authenticated live host-tool observations in the
active session can satisfy the operational merge gates; checkpoint payload
validation does not establish that those observations occurred.

Automatic merging remains disabled unless the owner separately activates the
integrated standing policy. PR #698 and every PR that existed before activation
are excluded. This document does not activate the policy or authorize a merge.

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
6. If all evidence passes and the standing policy is independently verified
   active, the Merge Manager immediately repeats the live PR, diff, check,
   review, protection, and side-effect reads. No checkpoint value substitutes
   for this final live read. If any relevant value changed, re-assess and obtain
   fresh specialist reports before proceeding.

## Merge and post-merge continuation

Only the Merge Manager may initiate an eligible merge. Call the connected
`github_merge_pull_request` tool directly with `expected_head_sha` equal to the immediately
re-fetched head. Use the permitted merge method and no bypass or auto-merge
option. A changed head, conflict, denied permission, unsuccessful response, or
ambiguous result stops the task; never retry around a failed safeguard.

After success, independently fetch the PR and returned commit. Confirm the PR
number, exact merged head, target, closed/merged state, merge timestamp and
merge SHA; call `github_fetch_commit` with that returned SHA and confirm the
commit object matches. Then the Coordinator
may call `record_host_merge_completion` to append the observed result, save and
reload the checkpoint, and continue to the next eligible task.

That checkpoint transition validates the shape and scope of a claimed
post-merge response and supports audit/continuation only. It cannot call GitHub,
authorize, initiate, retry, or authenticate a merge. A checkpoint loaded in a
later session is not evidence that the merge happened; re-fetch GitHub before
any decision that depends on the recorded result. Never synthesize missing tool
responses, specialist results, or commit evidence.

## Stacked PR verification

Strict required status checks require the topic branch to be up to date with
its target. For stacked PRs, use the actual stack trunk and current base/head
relationship shown by GitHub. Integrate dependencies bottom-up, then update
the next PR's base and re-run its Required PR gate where needed. Do not assume
that a prior green run remains applicable after a base change. Merge queue
verification is not used unless the active ruleset requires it and the current
workflows explicitly handle the `merge_group` event.

The active policy remains off until separate owner activation after manual
integration and validation. No PR can activate the policy through its own
checkpoint or merge result.

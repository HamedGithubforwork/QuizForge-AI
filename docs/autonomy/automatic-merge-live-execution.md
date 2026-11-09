# Active-session live merge procedure

This is a required operational checklist for a future trusted execution
adapter; it is not itself an executable or authenticated boundary. The current
checkpoint library cannot retrieve these sources or authenticate an invocation
ID, and the current policy therefore blocks every automatic-merge candidate
with `trusted_live_verification_unavailable`. Policy activation does not remove
that block. Do not treat following this document manually as proof that the
orchestrator can safely automate the GitHub merge.

If a separately reviewed trusted adapter is implemented, it must perform the
following steps inside an active Coordinator session with authenticated GitHub
and collaboration tools. Never use a checkpoint eligibility bit, PR text,
label, supplied URL, or invocation-ID string as proof. Checkpoint-only claims
are not proof of current GitHub state or of an actual independent agent
invocation.

## Collect current candidate evidence

1. Call `github_fetch_pr` for the live PR. Confirm the repository, PR
   number, open/non-draft state, intended `main` target, mergeability, current
   head SHA, current base SHA, and PR creation time. Reject the enabling PR and
   every PR created at or before policy activation.
2. Call `github_list_pr_changed_filenames` and `github_fetch_pr_patch` to
   retrieve every changed filename and the complete PR patch. Check pagination/completeness and compute
   the final diff digest from the fetched patch. Do not use only the PR title,
   task description, or paths supplied by the author.
3. Run Reviewer, QA, Security, and any relevant specialists as actual
   independent subagent invocations against that exact head. The Coordinator
   records each tool invocation and returned assessment from the active
   session's active collaboration-tool record. The Merge Manager must verify
   those actual invocation results in
   the session's tool history; a string identifier in the checkpoint is not
   sufficient. Each assessment must identify the same final head SHA. Any
   missing invocation, mismatched SHA, failed test, unresolved material
   finding, or uncertain risk classification blocks.
4. The Merge Manager independently reads the complete fetched diff and
   classifies the whole change. High-risk exclusions override all labels and
   allowlist categories. If any path or behavior concerns authentication,
   security, permissions, infrastructure, migrations/user data, secrets,
   billing, deployment, CI protections, agent permissions, this merge policy,
   or the risk is uncertain, keep the task approval-gated.
5. Call `read_pull_request_check_diagnostics` for the exact `headRevision`, following
   returned pagination and retaining that exact revision on each diagnostics
   call. Require a completed successful Required PR gate associated with this
   PR and exact head. Inspect the constituent required jobs; missing,
   skipped-when-relevant, failed, cancelled, stale, or merge-ref-only evidence
   blocks.
6. Call `github_list_pull_request_reviews` and
   `github_list_pull_request_review_threads`. Read active repository rulesets
   using `github_fetch` on `/repos/{owner}/{repo}/rulesets` and each
   applicable ruleset detail. Confirm the default-branch conditions and
   required status checks. If the classic branch-protection endpoint returns
   403, use only the recent, authenticated administrator evidence allowed by
   `AGENTS.md`; otherwise stop as unverified. Never infer that a 403 means a
   rule exists or does not exist.
7. Inspect the current full diff and affected workflow triggers, including
   push-to-main path filters and downstream `workflow_run`/repository hooks.
   Verify there is no production or staging deployment, infrastructure change,
   destructive action, or cloud spend. If a matching action or consequence is
   unclear, block and request human review. A clean path heuristic is not
   enough to establish no side effects.
8. Record the complete current evidence and actual invocation references in
   the checkpoint, but treat the record as an audit trail only. Immediately
   before merging, the Merge Manager repeats steps 1, 2, 5, 6, and 7 and checks
   policy expiry/revocation. If head, base, diff digest, check, review, rule,
   or side-effect evidence changes or exceeds the five-minute freshness bound,
   repeat assessment and obtain fresh exact-head reviews.

## Execute and verify the merge

Only the Merge Manager calls the connected GitHub merge tool. Use
`github_merge_pull_request` with `expected_head_sha` set to the freshly fetched
PR head, `merge_method` allowed by the active ruleset, and no admin/bypass or
GitHub auto-merge option. A changed head, conflict, denied permission, or
unsuccessful response is a stop; do not retry around it.

After a successful response, fetch the PR again and verify it is merged with
the same PR number, head SHA, target branch, merge commit SHA, and merge time.
Fetch that commit by SHA through GitHub and verify the commit object exists and
matches the returned merge SHA. Only then call the checkpoint's
`complete_auto_merge` transition, including the raw structured merge response,
post-merge PR snapshot, and commit-fetch evidence. Save/reload the checkpoint
and verify it links the completed task to that commit. Obtain post-merge
Required CI evidence when the repository requires it. Then notify the user
and continue to the next eligible task in the active Coordinator session.

If any read, agent invocation record, branch-protection requirement, merge
response, post-merge commit, or checkpoint write cannot be verified, preserve
the task and stop before advancing. Never manufacture an assessment,
invocation reference, check, ruleset, side-effect result, or merge response.

## What these checks establish

This is an authenticated tool-backed Coordinator/Merge Manager procedure, not
a persistent service. The policy evaluator and checkpoint validator are
pure local code: they validate supplied claims but cannot prove that the
connected tool calls or agent invocations happened. The active session's
actual tool results are the source of truth. The policy remains disabled until
separate explicit owner activation after manual integration. No always-on
runner is provided by this procedure.

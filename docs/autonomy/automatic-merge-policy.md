# Standing low-risk automatic merge policy

## State and activation boundary

The standing policy is **disabled by default**. This implementation PR and any
other change to the automatic-merge policy, agent permissions, CI protections,
or merge safeguards must be integrated through the existing Manual path. The
policy cannot approve, activate, or merge its own enabling changes. After the
implementation is merged and independently verified on `main`, activation
requires a separate, explicit repository-owner authorization for this exact
policy version/digest and `main`, recorded with its evidence and expiry. The
policy validator records authorization claims; it does not authenticate the
user or fetch GitHub state.

Only PRs created after the recorded activation time can be candidates. Existing
PRs, including #698 and the existing integration stack, remain on their
individual PR-approval path. A policy revision invalidates activation; it must
be reviewed and activated separately. The active policy expires after at most
90 days and can be revoked immediately with an auditable event.

## Eligible changes

The initial allowlist is limited to documentation, test coverage, low-risk UI
work, ordinary application bug fixes, and application performance changes.
Allowlist membership is only a starting point. The exact diff must be inspected
and independently classified as low risk by the Merge Manager. A title, path,
label, author statement, or empty risk list alone never establishes eligibility.

Never auto-merge changes involving authentication or authorization, security,
permissions, infrastructure, production deployment, database/schema or data
migrations, user data, secrets, billing, cloud spend, destructive effects,
CI/branch protections, agent permissions, the merge policy itself, unexpected
external effects, or any uncertain scope. These exclusions always override the
allowlist. A policy-related change remains excluded even if a component labels
it low risk.

## Required work for every candidate

The Coordinator runs the normal development sequence. The Developer
implements; Reviewer inspects the exact final diff; QA independently runs the
relevant tests; Security independently assesses the diff and risk; and the
Merge Manager performs the final independent review. The Merge Manager cannot
authenticate invocations in the Coordinator's sibling collaboration tree, so
it must originate fresh Reviewer, QA, Security, and applicable specialist
assessments in its own visible collaboration tree. It must inspect the actual
completed invocations and exact-head results, not checkpoint IDs or forwarded
claims. The Developer's published commit must equal the fetched PR head. Any
unresolved material finding, missing invocation/evidence, test failure, or
uncertain risk blocks.

Before a Merge Manager merge action, re-fetch the open, non-draft PR, target
`main`, exact head and current `main` SHA, complete diff, mergeability, formal
reviews, and current rulesets/protections. Verify a successful PR-associated
Required PR gate for the exact head and current base, successful exact-head
Reviewer, QA, and Security assessments, and absence of deployment, cloud-spend,
destructive, or other unexpected side effects. Re-evaluate policy expiry and
revocation. If head, base, target branch, policy digest, findings, protections,
or side effects changed—or evidence is older than five minutes—stop and repeat
the relevant verification. GitHub's `expected_head_sha` protects the PR head
only; it is not an atomic compare-and-swap for the base SHA or target branch.
Strict required checks protect an up-to-date `main` target from a stale-base
merge, but they do not atomically prevent a concurrent retarget to a branch
outside the ruleset. Do not claim the head guard alone closes either race.
Never bypass branch protection, use admin privileges, or enable GitHub
auto-merge.
The recorded side-effect assessment must include all merge-to-main workflow
triggers and explicitly show no deployment trigger, infrastructure mutation,
cloud spend, or destructive operation; missing or unknown trigger analysis
blocks eligibility.

Only the Merge Manager performs the normal GitHub merge after every gate passes.
The Coordinator verifies GitHub's response, merge commit, and post-merge CI,
records the result in the version-controlled integration checkpoint, notifies
the user, then proceeds to the next eligible task in the active session. High-
risk, blocked, and uncertain PRs are reported for human intervention; no
per-PR approval is requested for a candidate that passes the active policy.

## Runtime limitation

The current `quizforge-autonomy-bridge.yml` handles metadata, queue updates,
and a bounded CI retry; it does not start the Coordinator or specialist agents.
Therefore this policy is executable only while an authorized Coordinator
session is actively processing PRs. It does not provide an always-on or
24/7 background merge service. Do not claim continuous monitoring or future
merges after a Codex session ends. Adding a trusted background agent runner
would be a separate high-risk infrastructure and permission change requiring
explicit approval, threat review, and its own exact-head CI.

The current active-session Codex host exposes authenticated GitHub reads,
actual collaboration subagent invocations, and a GitHub merge operation with
an expected-head parameter. A Merge Manager can inspect its own active agent
tree; it cannot authenticate sibling invocations from the Coordinator's tree.
Those host observations are visible to the agent using the tools, but the
repository JavaScript evaluator cannot retrieve or authenticate them, and
there is no durable attestation that a later session can verify. The local
policy evaluator therefore fails closed with
`trusted_live_verification_unavailable` for every otherwise eligible
candidate. No active-session instruction or checkpoint field may override
that result. A read-only host review is possible; standing-policy merge
execution is not currently authorized or operational through the repository
orchestrator.

This fail-closed automatic path does not make the whole checkpoint ledger
authentic. While no trusted provider exists, fabricated eligible automatic
decision/completion records are rejected and `complete_auto_merge` is
unavailable. Manual approval and merge-completion fields remain caller-supplied
claims; the JavaScript scheduler can release dependents from a structurally
completed manual merge task. They are not proof of owner authorization or a
GitHub merge. Before any dependent work uses such a record, the active
Merge Manager must re-fetch GitHub and confirm the actual merged PR, exact
approved head, target, and merge commit, and verify the original approval in
the active conversation. Recheck after session handoffs; stop when either
source is unavailable. This procedural check is not authenticated by code and
does not make automatic merging operational.

The live `Protect main` ruleset (ID `21886458`, checked 2026-11-09) is active
for the default branch. Its required status checks rule names `Required PR
gate` (integration ID `15368`), has
`strict_required_status_checks_policy: true`, and has no bypass actors; the
connected API reported `current_user_can_bypass: never`. Re-fetch these live
settings for every candidate. Strict checks therefore do provide the
up-to-date-base safeguard for PRs targeting `main`; the previous statement
that the current ruleset lacked this guarantee was stale. The ruleset does not
configure a merge queue. The PR merge tool's `expected_head_sha` parameter
guards only the PR head, not the target ref. A concurrent retarget can race
the preflight because the API has no expected-base/target parameter. Thus the
current host path cannot prove a complete atomic merge boundary even apart
from its lack of code-authenticated evidence. Do not perform a standing
automatic merge while either limitation remains. Do not enable a merge queue
or change rulesets as a workaround without separate authorization and CI
support for `merge_group`.

Before standing automatic merging may be considered, a separately reviewed
runtime boundary must authenticate live GitHub state and actual specialist
invocations, bind the verified target/base to the execution, reject stale or
conflicting state, and provide a safe response to target-ref changes. It must
also pass independent security/reliability review and exact-head CI. Until
then, the policy evaluator's blocked outcome is authoritative. The Manager
must not bypass it by directly calling GitHub. An ordinary manually approved
PR merge remains governed by the separate exact-scope Manual procedure.

## Activation checklist

1. Merge the policy implementation manually under a separate, exact PR/head/
   target authorization; the policy is disabled during that merge.
2. Verify exact-head and post-merge Required PR CI and that `main` contains the
   reviewed policy digest.
3. Implement and independently verify a trusted live-verification and
   target-binding mechanism; the current host-only path is insufficient and
   candidate decisions must continue to fail closed until it exists.
4. Obtain a separate, explicit repository-owner activation authorization for
   `HamedGithubforwork/QuizForge-AI`, target `main`, this policy version and
   digest, and an expiry no more than 90 days away. Do not infer activation
   from approval to merge the implementation.
5. Record activation and later revocation in the durable integration
   checkpoint. Verify the current live repository state before any candidate
   merge; a checkpoint is an audit record, not GitHub evidence.

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

The Coordinator runs the normal development sequence autonomously. The
Developer implements; Reviewer independently inspects the exact final diff and
reports findings; QA independently runs the relevant tests; Security
independently assesses the exact diff and risk; and the Merge Manager performs
the final read-only readiness and risk-classification review. A role may not
claim another role's work. The Coordinator and Developer record their actual
invocation identifiers and evidence; the Developer's commit must equal the
candidate PR head. Reviewer, QA, Security, and Merge Manager assessments must
identify their actual invocation, evidence, and exact PR head SHA. Any unresolved material finding,
missing evidence, test failure, or uncertain risk classification blocks.

Before the Merge Manager's merge action, re-fetch the open, non-draft PR, target
`main`, exact head and current `main` SHA, complete diff, mergeability, formal
reviews, and current rulesets/protections. Verify a successful PR-associated
Required PR gate for the exact head and base, successful exact-head Reviewer,
QA, and Security assessments, and absence of deployment, cloud-spend,
destructive, or other unexpected side effects. Re-evaluate policy expiry and
revocation. If head, base, policy digest, findings, protections, or side effects
changed—or evidence is older than five minutes—stop and repeat the relevant
verification. The GitHub merge call must use the expected head SHA. Never
bypass branch protection, use admin privileges, or enable GitHub auto-merge.
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

The policy module cannot authenticate invocation IDs, retrieve GitHub data,
establish that linked evidence is truthful, or call the GitHub merge API. It
therefore fails closed with `trusted_live_verification_unavailable` for every
otherwise eligible candidate. Caller-supplied claims cannot make a candidate
ready. The coordinator must not select or merge a candidate based on checkpoint
evidence. This remains true even if the policy is later explicitly activated:
activation alone does not supply a trusted verifier.

Before an automatic merge can be considered, a separately reviewed runtime
adapter must independently retrieve the live PR, complete diff, required
checks, reviews, rulesets/protections, and mergeability; establish actual
specialist invocations from trusted session evidence; assess merge-triggered
side effects; and reject stale or conflicting state. The adapter must prove
strict required-status-checks or an enforced merge queue to protect against
the target-base advancing after assessment. The current main ruleset does not
provide that guarantee, so candidate eligibility remains blocked even if
caller-supplied protection fields claim otherwise. Do not add a forgeable
boolean, invocation-ID format check, or checkpoint event as a substitute.

Only after such a runtime boundary exists and passes independent review may the
Merge Manager use GitHub's expected-head merge operation. The Coordinator must
then verify the actual GitHub merge response and resulting commit before
recording completion. Checkpoints remain audit records, not authenticated
sources of GitHub truth.

## Activation checklist

1. Merge the policy implementation manually under a separate, exact PR/head/
   target authorization; the policy is disabled during that merge.
2. Verify exact-head and post-merge Required PR CI and that `main` contains the
   reviewed policy digest.
3. Obtain a separate, explicit repository-owner activation authorization for
   `HamedGithubforwork/QuizForge-AI`, target `main`, this policy version and
   digest, and an expiry no more than 90 days away. Do not infer activation
   from approval to merge the implementation.
4. Record activation and later revocation in the durable integration
   checkpoint. Verify the current live repository state before any candidate
   merge; a checkpoint is an audit record, not GitHub evidence.

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

The policy module is a pure checkpoint decision validator. It validates the
shape, scope, and freshness of evidence references and role assessment records;
it does not authenticate invocation IDs, retrieve GitHub data, establish that
linked evidence is truthful, or call the GitHub merge API. A recorded
`eligible` decision is therefore only a workflow candidate, never proof that
the checks passed and never sufficient authority for a merge by itself. Before
any GitHub mutation, the Merge Manager must independently retrieve and inspect
the live PR, exact diff, check run, reviews, protections, and side effects
through the connected GitHub account; if the live evidence cannot be obtained
or differs from the recorded assessment, it must stop. The Coordinator must
then verify the actual GitHub merge response and resulting commit before
recording completion. The checkpoint remains an audit claim, not an
authenticated source of GitHub truth.

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

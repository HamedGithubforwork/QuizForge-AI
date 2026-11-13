# GitHub organization transfer runbook

This runbook prepares `HamedGithubforwork/QuizForge-AI` for a later transfer to
`QuizFromNotes/QuizForge-AI`. The expected repository ID is `1307099196`; the
destination organization ID is `356387243`. It does not authorize a transfer,
change AWS, merge a PR, alter repository protections, or deploy.

## Before transfer

1. Record the source repository ID, visibility, protected `main` SHA, branches,
   tags, open PRs, rulesets, required check names, Actions settings, environments,
   and secret/variable names and scopes. Save a Git mirror and a separate copy
   of repository settings and required workflow artifacts. Do not copy secret
   values into notes or logs.
2. Confirm the destination organization ID and current Owner/admin membership
   using authenticated GitHub access. Confirm the destination name is available
   and the owner account has repository-transfer permission.
   Keep the repository public: GitHub documents merge queues for public
   organization-owned repositories, while private merge queues require
   Enterprise Cloud. GitHub also warns that moving a private repository to a
   Free organization removes protected-branch features. See [merge queue
   availability](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue#who-can-use-this-feature)
   and [repository-transfer behavior](https://docs.github.com/en/repositories/creating-and-managing-repositories/transferring-a-repository#whats-transferred-with-a-repository).
3. Independently inspect the saved AWS OIDC trust policy using authorized,
   read-only AWS access. The current report of a dual old/new immutable subject
   policy is user-reported and has **not** been independently verified in this
   development environment. Do not transfer until the exact audience, subject
   prefix, repository ID, owner ID, allowed refs, and production environment
   conditions are confirmed. Do not remove the old subject before a safe
   destination validation; authorize that later removal separately.
4. Confirm the destination organization permits Actions and GitHub OIDC, and
   identify how GitHub Apps and the Codex connector will be reinstalled or
   reconnected after transfer. Do not create credentials or broaden permissions
   as part of this preparation.
5. Schedule a maintenance window. Stop or disable cloud-capable/manual
   activation operations through their existing operator controls before the
   transfer. Do not edit deployment logic to suppress a deployment. Confirm
   that no push, release, Terraform, image-publication, or production workflow
   is queued and that no one is dispatching one during the window.
6. Keep the target-only identity-guard PR unmerged until after transfer. It
   contains no old-owner allowlist: its guarded operations fail closed on the
   source identity and accept only the expected destination name and immutable
   IDs. Review its exact diff and test results again immediately before use.
   Its workflow-file changes have merge-triggered effects that need a separate
   reviewed maintenance-window plan: `lightsail-cognito-hosted-ui-style.yml`
   has a `push` path filter that includes its own workflow and can run the
   production Cognito styling job; `lightsail-release-candidate-build.yml`
   includes its own workflow in a protected-main push filter and can publish an
   ECR image; `production-google-terraform-plan.yml` includes its own workflow
   in a protected-main push filter and performs a read-only production plan.
   This PR does not suppress or authorize those runs. Do not integrate it until
   the owner has approved a safe handling plan for these exact effects.

## Transfer and destination checks

1. The repository Owner initiates the transfer through GitHub's repository
   Settings → General → Danger Zone → Transfer ownership UI. Confirm the exact
   destination organization and repository before accepting GitHub's prompt.
2. Verify the transferred repository retains ID `1307099196`, is public, and
   is now named `QuizFromNotes/QuizForge-AI`. Compare `main`, all branches,
   tags, releases, open PRs, and the saved mirror against the pre-transfer
   snapshot. Stop on missing or changed data.
3. Reconnect approved GitHub Apps and Codex access. Confirm organization
   Actions/OIDC settings, environments, variable/secret names and scopes, and
   the destination `Protect main` ruleset, strict `Required PR gate`, bypass
   actors, and review requirements through authenticated GitHub reads. GitHub
   says repository secrets remain associated during transfer; still verify
   that names, scopes, environment access, and organization allowlists work at
   the destination. Do not export or copy secret values.
4. Reconcile existing PR bases and required CI under the destination identity.
   Do not treat old run links or pre-transfer check conclusions as current
   verification. Keep automatic merging disabled and do not enable the merge
   queue as part of this migration.
5. Review and integrate the target-only identity guards only after confirming
   the exact destination name and IDs. Run deterministic tests and ordinary
   Required PR CI. For OIDC, use a separately approved, non-deploy validation
   that only obtains caller identity or validates the trust path; do not run
   Terraform apply, publish an image, change IAM, or deploy.
6. After the destination OIDC path and production environment restrictions are
   independently verified, separately authorize removal of the old-owner IAM
   subject. Re-read the resulting trust policy and verify no unexpected
   identities, audiences, refs, or environments were added.
7. Reconcile active Merge Manager commands and the process-pinned historical
   verifier/canonical graph in a separate, manually reviewed post-transfer
   change. This PR intentionally leaves those trust anchors and historical
   checkpoint/audit records unchanged. Until that follow-up is reviewed and
   verified, Coordinator historical continuation may remain unavailable. Old
   repository-specific approvals, policy activations, and checkpoint claims do
   not become authorization for the destination. Automatic merging remains
   disabled and `trusted_live_verification_unavailable` remains a hard stop.

## Separate merge-queue readiness (not part of transfer)

The current `Protect main` ruleset does not contain a `merge_queue` rule. Do
not enable the queue during this migration. First integrate PR B and verify its
exact-head Required PR gate. A live `merge_group` run cannot happen until the
repository-level `merge_queue` rule is enabled. Enabling that rule can cause
queued PRs to merge automatically after required checks pass. Therefore, a live
test requires separate authorization both for the ruleset change and for a
specific disposable canary PR that may merge. Only then add the
`merge_queue` rule to `Protect main`, enqueue that exact canary, and verify a
real `checks_requested` run on the synthetic head, including the Required PR
gate and all relevant jobs. If the canary passes, GitHub will merge it; do not
enqueue any PR without exact PR-specific approval. This preparation does not
enable the rule or queue. Keep the repository public while using merge queues
on the Free organization plan, and keep automatic merging disabled until its
independent trusted execution boundary is implemented and separately
authorized.

## Failure and rollback

- If GitHub transfer is incomplete or destination verification fails, stop all
  cloud-capable Actions and do not merge migration changes. Preserve the Git
  mirror and settings snapshot. Use GitHub's supported ownership-transfer
  controls or contact GitHub Support; do not recreate a same-named repository
  and treat it as equivalent.
- If Apps, Actions, OIDC, or CI fail after transfer, keep deployment and
  activation operations suspended. Restore access/settings only through the
  normal owner/admin controls and only after reviewing the exact diff. Do not
  restore old-owner workflow guards or add both owners as an indefinite
  allowlist.
- Repository transfer rollback, IAM changes, protection changes, deployments,
  and merge-queue activation each require separate authorization. This runbook
  does not perform them.

## Source identity inventory

The read-only inventory of current source `main` (2026-11-13) found 62 tracked
paths containing the source slug: 22 workflow files, 19 script files, 7
`docs/autonomy` files, 2 benchmark JSON files, 1 infrastructure metadata file,
and 11 other documentation/record files. These categories are disjoint and
sum to 62. This PR changes only the active operational subset listed below;
it does not bulk-replace the repository slug.

**Workflow changes:** 19 exact owner guards now require the destination slug,
repository ID, and destination owner ID: `aws-backup-activation-cloud.yml`,
`aws-backup-activation.yml`, `cognito-sms-activation.yml`,
`lightsail-app-stage.yml`, `lightsail-backup-timer-activation.yml`,
`lightsail-cognito-hosted-ui-style.yml`, `lightsail-database-migrations.yml`,
`lightsail-frontend-hotfix.yml`, `lightsail-manual-control.yml`,
`lightsail-production-quiz-e2e.yml`, `lightsail-production-recovery-drill.yml`,
`lightsail-release-candidate-build.yml`, `lightsail-release-promote.yml`,
`lightsail-ssh-host-trust-probe.yml`, `lightsail-study-notifier-activation.yml`,
`production-google-activation.yml`, `production-google-incident.yml`,
`production-google-oauth-readiness.yml`, and
`production-google-terraform-plan.yml`. `local-ai-prompt-v3.yml` and
`local-ai-prompt-v4.yml` use `${{ github.repository }}` for their pinned source
checkouts so PR contract checks work before and after transfer; their model
comparisons remain manual-dispatch only. `aws-integrated-staging.yml` updates
one generated guide link. These are identity/input changes; deployment logic,
workflow triggers, and AWS permissions are unchanged.

**Runtime script changes:** `scripts/github_repository_identity.py`,
`scripts/aws_staging_preview.py`, `scripts/backup_activation/contract.py`,
`scripts/integrated_staging/ai_budget.py`,
`scripts/integrated_staging/auto_frontend_merge.py`,
`scripts/integrated_staging/auto_parity_merge.py`, the four
`scripts/integrated_staging/auto_recovery_*` guards, and
`scripts/production/lightsail/{google_activation,provision_native_client,recovery_drill,style_cognito_hosted_ui}.py`.
Corresponding focused tests/fixtures were updated to require the same target
identity.

**Preserved for a separate post-transfer trust review:** the process-pinned
`docs/autonomy/integration-task-graph.json`, all other `docs/autonomy` files,
`scripts/autonomy/trusted-integration-verifier.cjs`,
`scripts/autonomy/automatic-merge-policy.cjs`, their existing tests, all
checkpoint/optimization state, historical PR URLs and approvals, the two
benchmark JSON files, and `infra/aws/variables.tf`. Historical audit reports
`docs/lightsail-acceptance-2026-09-21.md`,
`docs/lightsail-launch-tests-2026-09-21.md`, and
`docs/staging-readiness-audit-2026-10-11.md` are also preserved. The other
eight documentation files are `README.md`, `docs/ai-live-canary.md`,
`docs/google-signin-production-rollout.md`, `docs/lightsail-backup-restore.md`,
`docs/lightsail-production-configuration.md`,
`docs/local-qwen-pilot-progress.md`, `docs/operations/backup-activation.md`,
and `docs/staging-manual-google-link-test.md`; they remain unchanged for
separate owner/location review. The verifier and policy still identify the
source repository, and the verifier's
`trusted_live_verification_unavailable` behavior is unchanged. They are not
silently migrated by this PR; historical continuation will need a fresh
canonical-graph review after transfer, and old approvals never transfer as
authorization.

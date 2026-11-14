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
3. The repository owner has confirmed saving a dual old/new immutable-subject
   AWS OIDC trust policy. This remains owner-confirmed and has not been read
   back by this environment; do not request the same screenshots again. The
   owner should retain the policy snapshot and confirm its exact audience,
   subject prefixes, repository/owner IDs, refs, and production environment
   conditions in their authorized AWS interface during the maintenance
   checklist. Do not modify IAM or remove the old subject in this preparation.
4. Confirm the destination organization permits Actions and GitHub OIDC, and
   identify how GitHub Apps and the Codex connector will be reinstalled or
   reconnected after transfer. Do not create credentials or broaden permissions
   as part of this preparation.
5. Keep PRs #705 and #706 open through transfer. After destination verification,
   reconcile and integrate them in dependency order: #705 first, then #706 on
   the resulting `main`. Run fresh exact-head checks and resolve findings for
   each. PR #705 changes CI only and does not enable a merge queue. This runbook
   does not authorize either merge.
6. Before the transfer window, inventory in-progress AWS-capable workflows and
   establish a temporary GitHub Actions hold for the 28 such workflows on the
   current `main` (listed below). Use GitHub's reversible workflow-disable
   controls and record exactly which workflows were disabled. PR #706 adds a
   29th, identity-only workflow; it is not on current `main` before that PR is
   integrated and has no automatic push/PR trigger.
   Keep the credentialless `CI` workflow and `Required PR gate` enabled. Do not
   change IAM, rulesets, permissions, or workflow code to create the hold. The
   hold interrupts manual cloud operations; schedule it with the service owner
   and do not proceed if that interruption is unacceptable. Disabling a
   workflow does not cancel an active run (see [GitHub's workflow disable
   guidance](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows)):
   wait for each active cloud-capable
   run to finish or cancel it only when that operation can be safely stopped,
   and confirm no cloud-capable run remains queued or in progress before
   transfer.
7. After destination identity/settings verification, restore the 28 workflows
   that were enabled before the transfer hold so post-transfer PR validators
   can run. Do not dispatch manual AWS operations. Integrate #705 first with
   its exact-head checks and separate authorization; its diff is CI-only. Then
   reconcile #706 and run all relevant workflow validations plus Required PR
   CI at its final exact head while workflows are enabled. Before separately
   authorized integration of #706, drain active runs and temporarily disable
   only these three workflows whose `push` paths match its changed files:
   `lightsail-cognito-hosted-ui-style.yml` (production Cognito styling),
   `lightsail-release-candidate-build.yml` (ECR publication), and
   `production-google-terraform-plan.yml` (read-only production plan). Keep
   `ci.yml` and the Required PR gate enabled. Immediately before merge, re-fetch
   and confirm the exact-head gate and all previously completed relevant checks
   still apply; stop if any required check is missing or no longer successful.
   After the authorized merge, verify those three effects did not execute,
   restore their prior enabled states, and inspect Actions before any further
   operation. Do not dispatch production-changing workflows without separate
   authorization.

### Temporary AWS-capable workflow hold

The transfer-candidate inventory includes 29 workflows with `id-token: write`:
28 already on `main` and the manual identity-only workflow introduced by PR #706.
For the transfer itself, disable the 28 workflows already on `main`; keep the
credentialless Required PR gate enabled. Restore the 28 to their recorded
pre-transfer states after destination identity and protection checks, before
running fresh PR validations. Do not dispatch manual AWS operations during this
period. After #706 is integrated, a separate identity-test window may disable
the 28 operational workflows again while leaving the new identity-only workflow
enabled for its specifically authorized dispatch.

`aws-backup-activation.yml`, `aws-backup-activation-cloud.yml`,
`aws-budget-alerts.yml`, `aws-integrated-staging.yml`,
`aws-integrated-staging-frontend-update.yml`, `aws-production-inventory.yml`,
`aws-staging-ai-budget.yml`, `aws-oidc-identity-check.yml`, `backend-ecr.yml`,
`cognito-sms-activation.yml`,
`desktop-auth-readiness.yml`, `desktop-native-client-registration.yml`,
`lightsail-app-stage.yml`, `lightsail-backup-timer-activation.yml`,
`lightsail-cognito-hosted-ui-style.yml`, `lightsail-database-migrations.yml`,
`lightsail-frontend-hotfix.yml`, `lightsail-manual-control.yml`,
`lightsail-production-quiz-e2e.yml`,
`lightsail-production-recovery-drill.yml`,
`lightsail-release-candidate-build.yml`, `lightsail-release-promote.yml`,
`lightsail-ssh-host-trust-probe.yml`,
`lightsail-study-notifier-activation.yml`, `production-google-activation.yml`,
`production-google-incident.yml`, `production-google-oauth-readiness.yml`,
`production-google-terraform-plan.yml`, and `terraform-aws.yml`.

This list must be regenerated from the exact transfer candidate before use.
Leave `.github/workflows/ci.yml` enabled so required PR checks continue. Do not
disable branch rules or required checks. A workflow-level hold also suppresses
that workflow's PR validation jobs; it does not cancel active runs. Restore the
28-workflow hold after the transfer verification, before fresh PR validation.
For #706, disable its three push-side-effect workflows only after their
exact-head validation has passed; verify the Required PR gate remains successful
immediately before the merge. For the later identity-test window, disable the
28 operational workflows again and leave only the new manual identity check
available. Restore recorded enabled states after the identity check completes.

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
5. Restore the 28 workflows to their pre-transfer enabled states after the
   transfer checks so post-transfer PR validation can run. Keep manual AWS
   operations undispatched. Reconcile PR #705 and obtain exact-head checks
   first. Then reconcile #706; the staging PR path runs credentialless
   validation only. Its manual Run path requires explicit current PRs before
   AWS preflight, pins their immutable heads, and rechecks the same open PRs,
   exact-head checks, and current application baseline after image builds
   immediately before staging provisioning.
6. Before separately authorized #706 integration, after all relevant PR checks
   have passed, temporarily disable only the three push-side-effect workflows
   listed above. Leave the Required PR gate enabled and confirm its exact-head
   success remains applicable. After merge, confirm those workflows did not
   run, restore their previous enabled states, and inspect for unexpected runs.
   Once #706 is integrated and destination settings are verified, temporarily
   disable the 28 operational workflows listed above while retaining the new
   identity-only workflow. After confirming no AWS-capable jobs are queued or
   active, a separately authorized owner may dispatch `AWS OIDC identity check`
   from protected `main` through the `production`
   environment. The job also enforces that account's immutable GitHub actor ID.
   It uses a 15-minute session policy limited to
   `sts:GetCallerIdentity`, validates the expected AWS account/role without
   printing raw caller-identity data or credentials, and masks the account ID.
   The AWS credentials action may log its noncredential assumed-role session
   identifier. The workflow performs no apply, image publication,
   provisioning, or deployment. If the check fails or the configured role is
   unexpected, do not dispatch any other operation. The identity check does not
   authorize production changes or independently verify the saved IAM document.
   Restore the 28 workflows to their recorded pre-maintenance states after the
   check completes and verify no workflow was unexpectedly triggered.
7. After the destination OIDC path and production environment restrictions are
   independently verified, separately authorize removal of the old-owner IAM
   subject. Re-read the resulting trust policy and verify no unexpected
   identities, audiences, refs, or environments were added.
8. Reconcile active Merge Manager commands and the process-pinned historical
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
one generated guide link and separates credentialless PR validation from
manually selected, exact-head-verified staging application PRs. The manual
staging path verifies selection before AWS-authenticated preflight and checks
the same immutable heads again after image builds before provisioning; its
`stop` operation remains independent of PR inputs. These changes preserve
deployment logic and AWS permissions.

The new `aws-oidc-identity-check.yml` is manual-only on protected `main`,
requires the `production` environment, accepts only the exact source or
destination repository identity, and limits the assumed-role session to
`sts:GetCallerIdentity`. It does not read secrets, publish artifacts, or
modify cloud resources. Its identity assertion is not run during PR validation.

**Runtime script changes:** `scripts/github_repository_identity.py`,
`scripts/aws_staging_preview.py`, `scripts/backup_activation/contract.py`,
`scripts/integrated_staging/ai_budget.py`,
`scripts/integrated_staging/auto_frontend_merge.py`,
`scripts/integrated_staging/auto_parity_merge.py`, the four
`scripts/integrated_staging/auto_recovery_*` guards, and
`scripts/production/lightsail/{google_activation,provision_native_client,recovery_drill,style_cognito_hosted_ui}.py`.
Corresponding focused tests/fixtures were updated to require the same target
identity.

One read-only CI exception is intentionally narrower in authority: the
`aws_staging_preview.py` preflight uses GitHub's run-provided repository name,
repository ID, and owner ID to fetch PR metadata before and after transfer.
It accepts only the exact source or destination identity, validates the PR
head repository against that same identity, and has no AWS credential or
write permission. This supports current source-repository PR validation while
the destination-only identity predicate remains mandatory for operational
cloud/deployment guards; do not reuse the read-only predicate for privileged
actions.

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

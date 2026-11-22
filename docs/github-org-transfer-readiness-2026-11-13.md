# QuizForge-AI: GitHub organization transfer readiness and no-deploy runbook

**Status:** PREPARATION ONLY — NOT TRANSFER-READY. **Date:** 2026-11-13.  
**Source:** `HamedGithubforwork/QuizForge-AI` (repository ID `1307099196`).  
**Destination:** `QuizFromNotes/QuizForge-AI` (organization ID `356387243`, user-reported; membership/permission still requires authenticated independent verification).  
**Protected baseline:** `main` at `6a0238ecfb57927b2be3ecf2dfb521bf0a9b11c7`.

This file is a change plan and evidence inventory, **not** permission to transfer, deploy, adjust IAM, activate a merge queue, or automatically merge. Historical approvals are not portable to the new repository identity.

## Read-only evidence at this baseline

- GitHub connection: authenticated account `HamedGithubforwork`, user ID `148009407`; source repository admin permission confirmed. Source repository is public and `allow_auto_merge=false`.
- Source repository ruleset `Protect main`, ID `21886458`, active for default branch: deletion and non-fast-forward protection; PR rule; strict status checks requiring **`Required PR gate`** from GitHub Actions integration ID `15368`; no bypass actors. Effective organization-level rules after transfer are **not** verified.
- Destination `QuizFromNotes/QuizForge-AI` returned 404 when looked up by the connected account. This suggests the name is free; **not** proof of destination organization ownership, permission to create repositories, or transfer acceptance.
- Connected GitHub App installation lists only the `HamedGithubforwork` personal account (installation ID `132115069`). There is no verified destination-organization installation. Codex and any other GitHub App authorizations must be reviewed/re-established under the intended organization with selected-repository scope.
- Authenticated organization membership query through the available connector returned no organizations. This conflicts with the user's reported Owner status and must be resolved through an independent, authorized organization membership/role read. Do not treat a 404 or missing org installation as proof that the organization does not exist.
- Repository environment restrictions, Actions settings, secrets, variables, OIDC customization, and organization-level policies are **unverified** because the connector cannot read those sensitive administration endpoints. In particular, production environment's `main`-only restriction is user-reported, not independently confirmed.
- AWS IAM role `QuizForgeGitHubTerraform`: user reports saving `StringEquals` OIDC trust for old and new immutable subjects, each for `refs/heads/main` and `environment:production`, with `aud=sts.amazonaws.com`. **Saved AWS policy not independently verified**; AWS read-only account/IAM access unavailable. Never infer it from the user's intended policy or edit IAM here.
- Local authenticated `gh` is unavailable in the execution environment; live verification above used the GitHub connector. The commands below are *instructions for a later authorized read-only preflight*, not completed checks.

## Repository identity reference inventory and treatment

This is a line-level inventory of the live, migration-sensitive locations inspected at the pinned baseline. Any subsequent commit needs a refreshed search; do not infer that file or workflow counts remain static.

### A. Active operational authorization — destination-only changes **after** transfer

Nineteen workflows enforce the exact old `github.repository` identity:

1. `.github/workflows/aws-backup-activation-cloud.yml`
2. `.github/workflows/aws-backup-activation.yml`
3. `.github/workflows/cognito-sms-activation.yml`
4. `.github/workflows/lightsail-app-stage.yml`
5. `.github/workflows/lightsail-backup-timer-activation.yml`
6. `.github/workflows/lightsail-cognito-hosted-ui-style.yml`
7. `.github/workflows/lightsail-database-migrations.yml`
8. `.github/workflows/lightsail-frontend-hotfix.yml`
9. `.github/workflows/lightsail-manual-control.yml`
10. `.github/workflows/lightsail-production-quiz-e2e.yml`
11. `.github/workflows/lightsail-production-recovery-drill.yml`
12. `.github/workflows/lightsail-release-candidate-build.yml`
13. `.github/workflows/lightsail-release-promote.yml`
14. `.github/workflows/lightsail-ssh-host-trust-probe.yml`
15. `.github/workflows/lightsail-study-notifier-activation.yml`
16. `.github/workflows/production-google-activation.yml`
17. `.github/workflows/production-google-incident.yml`
18. `.github/workflows/production-google-oauth-readiness.yml`
19. `.github/workflows/production-google-terraform-plan.yml`

**Policy:** Leave old exact guards unchanged before transfer; afterward, replace them with **destination-only** identity validation scoped to repository ID `1307099196`, destination owner ID `356387243`, destination name `QuizFromNotes/QuizForge-AI`, expected event, protected branch, and (where already present) deliberate manual confirmation. Never permanently use `old || new`. A transferred workflow that still checks the old owner must fail closed until a reviewed post-transfer correction.

Additional active authorization and approval code:
- `scripts/autonomy/automatic-merge-policy.cjs`: pinned old repository identity and disabled standing policy; `trusted_live_verification_unavailable` is mandatory. A new destination identity requires a **new independently reviewed, explicitly authorized policy/activation lifecycle**, not a find-and-replace.
- `scripts/autonomy/trusted-integration-verifier.cjs`: old repository constant, protected canonical task-graph pin, historical GitHub proof. Keep immutable evidence and fail closed; a future canonical migration must preserve prior provenance and be explicitly approved. Do not silently repin old graph evidence.
- `scripts/ci/verify-required-pr-gate.cjs` in the separate merge-queue readiness PR: source-only name/owner/repository ID pins intentionally fail after transfer until a destination-only PR changes them.

### B. Configuration and automation input — review before changing

- `.github/workflows/local-ai-prompt-v3.yml` and `local-ai-prompt-v4.yml` have hardcoded `repository: HamedGithubforwork/QuizForge-AI` checkout fields. Review whether they should use `github.repository` safely after transfer, preserving required pinned commit/branch behavior and fork trust restrictions.
- `.github/workflows/production-google-activation.yml` includes a hardcoded old-owner GitHub Actions API URL in addition to its authorization guard. Update API routing only with its authorization change.
- `.github/workflows/aws-integrated-staging.yml` embeds an old GitHub documentation URL in a generated summary. Future documentation-only update is safe only after reviewing triggering conditions.
- `docs/autonomy/supervised-merge.md` contains operational `gh api` commands pinned to the old repository. Update the **future operational procedure** only after transfer; preserve the old historical readback as historical evidence.
- `README.md` contains a CI badge and clone link to the old owner, and `docs/operations/backup-activation.md` identifies the existing repo. Update current navigation/configuration references after transfer; avoid rewriting historical evidence.
- `scripts/integrated_staging/auto_frontend_merge.py` and `scripts/integrated_staging/auto_parity_merge.py` pin the old `REPOSITORY` for one-time staging merge automation. These are **active authorization/automation inputs**, not generic links: do not silently update to destination or replay old staging merge approval. Any replacement requires a separately authorized, post-transfer, fail-closed review.
- `infra/aws/variables.tf` includes a `common_tags.Repository` value naming the old repository. Although it is metadata, editing this `.tf` file on `main` is itself within the foundation Terraform workflow's `push` trigger path and may cause **Terraform apply**. Do **not** change even this apparent cosmetic field as part of a safe identity sweep; isolate it behind the separately approved cloud/deployment freeze.
- `scripts/autonomy/test/{automatic-merge-policy,trusted-integration-verifier,integration-coordinator,supervised-merge-policy}.test.cjs` and `scripts/autonomy/test/optimization-orchestrator.test.cjs` contain old-repo fixtures or historical evidence. Rework only the *current* policy test fixtures in a separate authorized migration PR; preserve historical assertions, old checks and original PR proof.
- `scripts/aws_staging_preview.py` has an old `REPOSITORY` constant used in credentialed staging eligibility. `scripts/backup_activation/contract.py` has an old `REPOSITORY` plus pinned backup activation candidate SHA and policy digests: **do not rewrite** pinned authorization/evidence just to update the repo name. These need an independent, scope-specific future review.
- `scripts/integrated_staging/ai_budget.py` rejects any `GITHUB_REPOSITORY` other than the source for trusted manual cost/budget operations; `scripts/integrated_staging/test_ai_budget.py` tests this exact scope. Leave fail-closed until approved after-transfer change.
- `scripts/production/lightsail/google_activation.py` verifies repository identity inside fresh run metadata and release-lock preflight. `scripts/production/lightsail/provision_native_client.py`, `recovery_drill.py`, and `style_cognito_hosted_ui.py` require old `GITHUB_REPOSITORY` in addition to event/ref/attempt/confirmation restrictions. `test_google_activation.py` and `test_provision_native_client.py` assert old-run evidence and guards. Preserve these safeguards; never reuse an old successful release inspection or approval as authorization on the new owner.
- Literal-repository-identity scan at the pinned baseline: inspected all 39 workflow YAML files; the current docs and autonomy records; the Codex agent profiles; and 416 additional source/configuration files (text GitHub connector reads, with one transient read failure retried successfully). This excludes binary assets and selected generated/lock files and does not replace a refreshed complete-text scan at the eventual transfer candidate SHA.

### C. Documentation and external links — migration-compatible, lower priority

Current links, badges, and onboarding instructions may be changed after transfer. GitHub generally redirects old repository and PR URLs, but redirects are not an authorization guarantee. Update active onboarding only after verified destination visibility.

### D. Historical audit and immutable evidence — **DO NOT CHANGE**

Do not bulk-replace `docs/autonomy/integration-task-graph.json`, `docs/autonomy/integration-checkpoint.json`, `docs/autonomy/optimization-state.json`, old PR evidence in `docs/autonomy/integration-workflow.md`, `docs/autonomy/pilot-report.md`, dated Lightsail/Google/AI run reports, benchmarks, past approval records or checkpoint claims. Keep old owner, original PR numbers, SHAs, exact-head status records, and dated URLs as originally recorded. The old name is part of the historical provenance. GitHub redirects are for navigation, not proof of authorization.

## AWS, production, and cost-sensitive triggers — hard stop before transfer

Several workflows have AWS OIDC or production side effects and must not be changed/merged casually.

| Path | Existing trigger and possible side effect | Preparation treatment |
| --- | --- | --- |
| `.github/workflows/backend-ecr.yml` | `push` on `main` when `backend/**` **or the workflow itself** changes; builds and **publishes** ECR image with OIDC. It currently checks `main`, not an exact owner/repository guard. | **DO NOT** merge a migration edit without separately authorized cloud-impact review. A change to the workflow itself can trigger an ECR push on its own merge. |
| `.github/workflows/terraform-aws.yml` | `push` on `main` when foundation TF or workflow paths change; `apply` requires changed foundation (or manual dispatch), uses OIDC. | Avoid touching workflow and foundation TF in pre-transfer PR. Future guard or change requires separate deploy/foundation safety review. |
| `.github/workflows/lightsail-release-candidate-build.yml` | `push` on `main` when the release builder workflow, `frontend/**`, or release files change; ECR image preparation/push possible. | Existing exact old-repository guard blocks the post-transfer build until explicitly updated; do not pre-authorize destination. |
| `.github/workflows/lightsail-cognito-hosted-ui-style.yml` | `push` on `main` when workflow or styling inputs change; apply job can mutate Cognito with OIDC. | Leave untouched in safe preparation. |
| `.github/workflows/aws-integrated-staging-frontend-update.yml` | Has deliberately enumerated `main` push request paths and multiple credentialed/manual operations. | Keep one-time staging request gates and shutdown/budget constraints intact; do not add trigger paths or broaden permissions. |
| `.github/workflows/lightsail-database-migrations.yml`, `lightsail-release-promote.yml`, `production-google-activation.yml` | Manual production operations guarded by old exact repository and other conditions. | Require manual post-transfer destination-only re-authorization and production environment verification before use. |

**NO-GO:** Because the intended AWS trust reportedly permits the new owner, the transfer could make existing unguarded `main` push workflows capable of AWS side effects in the destination. **Do not transfer until a separately reviewed no-deploy isolation plan is verified** (for example, appropriately restricted Actions execution at the transition boundary and/or source-only owner/repo-ID guards installed under an approved deployment freeze). Do not attempt to achieve that by simply broadening repository checks or by changing AWS deployment logic in this preparation PR. Post-transfer restoration of any AWS path is a separate cost/production approval.

Production Google/Cognito, database, Lightsail, backup, and Terraform environment protections must be independently checked in the destination before any credentialed workflow is intentionally dispatched. An approval is bound to its original repo, PR, head SHA and target branch; **old approvals and checkpoint history never authorize new merges or deployments**.

## Merge queue CI preparation — separate draft PR, no activation

The CI preparation branch `codex/merge-queue-ci-prep-20261113` modifies only `.github/workflows/ci.yml` and `scripts/ci/{verify-required-pr-gate,test-pr-ci-trigger}.cjs`. It keeps `pull_request` checks and adds `merge_group: checks_requested` for `main`. The classifier compares `merge_group.base_sha` with `merge_group.head_sha` on the **synthetic group commit**, verifies SHA consistency, and the same **Required PR gate** refuses missing/failed checks or skipped jobs marked relevant. It checks source repository name/owner ID/repo ID and rejects unexpected queue target/head refs.

- No merge queue is enabled; the branch is not the authority to activate it.
- After transfer, first switch the source-only CI identity to the verified destination identity via a **separate manual PR**. This intentionally blocks new-owner CI before that approved update.
- Deterministic tests cover ordinary PR and stacked-PR events, merge groups, wrong repository identity, wrong target, wrong group SHA, missing/failed/cancelled required checks, and skipped relevant jobs.
- Real merge-group Actions run against a synthetic commit remains **UNVERIFIED** until the actual queue is separately enabled with explicit authorization. A simulation is not a substitute for GitHub's exact-commit check.
- Keep the exact `Required PR gate` check name (GitHub Actions integration `15368`) and inspect its status on each queued group; no permissive path filters or skip-success shortcuts.

GitHub documents merge queues for public organization repositories (including Free), but workflow triggers and the exact effective post-transfer ruleset still need readback. The queued merge group's actual SHA must be the commit checked. **Do not enable queue or automatic merging now.**

## Read-only human preflight commands (not executed)

Run with an authenticated `gh` session on a trusted local machine, with no tokens printed. Read back source and target identity both before and after the settings inspection:

```sh
gh auth status
gh api user --jq '{login,id}'
gh api orgs/QuizFromNotes --jq '{login,id}'
gh api user/memberships/orgs/QuizFromNotes --jq '{role,state}'
gh api repos/HamedGithubforwork/QuizForge-AI --jq '{id,full_name,default_branch,permissions,allow_auto_merge}'
gh api repos/HamedGithubforwork/QuizForge-AI/git/ref/heads/main --jq '.object.sha'
gh api repos/HamedGithubforwork/QuizForge-AI/rulesets
gh api repos/HamedGithubforwork/QuizForge-AI/rulesets/21886458
gh api repos/HamedGithubforwork/QuizForge-AI/rules/branches/main
gh api orgs/QuizFromNotes/actions/permissions
gh api repos/HamedGithubforwork/QuizForge-AI/actions/permissions
gh api repos/HamedGithubforwork/QuizForge-AI/actions/oidc/customization/sub
gh api repos/HamedGithubforwork/QuizForge-AI/environments --jq '[.environments[] | {name,protection_rules}]'
gh api repos/HamedGithubforwork/QuizForge-AI/actions/secrets --jq '[.secrets[].name]'
gh api repos/HamedGithubforwork/QuizForge-AI/actions/variables --jq '[.variables[].name]'
gh api repos/HamedGithubforwork/QuizForge-AI/environments/production/secrets --jq '[.secrets[].name]'
gh api repos/HamedGithubforwork/QuizForge-AI/environments/production/variables --jq '[.variables[].name]'
```

Verify organization-level secret/variable *names, visibility, and selected-repository scopes* where applicable, and repo/environment overrides. Workflow YAML currently **references**, but does **not** prove the existence/scope of, names such as `AWS_ROLE_ARN` (both secret and variable contexts in different workflows), `AWS_REGION`, `TF_STATE_BUCKET`, `AWS_BUDGET_ALERT_EMAIL` and `OPENAI_API_KEY`. Do not read, copy, log, echo, or transmit secret values; do not assume organization secrets grant access after transfer.

If authorized read-only AWS access is separately connected, verify the saved role trust policy with **read-only** `aws iam get-role --role-name QuizForgeGitHubTerraform --query 'Role.AssumeRolePolicyDocument'`, checking `aud=sts.amazonaws.com` and exact `StringEquals` `sub` values:

- `repo:HamedGithubforwork@148009407/QuizForge-AI@1307099196:ref:refs/heads/main`
- `repo:HamedGithubforwork@148009407/QuizForge-AI@1307099196:environment:production`
- `repo:QuizFromNotes@356387243/QuizForge-AI@1307099196:ref:refs/heads/main`
- `repo:QuizFromNotes@356387243/QuizForge-AI@1307099196:environment:production`

A successful AWS trust read is **not** an authorization to assume the role, apply Terraform, push images or run migrations. Verify the effective GitHub OIDC `sub` customization and environment protection before relying on any `sub` string.

## Reserved transfer sequence — requires separate explicit owner decision

1. **Before:** independently confirm organization ID/Owner role, destination repository-name availability and creation privilege, org Actions/OIDC and GitHub App policies, active ruleset, actual environment/secrets/variables scopes, and AWS role saved trust. Resolve any conflict; no transfer on unknowns.
2. **Before:** review and manually integrate only the scoped, credentialless merge-group CI prep when CI is green; do **not** activate merge queue or standing auto-merge.
3. **Before:** separately authorize and verify the AWS/Actions no-deploy isolation plan, covering **unguarded** ECR/Terraform push paths and any main-push release builders; freeze cost-incurring paths.
4. **Transfer:** owner uses GitHub's **native** repository-transfer UI separately. Never create a new destination repository with the desired name first; never re-create the old name afterward because GitHub redirects could be lost. Preserve repository ID, issue/PR history, commit SHAs, rulesets and branch protections only after independently verifying what GitHub actually retained.
5. **Immediately after:** verify repository ID `1307099196`, destination org ID `356387243`, `main` SHA, effective rules/rulesets, branch protection, default permissions, environments, secret/var availability by name/scope, Actions/OIDC claims, and appropriately scoped GitHub App/Codex integrations. Keep cloud jobs paused/guarded.
6. **After:** in separately reviewed manual PRs, switch CI identity to **destination only**; migrate active checkout/API/README locations; then separately migrate credentialed workflows with exact destination-only owner/repo identity, preserving all manual gates and budget controls. Do not rewrite historical checkpoints or automatically authorize old PRs.
7. **Much later:** after independent Developer, Reviewer, QA, Security/Privacy, and Release Reliability assessments, real synthetic-commit checks and queue-rule verification, separately consider enabling merge queue. Standing automatic merging still requires trusted host verifier, policy activation specific to new identity, and explicit new authorization. `trusted_live_verification_unavailable` must continue to block auto-merges until then.

## Unresolved blocking evidence

- Target organization ownership/role and repository creation/transfer permission not independently authenticated.
- Organization Actions/OIDC policy and installed GitHub App/Codex permissions unverified.
- Repository and production environment secrets/variables **names and scopes** not independently enumerated.
- Saved AWS IAM trust policy not independently read; immutable OIDC subject behavior not compared to actual configured repository.
- Actual post-transfer ruleset/protections and merge-group Actions checks cannot exist until migration/queue activation.
- Re-run a repository-wide literal-reference sweep at the final protected `main` SHA before transfer, including generated/config files not covered by the pinned baseline text scan. The historical/current reference inventory is not an authorization to bulk-replace any matches.
- Independent specialist reviewers have not yet signed off on live PR head, and no deployment-free transition plan has been approved.

**Result:** Preserve production safety, immutable audit records, and the disabled standing merge policy. Stop at preparation; no transfer, queue activation, automatic merge, AWS mutation, release or paid workflow.

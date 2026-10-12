# Manual real-provider Google account-link test (disposable integrated staging)

Use this checklist to test **real Google sign-in → existing Cognito account linking → retained quiz history** without creating a production account. A full staging run can optionally allow **temporary, email-verified signup** for manual testing; this never affects production. This is a **manual acceptance test**; the automated AWS browser tests do not exercise a real Google provider round-trip.

## Prerequisites

- If staging is **already active**, choose [AWS staging quick update](../.github/workflows/aws-integrated-staging-frontend-update.yml) from trusted `main`, then select operation **enable_test_signup**. This changes only the existing disposable Cognito user pool, with a reviewed in-place Terraform plan. It cannot create staging or change the manual shutdown policy. Wait for **Staging is ready for manual Google sign-in verification** and use **that run's published CloudFront URL**, not an old URL. A `pull_request` validation or scheduled cleanup success does **not** mean a site was provisioned.
- **Manual shutdown:** a successful new staging deployment stays running until you choose operation `stop` in the Full Staging workflow. There is no hourly automatic teardown. **AWS RDS, ECS, ALB, ElastiCache and other resources keep accruing charges** while this environment is running; stop it when testing is finished. Failure recovery may still automatically clean up an unsuccessful deployment. Do not store real personal data in staging.
- Without the explicit **Enable test signup** input, the pool stays administrator-only, with no registration email delivery. When enabled, Cognito requires email confirmation and offers optional authenticator MFA; Cognito's built-in email delivery has a limited quota, so a confirmation message may be delayed or unavailable. The full staging workflow still prepares three disposable password+TOTP users as a fallback.
- Use a **fresh staging session** if the Google account you intend to test has already chosen **Create an empty account** in the previous session. Do not try to merge or relink an already-enrolled Google identity. A newly provisioned staging pool is isolated, so you can reuse the same Google account with the new pool.
- **Self-registration requires no AWS Secrets Manager access.** The operator-only fixture is a fallback when signup was disabled or Cognito cannot deliver a verification email. Never share your test password, TOTP seed, or bearer tokens.

- If staging is already running, use [Quick Update](../.github/workflows/aws-integrated-staging-frontend-update.yml) instead of deploying another stack. To create a **fresh, isolated Cognito pool**, first run operation `stop`, wait for independently verified resource absence, then start [Full Staging](../.github/workflows/aws-integrated-staging.yml) with backend PR **537**, frontend PR **538**, and **Enable test signup** selected. A second full staging run never deletes an existing site, even if an old deadline has elapsed.
- Wait for the workflow's staging URL; a pull-request validation or a completed quick-update test job alone is **not** evidence the live environment is available.

## Authentication parity with production

Staging uses a **separate disposable AWS Cognito pool**, not the production user pool. The reviewed application PRs are deployed to it, but staging infrastructure must be explicitly kept in sync with production settings.

- **Matched to production:** Cognito password minimum **8 characters**, with required uppercase, lowercase, number and symbol. A code-level regression test compares both Terraform policies.
- **Auth settings in this draft:** optional TOTP and verified-email recovery match production. Automated synthetic accounts still enroll TOTP to exercise MFA-on flows; staging does not yet include production post-confirmation session-revocation Lambda.
- **Deliberately different:** Google is enabled for isolated testing ahead of public rollout; user data and credentials remain separate; manual Stop remains required.
- **Rollout order:** complete the existing password-only Quick Update before merging this PR. Its guard intentionally rejects unrelated MFA/recovery changes. Source changes alone do not update the running pool; a separately audited in-place auth update is required.
- **Existing staging pool created with the old 14-character requirement:** choose **update_password_policy** in [AWS staging quick update](../.github/workflows/aws-integrated-staging-frontend-update.yml) on `main`. It audits an in-place Terraform plan and rejects all unrelated changes. The policy change does not reset existing users or update production.
- Existing production accounts do not exist in staging. Never use production passwords for testing.

## Recommended: create your own staging-only account

1. If staging exists, choose operation **enable_test_signup** in [AWS staging quick update](../.github/workflows/aws-integrated-staging-frontend-update.yml), then wait for the completed success summary. For a new Full Staging run, choose `run`, backend PR `537`, frontend PR `538`, and optionally check **Enable test signup**. Only the guarded auth quick action (not the frontend-file operation) can update a Cognito user pool.
2. Open the fresh staging URL after all live checks pass. Click **Create account** (not Continue with Google yet). Enter a **different email address** from the Google account that you will link to later and choose a unique throwaway password satisfying the displayed Cognito policy.
3. Confirm the account using the email verification code delivered by Cognito. If no email arrives, check spam; Cognito's built-in email quota is limited. Do **not** disable email confirmation or MFA to get past a failed delivery.
4. Sign in. TOTP is optional; enroll an authenticator from account settings for the MFA-on linking test, and use a separate account to test MFA-off behavior. Do not bypass an MFA challenge.
5. Complete the quiz and account-linking checks below. New staging accounts remain until you explicitly Stop staging; you are responsible for ending the running AWS charges. Never use production passwords or expect history to copy from production.

If sign-up is disabled, email delivery fails, or you want the exact synthetic fixture from the automated run, follow the operator-only fallback below.

## Obtain the existing disposable account (operator fallback)

The full workflow generates and stores this secret **only while the disposable staging session exists**:

- Region: `ca-central-1`
- Secret name: `quizforge-integrated-staging-fixture`
- User to use: `users.mapped` (already has email verified and authenticator MFA configured)

Open [AWS Secrets Manager in Canada Central](https://ca-central-1.console.aws.amazon.com/secretsmanager/listsecrets?region=ca-central-1), locate the exact secret, and select **Retrieve secret value**. Inside its JSON, use only `users.mapped.email`, `users.mapped.password`, and `users.mapped.totp`. **Do not copy, forward, or download the entire secret:** it also contains test bearer tokens and other sensitive values.

Alternatively, an authorized operator can run this in **AWS CloudShell** after selecting Canada Central (do not run it in a GitHub Actions job):

```bash
aws secretsmanager get-secret-value \
  --region ca-central-1 \
  --secret-id quizforge-integrated-staging-fixture \
  --query SecretString --output text \
  | jq -r '.users.mapped | {email, password, totp}'
```

This deliberately prints **only** the three fields needed for manual testing. Treat the output as a secret. The `totp` value is the authenticator-app **manual setup key**; add it as a temporary, time-based 6-digit account in your authenticator app. Do not paste the seed into web searches, password-sharing messages, or this conversation. Delete the temporary authenticator entry after AWS cleanup.

If the secret is absent, the staging instance may have been manually stopped or `prepare` did not finish. A quick update cannot recreate a removed staging stack: start a **new full staging workflow** after verifying resource absence. No production secret, user pool, or account can substitute for this fixture.

## Real linking acceptance sequence

1. Open the **new staging CloudFront URL** in a private browser window. If you registered your own email/password staging account, sign in with that account. Otherwise use the pre-created operator fixture described above. Do not use production credentials.
2. Complete the password challenge and a TOTP challenge only if enabled for that account. For the operator fixture, use `users.mapped.email`, `users.mapped.password`, and the authenticator entry created from its `totp` seed.
3. Verify you see a working dashboard. Upload a harmless sample PDF, generate/save a quiz, and record its title and score; this provides existing history to preserve. Do not use production user data. Note: the small shared staging model-call allowance may already be exhausted by automated tests; if so, you can still test linking but must not claim that quiz history preservation was manually proven.
4. **Sign out** of the disposable password account. Use a fresh browser profile/incognito context if old Cognito sessions persist.
5. Choose **Continue with Google** using your test Google account. For this scenario it **must not already have completed account setup in this staging pool**. If it is enrolled, start a new isolated staging session; do not attempt to merge two enrolled accounts.
6. On the initial account setup screen select **Link my existing Quiz From Notes login** (**not** “Link my old account (before Cognito migration)”). Enter the disposable mapped email and an intentionally **incorrect password** once. The link must be refused without disclosing data.
7. For an MFA-on account, repeat with the correct password, then enter an intentionally **incorrect or expired authenticator code** once. The link must remain refused. Return to the choice screen as needed; verify Cancel does not attach history.
8. Repeat with the correct password and, if MFA was enrolled, the current authenticator code; review the one-time linking confirmation and explicitly accept it. If Cognito asks for an MFA method, select the offered authenticator factor and then enter the code.
9. Verify the exact saved quiz title and score created in step 3. Sign out, sign back in with **Continue with Google**, and verify the same history appears.
10. Verify the original password/MFA login still behaves as designed, and that a different account cannot read or delete the saved quiz. Avoid copying HTTP bearer tokens, Cognito cookies, or user data into logs.

**Success requires all the positive and negative assertions above, not just the Google button/callback.** Record only a pass/fail checklist or redacted screenshot. A failed or incomplete step is a release blocker for turning on Google login publicly.

## Rollback, clean-up and release boundary

**You must explicitly choose `operation=stop`** in the Full Staging workflow to delete the isolated user pool (including any email-registered test accounts), temporary fixture users, database, cache, CloudFront assets and encrypted fixture secret. There is no scheduled hourly shutdown; successful staging runs incur ongoing AWS charges until Stop completes. The workflow continues to automatically clean up failed deployments only. Verify the Stop job reports absence. Keep AWS budgets and billing alerts active. Never apply a development/staging account to production and never change `application/production`, the production release lock, or Google/OAuth activation flags based solely on staging creation working.

The production backend/frontend changes remain in [PR #537](https://github.com/HamedGithubforwork/QuizForge-AI/pull/537) and [PR #538](https://github.com/HamedGithubforwork/QuizForge-AI/pull/538); public Google login stays off until the real linking test and production release review pass.

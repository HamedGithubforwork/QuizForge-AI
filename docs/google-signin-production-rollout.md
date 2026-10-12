# Google sign-in: production release checklist (not yet authorized)

This checklist is for `quizfromnotes.com` and its existing Lightsail production deployment. **Do not equate the disposable AWS staging CloudFront URL with production.** Do not copy the staging Cognito pool, API key, temporary users, Valkey model-request allowance, Google OAuth secret, or staging environment variables to production.

## Evidence collected in disposable staging
- [x] Owner manually signed in using Google.
- [x] Owner generated quizzes from a PDF.
- [x] Owner signed out and back in and confirmed that quiz history persisted.
- [ ] A **pre-existing email/password Cognito account with history** is linked to a *separate* Google identity using the original password plus required MFA; history remains on the original application account afterward.
- [ ] Wrong password, wrong/stale MFA, cancelled linking, same-email-only and cross-user negative cases are checked against the real staging provider.
- [ ] Existing password-only accounts, account recovery and sign-out/session expiration work after Google federation is enabled.

## Source integration (not a production deployment)
- [ ] Backend dual-proof PR #537 integrated into `application/production`, with exact-head CI and PostgreSQL account-isolation tests.
- [ ] Google UI PR #538 integrated into `application/production`, after backend; confirm `VITE_COGNITO_GOOGLE_SIGNIN_ENABLED` remains default-off for normal builds.
- [ ] Security `urllib3` advisories PYSEC-2026-4175/4176/4177 resolved in both runtime and dev dependency locks. Re-run dependency security checks without suppressions.
- [ ] Release controller on `main` verified: production Cognito client with PKCE code flow, correct HTTPS callback/logout, and genuine Google provider must be present *before* the Google button can be enabled.
- [ ] Confirm the candidate's source SHA and digest references; production `release-lock.json` currently pins an older candidate, not the disposable staging frontend. No implicit promotion of `main` or `application/production`.

## AWS/Google setup
- [ ] Configure separate **production** Google Cloud web OAuth client. Google redirects to the production Cognito domain `/oauth2/idpresponse`; Cognito callback goes to `https://quizfromnotes.com/auth/callback`.
- [ ] Inject `google_oauth_client_id` and `google_oauth_client_secret` privately into the reviewed Terraform workflow. Never commit, paste in chat, or print OAuth secrets. Restricted Terraform state may contain a secret.
- [ ] Only deliberately enable `enable_google_signin` in the **production** Cognito Terraform after safe account-linking verification. This flag defaults to `false`. Verify real provider metadata and supported browser providers after apply.
- [ ] Accept Google's authentication and MFA policy: federated Google users are not required by Cognito to perform another user-pool MFA challenge. This is not a guarantee that the Google account has Google 2-Step Verification.
- [ ] Confirm token scope, revocation, cookie/session expiry, email verification, CSRF/OIDC state + PKCE, API per-user isolation and post-link history consistency.

## Release preparation, rollout and monitoring
- [ ] Verify backup snapshots/recovery drill and ensure production database backups are usable before any schema or container change.
- [ ] Use `.github/workflows/lightsail-app-stage.yml` to stage an **exact pinned** candidate inactive, not to start new production servers.
- [ ] Run `.github/workflows/lightsail-release-promote.yml` with `inspect_only=true` first and inspect the sanitized report. This is read-only.
- [ ] Check `release-lock.json` `ai_enabled` separately; it is **false** and must not be silently changed to turn on paid AI in production. A separate tested AI service/cost policy is required for that.
- [ ] Only after explicit operator approval, promote the pinned release with the built-in backup/rollback workflow and production alarms. Avoid introducing a simultaneous OAuth account migration and AI-billing change.
- [ ] Immediately run production email/password, Google, existing-account linking, data isolation, history, sign-out, and availability smoke tests; use `.github/workflows/lightsail-production-quiz-e2e.yml` as applicable.
- [ ] If any login or history regression occurs, use the retained prior release/frontend and documented rollback; do not retry a failing deployment blindly.

**Current status:** Staging Google login/quiz/history smoke is positive; production Google federation has not been verified enabled and no production promotion is authorized by this checklist.

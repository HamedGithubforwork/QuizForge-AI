# Google sign-in staging reliability audit — 2026-10-11

## Exact sources inspected

- Controller, Terraform, browser driver and private probe: `cc5fa84253cf2c077218f694a17d4608cb5cce05` on `main`.
- Backend PR #537: `af164e2569c16cbb4c2e6c9ea4d3039f04e95332`.
- Frontend PR #538: `abb01b157e2a1c35b59b112fb0cd54c55c52c63c`.
- Live run #87: <https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/38144694754>.

The workflow deliberately builds application PR commits separately from trusted
deployment code on main. The images-job log confirms the backend SHA above. The
backend file on main is **not** the backend that ran. An earlier diagnosis read
main's one-hour default and therefore missed the actual mismatch.

## Confirmed root cause and reproduction

The selected backend's `backend/redis_integration.py` defaults quiz caching to
86,400 seconds and `cache_quiz()` writes Redis `SET ... EX` with that value. Its
`test_quiz_cache_default_retains_generated_output_for_24_hours` explicitly tests
this policy. The staging ECS definition supplies no TTL override.

Main's `scripts/integrated_staging/probe.py` required a TTL no greater than 3,600
seconds. Its test populated Redis directly with the same outdated 3,600-second
fixture. Both independently green test suites therefore disagreed at runtime.

Reproduction used the actual backend `cache_quiz()` from the exact SHA, Redis
client 6.4.0, and a disposable local Redis server. The measured TTL was 86,400;
the old verifier failed. The corrected verifier accepts that same writer and
rejects non-expiring entries and lifetimes over 24 hours. No model or AWS calls
were used for reproduction. This explains run #87 without another deployment;
the original AWS log did not retain the individual key's TTL value.

The correction adds a pre-provision check inside the exact built API image,
against the CI Valkey service, using the actual backend writer and the same TTL
validator as the live probe. It checks both the configured policy and the stored
payload/lifetime. Drift now fails before AWS authentication and provisioning.

## Other findings

| Finding | Code evidence | Consequence / treatment |
|---|---|---|
| Live Google OAuth and linking are not exercised | `scripts/integrated_staging/browser.mjs` only waits for the Google button; its logins use synthetic password/TOTP users. Frontend `e2e/cognito-tests/enrollment.spec.ts` fulfills Google/Cognito and identity requests with mocks. | Passing staging does not establish a real Google callback, consent, new-account flow, or existing-account link. Keep the real-provider checklist in `docs/google-signin-setup.md`; the workflow summary now states the distinction. |
| MFA selection is unsupported in linking | PR #538 `frontend/src/lib/cognitoAccountProof.ts::parseProof` handles direct TOTP/SMS/email challenges and an explanatory MFA_SETUP rejection, but rejects SELECT_MFA_TYPE. | Reproduced with a synthetic Cognito response: “This existing-account sign-in challenge is not supported for linking.” Users who receive an MFA-choice challenge cannot link through this UI. This did not cause run #87, whose synthetic accounts explicitly prefer TOTP. Address in the existing frontend PR. |
| Cancelled runs did not select immediate cleanup | `cleanup.if` listed failures, stop and schedule, but not cancelled dependency results. | Added cancelled outcomes while preserving main-only scope and the existing exact-resource guards. The hourly backstop remains; a forcibly terminated cleanup still requires recovery. |
| Preview lifetime can be short | Hourly cleanup at minute 47 runs unconditionally; it does not wait for the two-hour edge deadline. | The deadline is a maximum access lease, not a promised two-hour testing window. A scheduled cleanup queued during a long run may remove the preview soon after it becomes ready. Existing cost-control policy is preserved. |
| Manual generation budget is very small | `generation_guard.py` allows two upstream calls total; the browser test uses at least one, and may consume the second on recovery. | Google sign-in can be checked, but a later manual quiz may hit the global test budget. This is intentional cost control, not proof that Google login failed. |
| Success summary used literal newline escapes | The embedded Python used double-escaped newline strings. | Fixed Markdown formatting and changed the title to readiness for **manual verification**. |
| Combined contracts were checked late | Main owns bootstrap/artifact/browser/probe expectations; the two PRs own the running applications. The preflight ran controller tests and application CI separately. | Earlier schema and selector fixes and this cache mismatch are distinct manifestations of cross-branch drift. The new cache-writer check closes the reproduced gap; it is not a substitute for a full provider rehearsal. |

## Authentication and data boundaries checked

Reviewed the frontend PKCE redirect/callback, in-memory sessions, provider flag,
independent password/MFA proof, identity headers/CORS, backend JWT and online
GetUser verification, five-minute proof freshness, one-use confirmations, and
database ownership/RLS logic. Linking uses independently verified subjects,
not email equality. The backend also has a PostgreSQL test for linking two
Cognito subjects without changing the existing user's history; that test was
inspected, not rerun against PostgreSQL in this local audit.

No claim is made that a Google Cloud redirect URI, consent-screen test-user
setting or actual secret value was verified by reading Terraform. The real
Google round-trip remains necessary. Required Cognito MFA on the synthetic
password users does not prove app-controlled MFA on federated Google logins;
the accepted provider-security policy is disclosed by the linking UI.

## Verification and operational state

- Local real-backend cache reproduction: old verifier fails at TTL 86,400;
  corrected validator passes. Local server: Redis 6.2 through redislite;
  CI is configured to repeat the image check against Valkey 8.1.3.
- 20 integrated-staging tests and 7 frontend-artifact tests passed locally.
- 96 backend Cognito/link-proof tests passed using the selected backend's locked
  dependencies; 13 frontend auth configuration/proof tests passed.
- Local Python was 3.12; CI uses Python 3.11.16 and the actual API/probe images.
  Docker/Valkey image execution and Terraform validation are CI gates, not
  claimed local results.
- Run #87's destroy and independent AWS absence checks succeeded.
- Public website and API health returned HTTP 200 during the audit. This does
  not establish the live application SHA; the repository release lock is not
  substituted for a live deployment inventory.
- No production configuration, OAuth credentials or AWS resources were changed
  during this audit. No new paid staging run was started.

## Required before declaring Google sign-in ready

1. Pass the corrected staging controller/image checks and a fresh staging run.
2. Complete a real Google login and callback with a designated test account.
3. Verify new-account enrollment and existing-account linking, including wrong
   password/code, cancellation, replay, and preserved history.
4. Exercise session refresh/logout and disclose Google's own session/MFA behavior.
5. Handle the MFA-choice case in PR #538 or explicitly restrict the test account
   to its supported preferred factor; do not describe the restriction as general
   support for all configured MFA combinations.

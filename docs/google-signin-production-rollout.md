# Google sign-in production rollout

Updated 2026-10-19 from the latest recorded production release-promotion run. Google federation and the Google-enabled frontend were verified at https://quizfromnotes.com/ on 2026-10-13. The host was not independently probed during this documentation update.

## Latest recorded production promotion

The latest `Permanent Lightsail existing-host release promotion` workflow run is [#82](https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/38680392878), completed on 2026-10-15 from main commit `a6d097e18334cd93ca077f8f81d38b50f000c0f9`. No later promotion run was listed as of 2026-10-19.

- Release bundle/source SHA: `84460039f45557c48cec0baf79e9e961ab96af23`.
- Reviewed application SHA: `730027a5027e7479e67ad5ddb660b32b74eab322` (application/production; PR #619).
- Previous release SHA recorded by the promotion: `4be1685ac7d1204c92b93fdaa8f02dc31f684e7b`.
- Sanitized run artifact: [promotion report](https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/38680392878/artifacts/11948165306), SHA-256 `cf03ccb02dcbf202d50eb52d000181081f527f9182fa9d2b9fbeb6c7cf6d9815`.
- The report records `production_release_promoted`, `inspection_only=false`, release and frontend switched, backup completed before switch, rollback retained, local HTTPS verified, and the baseline firewall restored. It records no DNS or AI-configuration changes.
- This records the latest successful promotion, not a fresh live health check after 2026-10-15.

The earlier Oct 13 rollout record listed application `77a060cce504008a4479deacdc31279633d0fe4f` (combined PR #579), tree `8016b2fce8056bd642bd615eef71eab106ae3800`, and release/controller commit `1bab85a588e2eb82f9f44d4b3f7ab7fcfa5ee405`. The Oct 15 promotion report records `4be1685ac7d1204c92b93fdaa8f02dc31f684e7b` as the immediately previous release.

Registered native client activation remains pinned to the reviewed application. Its existing Cognito sign-in and cloud study flows are preserved.

## Production evidence

| Check | Run/evidence | Result |
| --- | --- | --- |
| Full Google-only Terraform review | 38447777343 | Exactly Google provider creation and browser-client update; no apply in this review |
| Backend-first promotion | 38450833234 | Fresh encrypted backup, HTTPS health, retained rollback, reminders and restored firewall |
| Live backend email/MFA study smoke | 38452070729 | Sign-in, MFA, deck/card creation and review persistence passed; synthetic data cleaned up |
| Guarded Google activation | 38452558923 | Fresh live-backend evidence, exact two-resource plan, provider/client postconditions; password sign-in preserved |
| Google-enabled immutable build | 38453422745 | Successful build against the verified live Google provider |
| Final release preflight | 38455211678 | Reviewed release prerequisites passed |
| Google enablement promotion (historical) | 38455883919 | Release and frontend switched; fresh backup, local HTTPS, rollback, reminders and restored firewall verified |
| Native study/cloud sync | 38453744712 | Native PKCE login, account/deck access, refresh, offline-review replay/conflict handling and sign-out passed; synthetic cleanup passed |
| Final browser study regression | 38457117315 | Email/MFA sign-in and study persistence passed against the final release; synthetic cleanup passed |
| Public Google entry | Agent browser, 2026-10-13 | Live Google button reaches Google's sign-in screen with the production Cognito redirect |

No model calls were used by these study canaries. The Oct 13 promotion reports and Oct 15 promotion artifact record no AI-configuration or DNS changes.

The screenshot below documents the Oct 13 public Google-entry check; it predates the Oct 15 release.

![Live production Google entry](screenshots/google-signin-production.jpg)

## Remaining owner acceptance

Complete a real Google sign-in on production, including its return callback. If prompted, prove ownership of the existing **production** email/password account and its configured MFA before linking; confirm the existing quizzes remain available and persist after sign-out/sign-in. Staging account links and quiz data remain separate from production.

Real-provider Google new-account/linking/history tests were manually confirmed in isolated staging for the reviewed source. The agent verified the production provider, Google entry/redirect, email/MFA and native flows; it did not enter an owner's Google credentials or complete that final real-account callback.

## Maintenance boundaries

- Keep immutable release pins, native-client activation, fresh backup-before-switch, rollback and health checks.
- Standalone frontend repair is manual-only and shares the promotion/activation concurrency lock. A release-lock push must not publish a frontend.
- Production Terraform maintenance must explicitly preserve `enable_google_signin=true` and protected production OAuth credentials. The unconfigured module default remains false; a generic default-variable apply is not an approved production maintenance path.
- Google-only review/activation reconstructs the pinned original recovery ZIP and verifies it against the deployed digest. Changes to the recovery hook require separate review; do not ignore its code hash broadly.
- The permanent host retains `prevent_destroy` and ignores only later one-time bootstrap `user_data` changes. Use guarded host maintenance/deploy workflows.
- Keep staging credentials, pools, users, databases and callbacks isolated. Preserve the owner's manual staging Stop policy.

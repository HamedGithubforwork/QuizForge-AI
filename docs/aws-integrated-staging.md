# Integrated AWS browser rehearsal

This disposable environment joins the previously validated AWS components into a
single browser journey: private S3 and CloudFront, Cognito hosted code/PKCE login
with mandatory TOTP, the dedicated staging HTTPS ALB, separate API and account
setup Fargate tasks, private forced-TLS RDS PostgreSQL, and private TLS Valkey.

**Latest result:** the complete workflow, including private verification and
independent cleanup, passed in [run 35480531677](https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/35480531677)
on September 20, 2026. All 59 temporary resources were removed. The successful
checkpoint below supersedes the earlier incomplete attempts.

Run **AWS integrated browser staging** on `main`, operation `run`, application PR
`97`. The controller requires the existing checks to pass on that exact application
commit before building it. The application PR remains draft and unmerged.

The workflow validates real browser CORS/CSP, login/nonce/PKCE, PDF upload, a real
five-question multiple-choice quiz, 4/5 grading, source retrieval, history save
and reopening after a fresh login, deletion, explicit account enrollment, ownership isolation, invalid and
unverified identity rejection, and hosted logout with fresh token revocation and
password/TOTP required on the next login. A separate private database probe checks
that the eight original synthetic history fixtures remain unchanged.

## Isolation and credentials

- State: `quizforge/integrated-staging/terraform.tfstate`, separate from all earlier rehearsals.
- Resource prefix: `quizforge-integrated-staging`. The existing foundation is read only.
- DNS: only `staging-api.quizfromnotes.com`, using the existing issued certificate and zone. Existing records block provisioning.
- Frontend builds run on a separate runner without AWS credentials. Only public URLs and Cognito identifiers enter the build.
- Application tasks have separate database credentials and no AWS task role. The API cannot read the enrollment role's credential.
- Synthetic user passwords and TOTP seeds stay in one temporary encrypted fixture secret. The browser receives a private temporary file, no AWS environment or Docker socket, and no database credentials.
- The private setup probe alone receives the RDS owner password. Its task role can read the fixture secret and write the two restricted application credentials.
- Production Vercel, Render and Supabase services are not modified or queried. A small authorized OpenAI generation uses the existing SSM key only in a trusted loopback sidecar. Production users, paid email/SMS delivery and data migration are excluded.

## Cleanup and limits

An always-running cleanup job stops only the exact integration task families,
destroys this isolated state, then queries AWS to confirm absence of the frontend,
database/backups, Valkey nodes/subnet group/snapshots, tasks/services, load balancer/targets, Cognito pool/domain,
temporary secrets, roles, logs, security groups and staging DNS alias. The reusable
foundation, certificate, zone and reviewed ECR images are retained. Existing ECR
lifecycle rules manage stored images.

An hourly scheduled cleanup and a manual `stop` operation provide recovery after
an interrupted run. CloudFront independently stops serving the app after its
two-hour lease. The lease does not stop AWS billing: cleanup must finish and its
absence checks must pass. Temporary RDS, Valkey, ALB, Fargate and public IP resources incur
normal AWS charges while present.

The generation guard allows at most **two upstream attempts per disposable
rehearsal**, including SDK retries and validation retries. It caps each at **4,096
output tokens** and **32,768 bytes for the incoming request body**, permits only
the application model and text input, disables response storage, and rejects
expired leases. Only the guard has the real key; the unmodified reviewed API uses
a placeholder key and loopback `OPENAI_BASE_URL`. Atomic private Valkey reservations
survive task replacement; missing or unavailable budget state fails closed.
This is a request/token bound, not an AWS account spending limit.

The browser repeats the upload and quiz request, requires an identical cached quiz,
then sends eight invalid settings requests and checks the normal eleventh request
returns 429 with `Retry-After`. Invalid settings never reach the model. The private
probe checks application-created document/source-page/quiz cache entries and TTLs,
the shared rate counter, exact cache metrics, one generation pipeline and the actual
upstream attempt count. Multiple-choice grading makes no answer-review model calls.
The saved-result UI lists the score and quiz metadata; this rehearsal does not add
a UI feature to reload old questions into a new attempt.

Credentialless CI tests atomic reservations with 16 concurrent connections to a
real disposable Valkey instance, boundary guards, immutable image builds and mocked
Terraform plans. Recovery email and production rollout remain separate gates.
The first browser checkpoint below predates generation/cache integration.

## Verified browser checkpoint — 2026-09-19

[Run 35471289022](https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/35471289022)
used controller commit `5db2df20f488e1ace3ea2b6b7ff437725d8f0e63` and the checked
application PR #97 commit `26edb5d6557835060ac309595f0634d46e888bf4`. Provisioning
created 53 temporary resources at 21:55:30 UTC. The frontend was built with the
actual public CloudFront, Cognito and HTTPS API settings on a separate runner.

The live browser checks passed at 22:01:01 UTC:

- Private S3 denial, CloudFront HTTPS/CSP/routes, trusted API TLS/redirects and rejection of foreign hosts/origins.
- Real Cognito hosted code/PKCE/nonce and mandatory TOTP, followed by history save/list/render through the ALB and API into TLS RDS.
- Explicit account enrollment, cross-user history isolation, own-row deletion, rejected unverified identities and no persistent browser tokens or CSP violations.
- Hosted logout cleared the provider cookie and revoked still-valid access/refresh tokens; the next login in the same browser required password and TOTP again.

At 22:01:56 UTC, the private verification probe confirmed one used enrollment
confirmation, all eight foreign history fixtures unchanged and no browser-created
history rows remaining. No OpenAI calls or production data were used.

Terraform destroyed all **53 temporary resources** at **22:06:53 UTC**. The
original run's final absence check and its cleanup-only retry failed because RDS
still listed a snapshot record after deleting the instance. Do not describe that
original workflow run as entirely green: its browser and database jobs passed,
while cleanup needed the later independent confirmation below.

At **22:15:09 UTC**, [cleanup-only run 35472754716](https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/35472754716)
passed every independent AWS absence check, including snapshots and automated
backups. Terraform state/outputs were empty; S3 objects/bucket, CloudFront/OAC/
function/policies, ALB/targets, ECS tasks/services/active definitions, RDS and its
network resources, Cognito, temporary secrets/roles/logs/security groups and the
staging DNS alias were absent. This run created no resources. The reusable
foundation, zone, certificate/validation record and ECR images remain.

PR #118 added snapshot status diagnostics and a bounded five-minute read-only
wait, retaining strict failure for persistent backups or AWS access errors.
The snapshot entry was already gone when the successful final check ran; no
additional backup-deletion operation was needed.

The first attempt stopped before resource creation because Terraform reports a
missing state file on a brand-new backend. PR #117 added a strict S3 missing-object
check and regression coverage; access and service errors remain fatal. The
[cleanup-only run 35471210836](https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/35471210836)
verified the empty environment before the successful live retry.

Production rollout remains pending. Application PR #97 is still open and draft;
production continues on Vercel, Render and Supabase.

## Full quiz rehearsal — initial attempt

[Run 35475976574](https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/35475976574)
used controller `20693d8c69662e00ae2c3be242f46c2a0c322c4a` and the same reviewed
application commit. It created **59** temporary resources at **23:38:08 UTC on
September 19, 2026**. Live checks confirmed private encrypted Valkey, the bounded
loopback generation guard, exact Cognito/TLS/database isolation, mandatory-MFA
fixtures, the two-request budget and private RDS seeding. Hosting/authentication
and the two browser PDF uploads succeeded.

The browser stopped at quiz-setting selection at **23:43:52 UTC**, because exact
label matching did not account for wrapped select-option text. This attempt is
not a successful full-quiz validation. PR #122 adopts the application's existing
scoped select locators and checks the document fingerprint and selected answers
that accompany saved quiz data.

Automatic teardown destroyed **all 59 resources at 23:50:46 UTC**. Independent
absence checks passed at **23:50:59 UTC**, including Valkey nodes/snapshots and
RDS backups. The original run remains failed because its browser test failed;
its cleanup job succeeded. The reusable foundation, zone/certificate and ECR
images were retained.

## Full browser success; private verification incomplete — 2026-09-20

[Run 35477507194](https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/35477507194)
used controller `7cc27697e596eca29ee12c4b4e6801d3ec7b0e89` and the same application
PR #97 commit. All 59 temporary resources were created at **00:12:48 UTC**.
Live configuration, synthetic account/database setup and the model-request guard
passed at **00:15:39 UTC**.

The full browser journey passed at **00:19:02 UTC**:

- PDF upload and repeat processing, real five-question generation, deliberately
  mixed answers graded 4/5, and authenticated source-page retrieval.
- RDS save with exact quiz content, document fingerprint and selected answers;
  saved score/metadata reopened after a fresh Cognito MFA login.
- Identical cached quiz and the normal eleventh-request 429 with `Retry-After`.
- Explicit enrollment, owner isolation/deletion, unverified-user rejection,
  hosted logout, token revocation and password/TOTP on the next sign-in.
- Hosting, TLS, CORS/CSP and browser token-storage boundaries.

The subsequent private probe failed an assertion at **00:19:55 UTC**. Its original
diagnostics did not identify the assertion. Therefore this run does **not** prove
the complete private cache/fixture verification or the exact upstream-request
count, and its overall status remains failed. An offline reproduction of the
application's real cache/metric/rate code with synthetic generation passed the
same cache assertions. PR #123 adds safe checkpoint, numeric counter and failing
line diagnostics while preserving all verification requirements.

Automatic cleanup destroyed **all 59 resources at 00:26:35 UTC**; independent
absence checks passed at **00:26:48 UTC**, including RDS backups and Valkey.
The reusable foundation, zone/certificate and ECR images remain.

## Private probe diagnosis — 2026-09-20

[Run 35479035851](https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/35479035851)
used controller `a4d842c0f85548d40050d57d19c18061c9bfe381` and the same reviewed
application commit. It created 59 resources at **00:45:39 UTC**, and the complete
browser journey passed again at **00:51:32 UTC**.

At **00:52:25 UTC**, the private probe confirmed all eight original history
fixtures unchanged, no browser-created rows remaining, four internal users and
one consumed enrollment confirmation. It also confirmed the application-created
document/source/quiz cache contents and TTLs. Safe diagnostics recorded:

| Observation | Value |
| --- | ---: |
| Real upstream model requests | 1 |
| Remaining model-request budget | 1 |
| Budget TTL | -1 (non-expiring for the disposable cache lifetime) |
| Model timing samples | 1 |
| Quiz cache hits / misses | 1 / 9 |
| Quiz requests recorded | 10 |
| Document cache hits / misses | 2 / 1 |

The remaining assertion queried the rate counter using the internal history UUID.
The reviewed application's `app_shared.get_current_user` instead identifies
generation/cache users as `cognito:<pool>:<subject>`; the history repository maps
that identity separately to an internal UUID. This explains the probe failure.
[PR #124](https://github.com/HamedGithubforwork/QuizForge-AI/pull/124) corrects the
lookup and adds real-Valkey regression coverage for the correct Cognito identity,
wrong history UUID, wrong pool and missing expiry. The required count of eleven
and active ten-minute TTL remain unchanged. The application is unchanged.

Automatic cleanup destroyed **all 59 resources at 00:59:08 UTC**. Independent
absence checks passed at **00:59:20 UTC**, including RDS backups and Valkey.
The reusable foundation, zone/certificate and ECR images remain.

At this checkpoint, a final live run with the corrected probe was still required.
The local workspace/browser disconnected during the run; GitHub monitoring, code
publication and automatic AWS cleanup remained available. After reconnection,
the corrected rerun completed successfully as recorded below.

## Successful complete rehearsal — 2026-09-20

[Run 35480531677](https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/35480531677)
finished with **every job successful**. It used controller
`b70e1ab40b0a71e1947391fdc741e0aa6ed2ad96` and application PR #97 commit
`26edb5d6557835060ac309595f0634d46e888bf4`. The credentialless checks passed all
17 Python tests, four mocked Terraform tests and the reviewed image builds.

| Checkpoint | September 20 UTC | Result |
| --- | --- | --- |
| Provisioning | 01:22:11 | 59 temporary resources created |
| Complete browser journey | 01:28:32 | Passed |
| Independent private database/cache probe | 01:29:27 | Passed |
| Terraform teardown | 01:36:02 | All 59 temporary resources destroyed |
| Independent AWS absence checks | 01:38:21 | Passed, including snapshots and automated backups |

The browser verified real Cognito MFA login, repeat PDF processing, real
five-question multiple-choice generation, 4/5 grading, authenticated source
retrieval, saving the exact quiz/answers/document fingerprint to RDS and reopening
the score/metadata after a fresh login. It also passed cache reuse, the normal
429 rate response, enrollment, ownership isolation/deletion, unverified-user
rejection, logout/token revocation and browser CORS/CSP/storage boundaries.

The corrected private probe verified the **Cognito-scoped rate counter of eleven
with an active ten-minute TTL**. It confirmed document/source/quiz cache contents
and TTLs, one quiz cache hit, nine misses and ten recorded quiz requests; document
metrics included at least one hit and miss. There were no semantic answer-review
requests. Exactly **one real upstream model request** consumed one of the two
budget slots, with one remaining and no budget expiry. The guard retained its
4,096-output-token and 32,768-input-body-byte limits.

All eight original foreign history fixtures remained unchanged, all browser-created
history rows were removed, and the database held four internal users and exactly
one consumed enrollment confirmation.

AWS briefly continued listing an automated RDS snapshot after database deletion.
The existing bounded read-only wait observed it disappear at 01:38:21 UTC;
verification was not bypassed and no manual backup deletion was required.
Terraform state had no resources or outputs. S3/CloudFront resources, ALB/ECS,
RDS/Valkey and backups, Cognito, temporary secrets/IAM/logs/security groups and
staging DNS were independently confirmed absent. The reusable foundation,
zone/certificate and ECR images remain.

The full staging milestone is complete. Production remains on Vercel, Render and
Supabase; application PR #97 remains draft and unmerged. Production configuration,
source inventory, migration, recovery and cutover gates remain in the readiness plan.

See [production-readiness costs and migration/rollback steps](aws-production-readiness.md)
for the prepared next-stage review. That plan does not deploy production.

# Integrated AWS browser rehearsal

This disposable environment joins the previously validated AWS components into a
single browser journey: private S3 and CloudFront, Cognito hosted code/PKCE login
with mandatory TOTP, the dedicated staging HTTPS ALB, separate API and account
setup Fargate tasks, private forced-TLS RDS PostgreSQL, and private TLS Valkey.

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
The earlier live evidence below predates generation/cache integration.

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

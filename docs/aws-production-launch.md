# Permanent AWS launch — prepared configuration

The September 21 [permanent Lightsail configuration](lightsail-production-configuration.md) now prepares the separate host, private runtime, authentication, cost alerts and disabled AI controls. It is inactive and awaits owner settings and live acceptance.

The [isolated live AI canary](ai-live-canary.md) passed on September 21: one
five-question quiz in 6.72728 seconds with USD0.0006025 conservatively settled.
Carry that single attempt and charge into September's launch usage exactly once.
This checks the model/application/budget path on CI; it does not complete the
remaining live AWS, final-domain, recovery, migration or cutover gates.

The owner requested a lower-cost Lightsail evaluation after reviewing this
managed-stack estimate. See the [small-server capacity results](aws-small-server-capacity.md):
the September 20 real Lightsail retests passed both capacity profiles, including
the 10-page, two-scan and interrupted-recovery targets that failed earlier.
The controlled same-host comparison also supports retaining grayscale native OCR.
See the exact results and remaining launch requirements. The September 21
[backup/restore preparation](lightsail-backup-restore.md) begins the small-server
recovery work; live delivery, scheduling and full-host recovery remain pending.
The USD88 proposal below remains unapplied and is not the selected next activation
step.

Status: production preparation, not a live website. The owner selected a fully
AWS-hosted deployment after the integrated rehearsal passed. The existing
Vercel/Render/Supabase site is still active; no account data has been exported
and no production resources or application DNS have been created.

## Verified starting point

- Integrated staging passed in run `35480531677`, including independent removal
  of all 59 temporary resources.
- The September 20 read-only source inventory found PostgreSQL 17.6, three
  email-provider accounts, all email-verified, no enrolled MFA factors, eleven
  saved quizzes across two owners, one account without history, and no orphaned
  history rows. Approximately 42 KB of row JSON fits the reviewed transfer bounds.
  The sole public application table is `quiz_history`, with RLS enabled and
  ownership policies for SELECT, INSERT and DELETE. No record contents or auth
  credentials were retrieved. Recheck the inventory immediately before migration.
- AWS [inventory run 35487422363](https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/35487422363)
  verified an ACTIVE FREE account plan and the existing public domain zone.
  Only apex NS/SOA records were present. There are no production website/API
  certificates or AWS budgets yet. This rerun resolves the earlier UNKNOWN
  budget result; the SDK omits the list when no budgets exist. No credit balance,
  account identifier, notification recipient or budget amount was logged.
- Application PR127 carries the exact tested PR97 implementation forward with
  explicit production settings. It remains unmerged so legacy production keeps
  its current release. The production frontend accepts only `quizfromnotes.com`.

## Preparation validation

[PR128](https://github.com/HamedGithubforwork/QuizForge-AI/pull/128) is merged at
`a6d5611012990d1abf80d444bcdfbea184fd2d64`. Its exact final candidate passed eleven
production tests, including real PostgreSQL concurrent budget reservations and
encrypted history/identity reconciliation; six transfer tests; four Terraform
boundary tests; Terraform validation; and the operations container build in
[run 35487137071](https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/35487137071).
The subsequent [foundation run 35487368136](https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/35487368136)
validated successfully and skipped apply because foundation resource files did
not change. Production has not been applied.

The real AWS [read-only plan run 35487464165](https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/35487464165)
passed against the production state and existing foundation. It proposes 85
resources to create, zero to change and zero to destroy. The checked plan keeps
both application services at zero tasks, public signup off, and application DNS
unpublished. Its three proposed DNS records are certificate-validation records,
not website/API routing. The plan ran with explicit read-only AWS credentials
and `-lock=false`; no state or resources were written and no plan artifact was
uploaded. This establishes a concrete proposal, not permission to apply it or
proof that all services are available under the account's current Free plan.

The application candidate is pinned to PR127 commit
`d185d5a63b4506d48ff5fa3189a025c9d2541f01`. Its backend/frontend, PostgreSQL security,
browser integration, dependency audits and container-build checks passed.
Production authentication, real-user linking and final-hostname acceptance still
require the deployed environment; passing CI does not establish those results.

## Concrete resources and activation sequence

The new Terraform root is `infra/aws/production`, using only the encrypted state
key `quizforge/production/terraform.tfstate` in the existing state bucket. It
references foundation outputs and the existing zone; it does not import staging
resources or edit their cleanup workflows. Permanent names use
`quizforge-production`. The foundation deployment now checks whether its own
root resource files changed before automatically applying.

| Area | Prepared configuration |
| --- | --- |
| Website | Private encrypted, versioned S3; CloudFront OAC; exact SPA routes; canonical apex; `www` redirect; TLS certificate in us-east-1 |
| API / identity | Separate 0.25 vCPU / 0.5 GiB Fargate tasks and SQL roles; immutable images; TLS ALB at `api.quizfromnotes.com`; default host/route rejection |
| Data | Private encrypted PostgreSQL 17, db.t4g.micro, 20 GiB; forced verified TLS; seven-day backups; retained automated backups/final snapshot; deletion protection |
| Cache | One private encrypted cache.t4g.micro Valkey node; no durable user history or spending authority in cache |
| Authentication | Cognito Lite; verified email, mandatory authenticator MFA, verified-email password recovery, short-lived PKCE sessions; public signup initially off |
| Abuse / spend | One API source-IP WAF rate rule; application user limits; restricted PostgreSQL model quota; pre-credit account-wide budget notifications |
| Operations | Fourteen-day logs; five health/storage/error/cache alarms; SNS email subscription requires operator confirmation |
| Transfer | Separate private encrypted S3 bucket, AES-GCM archives, separate key secret, exact object digest, seven-day archive expiry |

The initial plan starts zero application tasks, publishes no application A/AAAA
records, and leaves signup and model spending disabled. The plan workflow has a
read-only AWS session, does not take a state write lock, does not upload the binary
plan, and contains no apply step. Its USD100 threshold and example notification
address are review placeholders, not owner-approved activation values.

After reviewing cost and notification details, create the retained infrastructure
from an exact reviewed plan. Apply the fresh schema with an explicit operations
command; the image's default command exits. Bootstrap generates separate runtime
passwords and an independent transfer key directly into Secrets Manager, with no
plaintext secret values in Terraform state or artifacts. An occupied database
refuses bootstrap rather than resetting existing credentials or user data.

## Running-cost proposal

The prior regional estimate was US$80.37/month for the small always-on layout.
This draft adds two retained secrets (model-budget role and archive key, about
US$0.80), one WAF ACL/rule (about US$6), and five standard alarms (about US$0.50).
The resulting illustrative baseline is **about US$87.67/month before traffic,
model calls, taxes and currency conversion**. One average ALB capacity unit adds
about US$6.42/month, bringing that example to US$94.09 before other variables.
Credits and Free Tier discounts have not been subtracted. Actual remaining credit
balance/expiry must be checked privately before starting permanent resources.

This is a small Single-AZ deployment with a single cache node, not a high-
availability service commitment. Deployment overlap, restore rehearsals, excess
backups, S3/archive storage and requests, logs, network transfer, Cognito/email,
WAF requests, IPv4 and model usage can add charges. The API WAF rule does not
establish DDoS capacity or protect the Cognito hosted login as an application WAF.

See [regional assumptions](aws-production-readiness.md),
[AWS WAF pricing](https://aws.amazon.com/waf/pricing/), and
[CloudWatch pricing](https://aws.amazon.com/cloudwatch/pricing/).

The selected Lightsail track records USD20/month AWS alerts and a separate
USD5/month AI allowance. The loopback gateway now reserves conservative USD
costs before model calls, as well as counting failures/retries and semantic answer
review against daily/monthly request ceilings. Valid usage settles reservations
once; missing usage keeps the maximum. See [AI cost controls](ai-cost-controls.md)
for pricing, scope, tests and recovery. The database starts disabled with zero
allowances; choosing limits does not activate it. AWS alerts do not stop charges.

## Migration and account preservation

Use `scripts/production/cloud_transfer.py upload` with a verified-TLS direct or
session-pool connection to the exact source project. IPv4-only runners may use
the Canadian session pool on port 5432, with the project-qualified username;
transaction pooling is not accepted. Source connection values/CA must be supplied
securely; the connected metadata query does not supply a PostgreSQL password.

The export reads one REPEATABLE READ READ ONLY snapshot: only user UUIDs and the
allowlisted quiz-history fields. It never copies passwords, auth tables, MFA
secrets or tokens. Encryption happens in memory; only ciphertext is uploaded,
using a content-addressed key and conditional create. No data or key goes into
GitHub artifacts, source control or logs. The operations task can read only this
archive prefix and the separate key secret. Neither application role can read it.

Run `cloud_transfer.py import --object-key imports/<ciphertext-sha256>.qfh` inside
the private VPC. It defaults to a SQL dry run. A committed import additionally
requires `--commit --expected-sha256 <recorded-export-digest>` and fully reconciles
UUIDs, all fields, canonical content, row counts and users with no history.
The private-file CLI `transfer.py` offers the same format for a controlled local
operator; it refuses symlinks, overwrites and broadly readable input files.

Before the final export, freeze all legacy history writers, including older
browser sessions, and separately freeze/reconcile Auth signups and deletions.
Record original grants, freeze time and manifests. An export taken while users
continue writing is only a rehearsal, not a valid final migration. Do not reopen
writes until destination reconciliation and the final hostname canary pass.

Existing users create and verify their Cognito account, then complete the tested
explicit linking flow with fresh proof of both identities. Imported internal
UUIDs and histories remain unchanged; email equality never selects an owner.
Keep the legacy provider available for linking and the rollback window. New users
receive new UUIDs only after public signup is deliberately enabled.

## Remaining live acceptance

1. Confirm the recurring cost/credit plan, owner alert address and AI quota.
   Do not upgrade the AWS account plan automatically if a service is restricted.
2. Confirm the source connection/CA and controlled credential delivery. Review the
   source freeze and the seven-day archive/rollback window before real export.
3. Test encrypted import/reconciliation on the provisioned target, restore an RDS
   snapshot into an isolated database, and measure recovery time and completeness.
   Proposed initial targets are RPO <=15 minutes and RTO <=2 hours; neither is a
   measured guarantee until the actual restore succeeds.
4. Verify signup, delivery, verification, TOTP, password recovery and lost-MFA
   operator handling. Cognito's default sender has a 50-email/day account quota;
   this is a low-volume launch configuration. Move to verified SES delivery before
   broader onboarding. Do not waive actual email/recovery tests.
5. Build the exact reviewed production application, publish immutable assets,
   start restricted tasks, and run a bounded final-domain canary including OCR,
   short-answer review, account linking and preserved-history ownership. Record
   budget usage and compare the final source/destination manifests.
6. Publish the domain only after those results are reviewable; then reopen writers,
   confirm alerts, and monitor. A passing preparation/plan job is not a launch.

Before AWS accepts writes, rollback can restore the unchanged legacy routing and
configuration. After AWS writes, freeze and reconcile inserts, updates and deletes
before returning to the retained source. The rehearsed reverse transfer stops on
source drift or new identities without a legacy mapping; it must never silently
discard such users. Keep AWS data and fix forward if that condition blocks a safe
legacy rollback. Restoring an old snapshot or changing DNS alone is not lossless.

References: [Cognito email delivery](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-email.html),
[Cognito quotas](https://docs.aws.amazon.com/cognito/latest/developerguide/quotas.html),
[verified-email recovery](https://docs.aws.amazon.com/cognito/latest/developerguide/managing-users-passwords.html).

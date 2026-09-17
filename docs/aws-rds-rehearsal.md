# Disposable private RDS rehearsal

This workflow rehearses synthetic quiz-history migration and snapshot recovery.
It does not change the running application, Supabase, Render, or Vercel. The
optional API mode tests a reviewed FastAPI PostgreSQL adapter PR without merging
or deploying it to production. Any production export remains separate later work.

Run **AWS private RDS rehearsal** from **main**, operation **run**. All resources
use the isolated S3 state key `quizforge/rds-rehearsal/terraform.tfstate` and the
`quizforge-rds-rehearsal` name prefix. Cleanup runs in a separate job after
success, failure, or timeout. Operation **stop** and the daily 08:05 UTC shutdown
also destroy this dedicated state. Always verify the cleanup job succeeds.

## Infrastructure and credentials

- PostgreSQL 17, single-AZ `db.t4g.micro`, encrypted 20 GiB gp3 volumes.
- Source and restored database in existing private subnets; no public access.
- Port 5432 admitted only from the existing application security group.
- TLS required by the DB parameter group and verified against the AWS regional
  CA bundle with hostname verification by the probe.
- One-day automated backup retention while running; encrypted manual snapshot
  restored into a second temporary instance after import checks pass.
- RDS generates and manages the owner password in Secrets Manager. Terraform
  handles only its ARN. ECS injects it into the isolated migration probe using a
  dedicated execution role limited to this secret, image pulls and log writes.
- The default snapshot probe has no AWS task role, runs as a non-root user, drops Linux capabilities
  and uses a read-only root filesystem. Its public-subnet ENI permits AWS image
  and secret retrieval without a NAT Gateway; the databases remain private.
- Application SQL uses a separate `quizforge_app` login with no superuser,
  database creation, role creation, schema creation or RLS bypass. Its random
  rehearsal password exists only in process memory and database authentication
storage in snapshot mode. It receives no owner credential or AWS permission.

Before either validation mode, the workflow now runs the
[encrypted history transfer and rollback rehearsal](history-data-transfer.md).
It uses synthetic Supabase-shaped source tables, preserves all user IDs and
history values, tests atomic import and rollback with source-drift rejection,
and removes its SQL fixtures before the normal seed/security checks. It runs the
same code in real PostgreSQL CI and a short private-RDS Fargate probe. No real
production export, extra persistent AWS resource or OpenAI call is added.

## Authenticated API mode

Set **backend_pr** to an open same-repository PR number targeting main. The exact
commit must pass the normal required checks, **PostgreSQL history API security**
and **Backend dependency audit**. A separate runner without AWS credentials builds
the PR image. The trusted main workflow publishes it under `rds-api-<commit>` and
pins the task to its digest; PR scripts never run on the credentialed runner.

This mode creates only the source database and seeds the same eight synthetic
history rows. It then logs in the existing dedicated Supabase canary and stores
the verified session in a disposable encrypted Secrets Manager secret. It does
not read or write Supabase quiz history, modify Auth settings or call OpenAI.

A trusted owner setup task maps that verified issuer/subject to a third internal
UUID, rotates the restricted application password and writes a separate temporary
application secret. Only this setup/verification task receives a narrowly scoped
AWS task role: read the session secret and write the application secret.

The reviewed API and trusted HTTP canary share a temporary Fargate task with no
AWS task role. The API receives only its application password and existing
Supabase URL/publishable key; the canary receives only the session bundle. Neither
receives the database owner password. Containers are non-root, read-only and drop
all Linux capabilities. The API listens on loopback within the task; no ALB or
public API listener is created. RDS remains private and TLS hostname verification
is mandatory. The API uses a one-connection pool to exercise identity reuse.

Real HTTP checks cover missing/invalid tokens, rejected forged ownership,
create/list/cursor/document access, foreign-row deletion denial, CORS and own-row
deletion. A separate trusted owner probe then proves all eight foreign fixture
rows retain their original checksum and the canary left no history rows. This
mode does not repeat snapshot restoration, which remains mandatory in the
default migration/restore mode and has its own passing AWS run.

The always-run cleanup also destroys both temporary secrets, setup/execution
roles and API task definition. AWS API checks must confirm the secrets are
absent along with databases, snapshots, backups and running tasks. The same
manual **stop** and daily shutdown cover either mode.

The restored PostgreSQL instance inherits the source snapshot's owner password;
the probe uses the source managed secret during this short rehearsal. No database
password is written to workflow output, artifacts, Terraform variables or state.

The first AWS run rejected seven-day retention with `FreeTierRestrictionError`
before creating the database. This disposable rehearsal uses one day, the
[RDS API default](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_WorkingWithAutomatedBackups.BackupRetention.html),
to keep automated backups enabled within the account's plan constraints. Zero
retention is rejected by the live configuration check. The encrypted snapshot,
restore, checksum and ownership checks are still mandatory. This is not the
production retention policy; production requires its separately reviewed
retention and recovery plan. No account-plan upgrade is performed.

## Acceptance checks

The same security probe runs against local PostgreSQL in PR CI and actual RDS
inside temporary Fargate tasks. It imports eight deterministic synthetic rows
for two users, preserving IDs, timestamps, nullable document hashes, JSON and
scores. It reconciles row counts, identities and a canonical SHA-256 checksum.

Application-role checks cover save/read/delete, equal-timestamp cursor ordering,
document-hash queries, cross-user read/insert/delete denial, forbidden UPDATE,
TRUNCATE, role/schema/table changes, and identity reset after commit and rollback
on a reused physical connection. Provider issuer/subject mapping is separate
from application user UUIDs. Transaction-local settings must always come from
verified bearer-token claims in the future backend adapter.

Only after source checks pass does Terraform snapshot and restore. The restored
database must match the same checksum and pass the same security checks. The
controller separately verifies actual AWS private networking, security-group
rules, encryption, instance size, backup settings and snapshot state.
It checks `rds.force_ssl=1` through the RDS parameter API and waits until that
parameter group is active. RDS does not expose this control-plane parameter to
PostgreSQL `SHOW`; the SQL probe separately checks `SHOW ssl`, verified TLS on
its connections, and explicit rejection of an unencrypted connection.
The API query includes engine defaults as well as user-modified parameters;
PostgreSQL 17 defaults to forced TLS, so a user-source-only query can omit it.
The effective value must still be exactly `1`, and missing or disabled values fail.

Cleanup deletes both instances, the synthetic snapshot, automated backups,
temporary task definition, execution role/policy, DB subnet/parameter groups and
DB security group. It confirms no rehearsal database, snapshot, backup or task
remains. These deletion settings are for synthetic rehearsal only; never apply
them to production or the only copy of migrated data.

## Cost estimate

AWS Canada Central price-list rates retrieved September 16, 2026:

| Item | Published USD rate |
| --- | ---: |
| PostgreSQL db.t4g.micro, Single-AZ | $0.018 per instance-hour |
| gp3 storage | $0.127 per GB-month |
| Backup storage exceeding included allocation | $0.105 per GB-month |
| Secrets Manager | $0.40 per secret-month, plus API request charges |

One source instance and one restored instance for one hour, each with 20 GiB,
are approximately $0.043 for instance time and provisioned storage using 730
hours/month. Add prorated secret/snapshot storage, short Fargate tasks, public
IPv4 time, logs, ECR storage and requests. A normal brief rehearsal is expected
to remain below $1; this is not a hard spending cap or a Free Tier guarantee.
No NAT Gateway, RDS Proxy, Multi-AZ, paid enhanced monitoring or customer-managed
KMS key is added. Retained ECR images and existing log/state storage can still bill.

Sources: [regional RDS price list](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonRDS/current/ca-central-1/index.json),
[Secrets Manager pricing](https://aws.amazon.com/secrets-manager/pricing/),
[RDS-managed passwords](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-secrets-manager.html),
[RDS snapshot restoration](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_RestoreFromSnapshot.html).

## Image isolation

Main backend workflows publish immutable 40-character commit tags. Staging and
RDS probes use explicit `staging-`, `rds-rehearsal-` and `rds-api-` tags. Foundation Terraform
now requires a main commit tag selected by the main deployment workflow; it no
longer selects the newest image regardless of purpose. This prevents test images
from becoming the default backend image.

After the API rehearsal: rehearse an authorized production-data export/import
and rollback before cutover. Application PRs remain draft/unmerged while merging
main would automatically deploy to the current production services.
# Optional Cognito authentication rehearsal

The `AWS private RDS rehearsal` workflow now accepts `auth_provider=cognito`
with a required `backend_pr` whose exact commit has passed all existing preview
checks, including PostgreSQL history security and dependency audit. Default
`supabase` behavior is unchanged. Use the draft Cognito application PR; never
merge it to deploy Render/Vercel while the production freeze remains active.

Cognito mode creates two additional temporary Terraform resources in the same
isolated RDS rehearsal state: a ca-central-1 Lite user pool and secretless
headless-test client. It requires TOTP MFA, a 14-character mixed-class password,
five-minute access tokens, token revocation and user-existence protection.
Self-service signup/recovery remain closed. Four synthetic users are created
only in that pool with notifications suppressed. There is no password export,
Supabase account change, email/SMS delivery, Plus tier, paid advanced-security
add-on, identity pool, NAT or new public database exposure.

The trusted OIDC runner verifies live pool settings, weak-password rejection,
MFA setup/login, incorrect-MFA rejection and password-attempt lockout. Tokens
and MFA secrets are never logged or put in process arguments or Terraform state.
Only temporary session tokens go into the existing encrypted rehearsal secret.
The API task receives its application DB password and non-secret pool/client
IDs, not AWS credentials or Supabase runtime values. Its trusted canary refreshes
short-lived user tokens through unsigned, user-authorized Cognito API calls.

The existing private RDS/ECS HTTP test additionally rejects ID tokens, a valid
but unmapped same-email subject and an unverified-email account. It performs
authenticated history CRUD/owner isolation, then revokes the refresh token and
requires FastAPI to reject the already-used access token. Only the primary
synthetic subject is explicitly mapped to the synthetic internal owner by the
trusted setup task. This is not automatic or production account linking.

The separate `always()` cleanup destroys the pool/client/users along with RDS,
Fargate task definitions, temporary secrets and related test resources. Absence
checks now refuse success while the named Cognito pool still exists. Manual
`operation=stop` and the daily stop also cover Cognito leftovers.

Expected short rehearsal cost remains below US$1, not a billing cap. Cognito
Lite direct-user usage may fit its current account/organization-wide 10,000-MAU
allowance; don't assume eligibility or remaining allowance. No charged SMS,
email sender setup, advanced security or quota add-ons are enabled. Existing
ECR/log/state storage can still bill. See [Cognito pricing](https://aws.amazon.com/cognito/pricing/).

Still required before production: real signup/email delivery verification,
controlled new-user provisioning, recent dual-account proof for migration
links, browser authorization-code/PKCE, recovery, and separately approved cutover.

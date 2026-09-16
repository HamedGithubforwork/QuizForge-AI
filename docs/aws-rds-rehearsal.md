# Disposable private RDS rehearsal

This workflow rehearses synthetic quiz-history migration and snapshot recovery.
It does not change the running application, Supabase, Render, or Vercel. The
FastAPI PostgreSQL adapter and any production export remain separate later work.

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
- The probe has no AWS task role, runs as a non-root user, drops Linux capabilities
  and uses a read-only root filesystem. Its public-subnet ENI permits AWS image
  and secret retrieval without a NAT Gateway; the databases remain private.
- Application SQL uses a separate `quizforge_app` login with no superuser,
  database creation, role creation, schema creation or RLS bypass. Its random
  rehearsal password exists only in process memory and database authentication
  storage. It receives no owner credential or AWS permission.

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
RDS probes use explicit `staging-` and `rds-rehearsal-` tags. Foundation Terraform
now requires a main commit tag selected by the main deployment workflow; it no
longer selects the newest image regardless of purpose. This prevents test images
from becoming the default backend image.

After this rehearsal: implement the PostgreSQL repository behind the FastAPI
history contract, validate authenticated HTTP CRUD against private RDS, then
rehearse an authorized production-data export/import and rollback before cutover.

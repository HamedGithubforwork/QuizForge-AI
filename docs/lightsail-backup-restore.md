# Lightsail backup and recovery preparation

September 21, 2026. The encrypted **application-data** backup tool is implemented
in `scripts/production/lightsail_backup.py`. It prepares the next recovery step
for the small-server candidate; it does not provision a bucket, start a schedule,
back up live data, or replace the separate production deployment requirements.

## What is recovered

One PostgreSQL repeatable-read snapshot contains all six current application and
billing tables: users (including accounts without history), every legacy/Cognito
identity mapping, all quiz-history fields, enrollment challenges, model policy,
and daily/monthly usage counters. PostgreSQL's original JSON numeric precision
and timestamps are preserved. A full content digest and a schema/security
fingerprint accompany the encrypted records. Unknown tables, privileged runtime
roles, schema drift, more than 10,000 rows in any table, or a serialized snapshot
larger than 32 MiB stop the operation. These are initial low-volume bounds, not a
general database backup format.

Restore requires a **separate freshly bootstrapped target**, built from the same
reviewed `schema.sql` and `generation_budget.sql`, with the same owner and role
names. It compares columns, constraints, indexes, policies, grants, owners,
functions, triggers and runtime role attributes before importing. Table locks,
inserts and complete row-by-row reconciliation share one transaction. Dry-run is
the default and rolls back. Committed restore additionally requires the content
digest retained independently at export. An occupied target or any reconciliation
failure leaves all application rows unchanged.

After successful reconciliation, the same transaction invalidates all restored
enrollment challenges and disables model spending. Identity mappings and usage
counters are retained; re-enabling spend requires a separate reviewed action.
Limits consumed after the backup are not recoverable from that backup. Reconcile
the lost interval before reopening generation; a daily snapshot is not a spending
ledger for requests made after that snapshot.

## Encryption and off-instance delivery

Archives use AES-256-GCM with a fresh random nonce and authenticated format
header. Plaintext exists only in process memory. Archive/key files use the existing
private-file helpers, refusing symlinks, broadly readable files and overwrites.
Keep keys separately from archives, source control and workflow artifacts, with a
tested recovery copy outside the server. Losing the sole key makes recovery
impossible. The existing migration key is not reused.

Upload accepts only an authenticated encrypted archive and the exact bucket
`quizforge-production-backups-<account>`. It checks versioning, supplies the
expected owner, server-side encryption, SHA-256 transport checksum and a
conditional create under `lightsail/<ciphertext-sha256>.qflb`. Retain the returned
object key and exact version ID outside the host. Download requires that version
and verifies its size and ciphertext digest; authenticated decryption precedes any
database connection during restore. Source data, credentials, key material and
SQL error details are omitted from command output.

This code does not create or configure S3. Before live use, provide a Canadian,
private, versioned encrypted bucket with TLS-only access, a reviewed retention
policy, and separate upload/recovery permissions. A routine uploader needs
`GetBucketVersioning` and `PutObject` on the exact destination; it must not receive
delete or restore-target database permissions. Recovery uses `GetObjectVersion`.
Object receipts and decryption keys must survive host loss independently. S3
calls are simulated in unit tests; live delivery/retention acceptance remains open.

## Operator sequence

Install `scripts/rds_rehearsal/requirements.lock` with hashes. The existing
explicit-command operations image includes this tool. Its default command still
exits. No automatic schedule is installed.

1. Generate a separate private key with `lightsail_backup.py generate-key
   --key-file /private/backup.key` and securely retain an independent recovery copy.
2. Provide PostgreSQL credentials securely, using `PGHOST=db.quizforge.internal`,
   `PGDATABASE=quizforge`, `PGUSER=quizforge_owner`, `PGPORT=5432` and
   `PGSSLROOTCERT` for a trusted CA. Verified TLS is mandatory. The future host
   configuration must provide this private DNS name and matching certificate.
   No public database port or production TLS bypass is introduced by this tool.
3. Run `lightsail_backup.py export --key-file /private/backup.key --archive
   /private/new-backup.qflb`. Retain the reported content digest and time.
4. Run `lightsail_backup.py upload --key-file /private/backup.key --archive
   /private/new-backup.qflb --bucket <reviewed-bucket> --account <owner-account>`.
   Retain its receipt. A local export alone is not an off-instance recovery point.
5. On the isolated recovery host, download the exact version with `download`,
   `--object-key`, `--version-id`, `--bucket`, `--account`, and a new `--archive`
   path. `inspect --key-file ... --archive ...` authenticates and reports metadata.
6. Bootstrap the separate database with reviewed schema and fresh runtime
   credentials. Use `PGHOST=restore-db.quizforge.internal` with its matching CA
   certificate and the same database/owner names. Run `restore --key-file ...
   --archive ...` for the dry-run. Use `--commit --expected-sha256 <export-digest>`
   only on this isolated target after checking the dry-run.
7. Validate real account login/linking and preserved history through the exact
   application candidate. Keep writers and model spend disabled until recovery,
   usage reconciliation and final-domain canary checks pass. Promote the recovered
   host only through the separate deployment procedure.

The source/restore DNS names are deliberately distinct. Verify they resolve to
different isolated hosts and that the recovery database has no application
traffic; the CLI cannot establish network separation from DNS names alone. It
never cleans, replaces or creates a database and cannot restore in place.

## Scheduled-job preparation

[Backup automation preparation](lightsail-backup-automation.md) adds a proposed
daily systemd job, authenticated off-server recovery receipts, hourly health
publication and an unapplied private S3/CloudWatch/SNS configuration. It includes
failure/staleness checks and recovery after local receipt loss. No timer or cloud
resource is activated. Cadence, retention, recipient and actual delivery still
require the launch acceptance described there.

## Verification and remaining recovery gates

The [completed rehearsal](https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/35548499673)
at implementation commit `925dfc3563cc3eeedbb10ecc978f6712ce23268c` passed **all
eleven tests with no skips** on September 21. It used two separate PostgreSQL
17.11 services with three synthetic users, three identity mappings and two quizzes.
The measured encrypted roundtrip/dry-run/committed-restore and ownership assertion
segment took 0.063 seconds; this excludes host provisioning and offsite download,
and is not a production recovery-time claim. An intentionally restricted database
reader was rejected instead of silently exporting only RLS-visible records.

`lightsail-backup.yml` runs without AWS credentials against two disposable
PostgreSQL 17 services. It verifies encrypted roundtrip, dry-run rollback,
committed restore, all durable rows (including precise JSON numbers), cross-owner
RLS, retained usage limits, disabled spending and invalidated challenges. Negative
cases exercise tampering, wrong keys, wrong S3 versions, occupied targets,
schema/RLS drift, foreign-key failure, reconciliation failure and archive bounds.
The separate production preparation workflow continues to test role isolation
and build the operations image.

This is logical application-data recovery, **not** a `pg_dump`, physical backup,
WAL archive or point-in-time restore. Reviewed SQL recreates schema/roles; new
credentials must be delivered separately. Cognito accounts/passwords/MFA remain
in Cognito. Host configuration, certificates, uploads, Redis contents and the
temporary PDF queue/cache are excluded. Users may need to reupload unfinished
documents after host loss.

Before migration, complete an actual encrypted off-instance backup/download,
full host rebuild, secret recovery and application canary, and measure end-to-end
recovery time. Choose a schedule and retention within the hosting budget and add
backup-failure and stale-backup alerts. RPO is bounded by the last successful
backup, not an uninstalled schedule; the managed RDS proposal's 15-minute target
does not transfer automatically to this design. A small synthetic database restore
does not establish a production RTO or close the full host-recovery gate.

References: [PostgreSQL transaction isolation](https://www.postgresql.org/docs/17/transaction-iso.html),
[authenticated encryption](https://cryptography.io/en/latest/hazmat/primitives/aead/).

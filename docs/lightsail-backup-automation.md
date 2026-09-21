# Scheduled Lightsail backups — deployment preparation

This candidate adds an explicit backup job, inactive systemd units and an unapplied
storage/alert Terraform root. It creates no AWS resources, sends no alert email,
installs no timer and accesses no real user data. It follows the
[encrypted application-data backup](lightsail-backup-restore.md) preparation.
Application PR127 remains draft; production routing and migration are separate.

## What runs after activation

The proposed backup timer runs daily at **04:15 UTC**, with up to fifteen minutes
of random delay. `Persistent=true` catches up once after a missed timer event.
A private nonblocking lock prevents overlapping exports. The service has a ten-minute
deadline, a 256 MiB memory limit, a 25% CPU quota and no automatic restart loop.
The exporter retains its 32 MiB snapshot limit, verified PostgreSQL TLS, read-only
repeatable-read transaction and complete schema/RLS fingerprint checks.

Each run exports and encrypts in memory, uploads a new content-addressed archive,
and then uploads an authenticated receipt to the same private versioned bucket.
Neither plaintext nor encrypted archive files accumulate on the source host.
The receipt records the archive's exact S3 version, ciphertext hash, content digest,
bucket/account and snapshot time. It contains no rows, user identifiers or filenames.
Its HMAC key is derived from the separate backup key with an explicit receipt
context. Both uploads require conditional creation, an SHA-256 checksum, expected
bucket ownership and server-side encryption in addition to archive encryption.

Success is recorded only after **both uploads return retained version IDs**.
A failed receipt upload leaves the prior successful recovery point unchanged and
marks the attempt failed; the unreferenced encrypted archive follows bucket
retention. Failed/ambiguous requests are never declared successful. SDK calls have
bounded timeouts and at most three attempts. Custom SDK endpoint overrides are
ignored by the production command.

Only a bounded, private, atomically replaced status file and lock remain locally.
The status is not the sole recovery record: the authenticated receipt is off-server.
After host loss, list receipt versions using the separate recovery principal,
select the intended point, and fetch that exact receipt version. The tool verifies
its HMAC and account/object boundaries, downloads the archive's exact version,
and authenticates/decrypts and checks its content digest before producing files.
No database connection is made by `fetch`.

## Failure, stale-backup and stopped-host detection

The health timer publishes `QuizForge/Backup / BackupFresh` once per hour. It needs
no database credentials, decryption key or S3 read permission. A value of zero
means no successful backup, a failed attempt, a snapshot older than **26 hours**,
an invalid/future timestamp, corrupt local status or an interrupted job exceeding
fifteen minutes. The systemd failure unit also marks failures that occur before
export starts, such as a missing key or invalid database configuration.

The proposed CloudWatch alarm evaluates the hourly minimum and treats missing
metrics as breaching. A stopped host or broken publisher therefore cannot keep
reporting a healthy backup indefinitely. Notifications use a dedicated SNS topic,
with the actual owner-selected email supplied only when reviewing the activation
plan. SNS subscription confirmation and a real notification test remain required.
CloudWatch evaluation and delivery introduce latency; this is not an immediate
or exactly-one-hour delivery guarantee.

## Storage and permission proposal

`infra/aws/lightsail-backups` uses Canada Central and the exact bucket
`quizforge-production-backups-<account>`. It configures private access, enforced
bucket ownership, versioning, SSE-S3, TLS-only access and conditional writes.
`prevent_destroy` and `force_destroy=false` protect against accidental Terraform
removal. No server, database, DNS record, IAM access key or policy attachment is
created by this root.

The proposed lifecycle expires current archives/receipts after seven days, and
noncurrent versions seven days after they become noncurrent. A version can
therefore remain recoverable beyond the current-object window, approximately
fourteen days for this create-only workload; lifecycle processing is asynchronous.
Do not promise deletion at an exact hour. Retain each decryption key independently
for at least the entire corresponding recovery window. Unfinished multipart
uploads expire after one day; obsolete delete markers are cleaned separately.

Three unattached IAM policies separate routine uploads, recovery and monitoring:

| Principal | Permissions |
| --- | --- |
| Backup uploader | Read bucket versioning; create archives/receipts; publish only the backup metric namespace |
| Recovery operator | List versions under `receipts/`; read exact receipt/archive versions |
| Health publisher | Publish only the backup metric namespace |

No policy grants object deletion, database mutation or key-management access.
Actual credential delivery/rotation and attachment to reviewed separate identities
are still part of permanent-host preparation. Application API/identity containers
must not receive backup keys or backup/recovery credentials.

These are proposed defaults, not an approved fixed monthly bill. S3 storage and
requests, one custom metric, one alarm and SNS notifications add usage-dependent
charges to the hosting allowance. There is no apply workflow or recurring GitHub
Action. A daily schedule implies potential data loss since the last successful
daily snapshot; it does not implement the managed-RDS proposal's fifteen-minute
RPO. Confirm cadence/retention, alert recipient, credential delivery and cost before
activation. The measured full-host RTO remains open.

## Installation and recovery sequence for a reviewed launch

1. Review the isolated state key `quizforge/lightsail-backups/terraform.tfstate`
   and a read-only plan for this root, supplying the owner's actual alert email.
   Apply and confirm subscription only as part of approved infrastructure activation.
2. Install the reviewed production Python/SQL files under `/opt/quizforge/operations`
   and `history_transfer.py` under `/opt/quizforge/rds_rehearsal`. Create
   `/opt/quizforge/backup-venv` with the locked, hashed operations dependencies.
   Create the dedicated non-login `quizforge-backup` OS account.
3. Deliver the independent backup key as root-owned mode 0600
   `/etc/quizforge/backup.key`; systemd passes it through `LoadCredential`.
   Verify recovery from the independently retained copy before enabling a timer.
   Do not generate a replacement key automatically after host loss.
4. Supply root-owned mode 0600 `/etc/quizforge/backup.env`: `BACKUP_BUCKET`,
   `BACKUP_ACCOUNT`, `PGHOST=db.quizforge.internal`, `PGDATABASE=quizforge`,
   `PGUSER=quizforge_owner`, `PGPASSWORD`, `PGPORT=5432`, `PGSSLROOTCERT`, and the
   approved scoped AWS credential source. The CA is a trusted public certificate;
   the database port remains private and must match the verified hostname.
   Provide only the metric-publisher credential source in `backup-health.env`.
5. Install the five units under `scripts/production/systemd`, validate the actual
   installed executable paths, and perform one explicit backup. On a separate
   recovery environment, list `receipts/` object versions and run:

   ```sh
   python lightsail_backup_job.py fetch \
     --bucket "$BACKUP_BUCKET" --account "$BACKUP_ACCOUNT" \
     --key-file /private/recovered-backup.key \
     --receipt-key "receipts/<ciphertext-sha256>.json" \
     --receipt-version "<retained-receipt-version>" \
     --archive /private/recovered.qflb --receipt-file /private/recovered-receipt.json
   ```

   The command outputs the authenticated content digest and snapshot time only.
   Use the existing restore dry-run and explicit committed-restore command on a
   freshly bootstrapped, isolated target. Retain the verified digest independently.
6. Test database ownership and the actual application login/history canary, measure
   the complete rebuild/download/restore time, and test both failure and missing
   heartbeat alerts. Recovery leaves model spending disabled and invalidates old
   enrollment challenges, as documented in the original restore procedure.
7. Only after those checks and activation review, enable the backup and health
   timers. Confirm the next scheduled run, an off-server receipt and alert delivery.

The prepared units are not installed or enabled by this repository or its CI.
No private values belong in source, artifacts, CLI arguments or logs.

## Verification scope

The automation tests use a local S3 HTTP protocol fixture with real boto3 request
serialization/signing, checksums, conditional creation and version reads. They
exercise local-state loss, off-server receipt discovery, wrong keys/owners,
tampering, failed uploads, concurrency, stale/future time, interrupted jobs and
bounded metric publication. This fixture is not AWS and cannot establish real
IAM, lifecycle, regional placement or notification behavior.

The dedicated CI workflow also uses two separate PostgreSQL 17 services. It exports
real synthetic rows through the scheduled job, removes local status, discovers the
receipt off-server, verifies/downloads/decrypts, restores into the separate database
and checks preserved ownership and disabled spending. No authentication-provider
or complete VM rebuild is claimed by that database exercise. Terraform tests use
mocked plans; service syntax checks do not install units or start daemons.

Live S3 delivery/download, alert delivery, key recovery, full host recreation and
the application canary remain explicit launch gates. This preparation advances
those gates without claiming that they have already passed.

References: [S3 conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html),
[CloudWatch alarms](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Alarms.html),
[systemd timers](https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html).

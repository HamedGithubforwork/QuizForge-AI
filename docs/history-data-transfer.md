# Quiz-history data transfer and rollback rehearsal

Status: executable preparation with synthetic data only. Production data has not
been exported, imported, deleted or switched. Render, Vercel and Supabase remain
the active production stack. Application PRs #85 and #91 remain unmerged.

## What is implemented

`scripts/rds_rehearsal/history_transfer.py` provides a bounded snapshot format,
authenticated encryption, atomic import, reconciliation and guarded rollback.
`transfer_rehearsal.py` exercises it against real PostgreSQL in PR CI and the
existing private RDS workflow. The executable refuses any database other than
the isolated `quizforge_rehearsal` database on loopback or the exact disposable
RDS hostname, using verified TLS on AWS. There is no production mutation CLI.

The source layout is Supabase-shaped `public.quiz_history` plus **only IDs** from
`auth.users`. The destination is `app.users`, `app.user_identities` and
`app.quiz_history`. All user IDs are included, including users with no history;
emails, password hashes, tokens, MFA factors and other auth records are excluded.
The Supabase issuer and subject map to the preserved internal UUID. Unknown or
changed mappings fail closed. This is a history migration, not an Auth migration.

Every source read runs in one `REPEATABLE READ READ ONLY` transaction. A concurrent
writer test proves the snapshot stays stable; an attempted source write is
rejected. `row_security=off` makes filtered reads fail rather than export an
incomplete subset: it does **not** grant RLS bypass or change table policies.
Source credentials must already have legitimate full-table visibility. The
rehearsal proves an ordinary RLS-filtered application login is rejected.

History fields are explicitly allowlisted; schema drift, duplicate IDs, missing
owners and oversized exports are rejected. PostgreSQL generates each row's JSON
text and imports it through a bound `jsonb_populate_record` value. Quiz JSON
numbers never pass through Python floating-point serialization. Unicode, null
hashes, nested JSON, IDs and UTC timestamps with microseconds are preserved.

A versioned archive uses AES-256-GCM with a fresh random nonce and authenticated
format header. The key is supplied separately. Wrong keys, truncated archives and
modified headers/nonces/ciphertext fail. The rehearsal keeps its synthetic key,
plaintext and ciphertext only in memory; no data/key files, GitHub artifacts,
S3 buckets or paid key-management services are created.

The current bounded implementation accepts at most 100,000 users, 100,000 history
rows and a 32 MiB serialized snapshot. It fails instead of truncating. Larger
datasets need a separately reviewed streaming format and measured resource budget.

## Import and acceptance

Import defaults to a dry run. It uses one transaction and locks destination tables
against concurrent writers with a short lock timeout. A fresh target must be
empty; an exact repeat is a no-op. Conflicting existing data is never overwritten
by a retry. Any constraint or reconciliation error rolls back users, identities
and history together. Dry run validates actual SQL inserts and reconciliation,
then rolls back everything.

Acceptance compares complete canonical snapshots and manifests: total users and
rows, per-user row counts (including zero), exact owner IDs, every history field,
JSON/timestamp values and a SHA-256 digest. This also reconciles all fields used
for document matching and cursor ordering. Existing RDS application-role probes
separately test actual cursor queries, RLS and connection identity reset.

## Rollback behavior

Keep the original consistent snapshot as the baseline. After simulated RDS writes,
export a fresh desired snapshot from RDS and verify every user still has a
preserved Supabase mapping. Rollback requires the retained Supabase users/history
to match the baseline exactly **inside the same locked transaction**. Drift blocks
the operation, preserving both versions for investigation.

The rollback applies new rows, changed rows and deleted-row tombstones together,
then performs full reconciliation before commit. It never changes `auth.users`.
New/unmapped users or a changed identity set require a separate reviewed identity
reconciliation; no account is fabricated from an email address. The real database
rehearsal tests one insert, one update and one deletion, dry run without changes,
source-drift rejection and preservation of synthetic private auth fields.

This is a transaction rollback/data-reconciliation rehearsal. Physical snapshot
restore remains a separate mandatory check in the workflow's default mode and
was previously validated on private RDS. Restoring an old snapshot after new RDS
writes is not a lossless application rollback.

## Later production-data rehearsal and cutover gates

1. Review actual source schema, volume, identity coverage and connection scope.
   Use a direct PostgreSQL connection or a reviewed session connection with
   `verify-full` and the correct source CA. Do not use browser JWT pagination as
   a full-database export. Do not copy or alter Supabase-managed auth tables.
2. Provision a fresh private staging target and a controlled encrypted delivery
   path. Decide archive ownership, key delivery, access restrictions, expiry and
   destruction before exporting real data. Never put production data or its key
   in source control, logs, chat or GitHub artifacts. These delivery resources and
   source credentials are deliberately not wired into this synthetic workflow.
3. Run the read-only export, encrypted transfer, import dry run, committed staging
   import and complete reconciliation. Test staged API ownership with authorized
   test identities; validate a backup restore and the rollback sequence.
4. Before an explicitly approved cutover, freeze **all** history writers, including
   old browser sessions that still write Supabase directly. Drain in-flight work.
   Also reconcile new/deleted Auth users and freeze signup/account deletion during
   the final copy. A consistent snapshot does not capture later writes/deletions.
5. Complete verified provisioning of identities for users created after the final
   copy before reopening signup. PR #91 intentionally rejects unknown identities;
   a one-time copy alone does not support future signups. Cognito account linking
   must also use verified provider subjects, never unverified email matching.
6. Record the baseline, freeze time, manifest, source/destination identity, approved
   commit/image, acceptance result and accountable operator. Switch only after
   explicit cutover approval and the separate HTTPS/security gates are met.
7. Keep Supabase frozen and available during the rollback window. If rollback is
   needed after RDS writes, freeze/drain RDS writers, retain a verified current RDS
   backup, export its desired state, run rollback dry run and reconcile before
   committing and routing traffic back. A drift/identity mismatch is a stop gate;
   blindly switching the adapter back would lose data.

No dual-write or change-data-capture system is introduced. Application merging,
source write freezes, production data export and production rollback are later
concrete operations, separate from this synthetic preparation.

## Running and cost

PR CI installs hash-locked dependencies and runs the full transfer rehearsal
before the existing seed/security/restore probes. In AWS, **AWS private RDS
rehearsal → main → run** now runs the same transfer probe before the existing
checks. Optional `backend_pr=91` keeps the established one-database API mode;
leaving it empty retains the two-database snapshot-restore mode.

The new probe adds one short Fargate task; it adds no persistent AWS resources,
NAT Gateway, DMS, RDS Proxy or OpenAI calls. Existing cost estimates and always-run
cleanup apply. On completion, verify successful teardown and AWS absence checks.
The probe removes only the SQL fixtures it created after its checks pass; failure
still triggers destruction of the whole disposable rehearsal environment.

References: [PostgreSQL snapshot isolation](https://www.postgresql.org/docs/17/transaction-iso.html),
[RLS read behavior](https://www.postgresql.org/docs/17/runtime-config-client.html#GUC-ROW-SECURITY),
[Supabase connection choices](https://supabase.com/docs/guides/database/connecting-to-postgres),
[AES-GCM authenticated encryption](https://cryptography.io/en/latest/hazmat/primitives/aead/).

# Private PostgreSQL migration preparation

Status: production migration design. The isolated synthetic RDS rehearsal is
implemented and validated separately; the opt-in adapter is described in
`postgres-history-adapter.md`. No production export, database switch, or paid
security service is created by this plan.

## Rehearsal infrastructure

Use a separate Terraform root/state and manual OIDC workflow in `ca-central-1`.
Read the existing foundation outputs. Use a DB subnet group spanning the existing
private subnets, `publicly_accessible=false`, and a dedicated database security
group allowing TCP 5432 only from the application security group. Keep Valkey's
6379 rule separate. No NAT Gateway is required for application-to-database access.
Run migrations and tests from a temporary ECS task in the VPC; GitHub runners
must not receive public database access.

Start with a supported small single-AZ PostgreSQL instance and a modest gp3
volume after checking current regional availability, version compatibility, and
pricing. This is a rehearsal choice; production availability is a separate
decision. Enable storage encryption at creation and TLS with CA/hostname
verification in the application. Keep automated backups enabled for the
rehearsal and demonstrate a restore before approving production. The disposable
Free-plan rehearsal uses one-day retention after AWS rejected seven days; a
production retention policy must be reviewed separately before cutover.

Use separate migration/owner and application roles. The application gets only
CONNECT, schema USAGE, and SELECT/INSERT/DELETE for history and the minimum
identity lookups; it must not own tables, create schema, grant privileges, or
bypass RLS. Keep administrator credentials out of the runtime task. Choose a
managed or rotated secret mechanism, explicitly scope task-role access, and
avoid passwords in Terraform variables/state, workflow output, or ECS overrides.

AWS documents [private VPC connectivity](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_VPC.WorkingWithRDSInstanceinaVPC.html)
and [encryption of database storage, backups, and snapshots](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Overview.Encryption.html).

## Schema and identity mapping

The current `public.quiz_history.user_id` references Supabase `auth.users(id)`.
Do not copy the Supabase-managed auth schema or remove ownership checks to make
an import succeed. Create an application-owned users/identity mapping in RDS,
preserving each existing UUID as the internal user ID. Associate Supabase issuer
and subject with that ID. Later associate Cognito subjects with the same internal
ID after a verified account migration; do not assume the Cognito subject matches
the Supabase ID and do not link accounts solely on an unverified email address.

Preserve history IDs, user IDs, timestamps, document hashes, JSON payloads, score
constraints, and the `(user_id, created_at DESC, id DESC)` pagination index. The
RDS history foreign key references the application-owned users table. Replace
Supabase-specific `auth.uid()` policies with application transaction context.
Use a verified internal user ID set with a transaction-local parameter on every
pooled transaction, parameterized queries, and owner predicates. Test connection
reuse between different users so identity cannot leak through a pool. Migration
and app roles remain separate and the app role remains subject to RLS.

## Rehearsal and migration sequence

1. Implement the PostgreSQL adapter behind the same FastAPI endpoints. Keep the
   Supabase adapter as the active production setting.
2. Recreate the RDS schema from versioned migrations. Use synthetic two-user data
   first; test list/pagination, save, delete, document identity, and denial of
   cross-user access. Exercise invalid tokens and pooled connection reuse.
3. Test an encrypted export/import of only the required identity mapping and
   `quiz_history` data into private staging. Use a consistent source snapshot.
   Never put exported user data in GitHub artifacts, logs, or source control.
4. Reconcile table and per-user row counts, primary/foreign keys, timestamps,
   document hashes, JSON checksums, and cursor ordering. Restore a backup into a
   separate temporary database and rerun the checks.
5. Before a later explicit production cutover, choose a brief write freeze or a
   separately designed change-capture strategy. A snapshot alone does not capture
   inserts or deletes made after export. The first cost-conscious option is a
   scheduled write freeze, final consistent copy, reconciliation, then switch the
   backend adapter. Do not silently dual-write without reconciliation semantics.
6. Retain Supabase for rollback. After new writes reach RDS, rollback requires
   exporting/reconciling those writes under a freeze; simply switching back would
   lose them. Record acceptance criteria and a rollback owner before cutover.

## Cost and teardown

Before provisioning, present the actual `ca-central-1` estimate for instance
hours, storage, backups/snapshots, secret storage/API calls, temporary ECS work,
logs, and any data transfer. Do not assume Free Tier covers the chosen account
or instance, or that credits impose a spending cap. Do not add RDS Proxy, DMS,
Multi-AZ, paid enhanced monitoring, or a NAT Gateway by default.

Prefer destroying a disposable rehearsal after results and required encrypted
backups have been verified. Define explicitly which snapshots must be retained
and their expiry; retained storage can continue charging. Never apply disposable
test deletion rules to production or the only copy of migrated data.

Stopping RDS is not a zero-cost permanent pause: storage and backups can still
bill, and AWS automatically restarts a stopped instance after seven consecutive
days. [AWS stopping and billing behavior](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_StopInstance.html).

## Following stages

After PostgreSQL is rehearsed: Cognito signup/login, verified bearer tokens,
password policy and MFA capability; then private S3 plus CloudFront hosting;
then Route 53/ACM with HTTPS and HTTP redirects before any AWS production traffic.
Production hardening includes replacing Terraform AdministratorAccess with
scoped IAM, WAF rate rules, Shield Standard, application/login limits, alarms,
CSP/security headers, container/dependency scans, encrypted stores, and tested
backups. Price paid services before enabling them. Keep current
Render/Vercel/Supabase production unchanged until explicitly authorized.

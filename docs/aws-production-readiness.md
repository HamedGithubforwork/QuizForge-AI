# AWS production-readiness plan

Prepared September 19, 2026; evidence updated September 20. This is a review plan, not a production deployment.
Production remains on Vercel, Render and Supabase. Application PR #97 remains
draft and unmerged. Live rehearsal evidence is in [integrated staging](aws-integrated-staging.md).

The current lower-cost track targets approximately USD15–20/month. The
[real Lightsail retest after the PDF fix](aws-small-server-capacity.md#real-lightsail-retest-after-the-pdf-fix)
passed both profiles on September 20, including sustained processing and bounded
restart recovery/cleanup. Its temporary USD12/month-bundle server was deleted
and absence confirmed. This clears the measured capacity gate for the candidate.
Production launch still requires the self-hosted configuration, backup/restore,
spending controls, identity/data migration and domain gates below. Application
PR127 remains draft. The managed-service estimate below remains an unapplied
alternative; the small-server allowance is not a fixed bill or a live deployment.

The [PDF optimization retest](aws-small-server-capacity.md#real-lightsail-retest-of-the-pdf-optimizations)
also passed both capacity profiles and confirmed deletion at 20:09:03 UTC. Its
mixed cross-run OCR timings did not establish a grayscale speed benefit. The
subsequent [controlled same-host comparison](ocr-controlled-comparison.md#completed-controlled-result)
now supports retaining grayscale: native OCR used approximately 10% less elapsed
and CPU time, won all six pairs in each profile/corpus and produced identical
text on the synthetic fixtures. The unchanged full capacity suite also passed;
its controller confirmed instance absence at 21:02:32 UTC. This is not a measured
10% whole-request improvement and does not identify the earlier slowdown's cause.
The 24-hour cache and page-selection semantics passed application checks; this
unchanged hardware workload does not separately measure their benefits. PR127
remains draft and unmerged; no production setting or public routing was changed.

The complete integrated staging workflow passed on September 20, including the
corrected private rate-counter verification and independent AWS teardown. The
production decisions and acceptance gates below remain pending.

The September 21 continuation adds [encrypted Lightsail application-data backup
and isolated restore preparation](lightsail-backup-restore.md). It preserves
identity mappings, quiz history and usage counters and reconciles a fresh target
transactionally, with model spending disabled after recovery. The separate
[PostgreSQL rehearsal](https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/35548499673)
passed all eleven tests. Live off-instance delivery, scheduled
backups/alerts, key recovery and a measured full-host rebuild remain open; this
does not close the production recovery gate or activate permanent infrastructure.

The next preparation adds [scheduled off-server backups and health alerts](lightsail-backup-automation.md):
a daily job, authenticated remote receipts, failure/staleness checks, mocked
private storage/permission plans and a synthetic off-server restore into a separate
PostgreSQL target. These files remain inactive; no paid resource or notification is
created. Real delivery/alerts, independent key recovery, full-host rebuild and the
application canary remain open before production migration.

## Running cost before a cutover

An always-on copy of the small rehearsal architecture would cost approximately
**US$80.37/month before traffic, AI usage and the other variable charges below**.
This uses 730 hours/month, Canada Central on-demand Linux/x86 prices, two Fargate
tasks at 0.25 vCPU/0.5 GiB each, one Single-AZ database and one cache node. It is
a sizing illustration, not a high-availability production recommendation or a
quote for the current account's bill. No credits, Free Tier or commitments are
subtracted. These resources are not being left running by the rehearsal.

| Component | Rate and assumption | Estimated USD/month |
| --- | --- | ---: |
| API + identity Fargate tasks | 2 × 730 × (0.25 × $0.04456/vCPU-hour + 0.5 × $0.004865/GiB-hour) | 19.82 |
| PostgreSQL db.t4g.micro | 730 × $0.018/hour | 13.14 |
| RDS gp3 storage | 20 GiB × $0.127/GiB-month | 2.54 |
| Valkey cache.t4g.micro | 730 × $0.0144/hour | 10.51 |
| Application Load Balancer | 730 × $0.02475/hour | 18.07 |
| Public IPv4 | Illustrative minimum four addresses: two tasks + two ALB zones, 730 × $0.005 each | 14.60 |
| Database secrets | Three credentials × $0.40/secret-month | 1.20 |
| Existing Route 53 zone | One hosted zone | 0.50 |
| **Subtotal from unrounded amounts** | | **80.37** |

One average ALB capacity unit adds **$6.42/month** at $0.0088/LCU-hour.
Additional/scale-out IPv4 addresses add $3.65/address-month. CloudFront/S3 traffic
and requests, DNS queries, Cognito/email, logs, ECR/state storage, excess backups,
secret API calls, RDS CPU credits, cross-zone/data transfer and OpenAI requests
are additional and depend on usage. Taxes and currency conversion are excluded.
The small Single-AZ database and single-node cache have availability limits;
replicas, larger tasks, private-task NAT/endpoints, WAF and longer retention would
change this estimate. No NAT gateway is assumed in the table.

Rates were retrieved directly from AWS's regional price lists on September 19:
[ECS/Fargate](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonECS/current/ca-central-1/index.json),
[RDS](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonRDS/current/ca-central-1/index.json),
[ElastiCache](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonElastiCache/current/ca-central-1/index.json),
[ALB](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSELB/current/ca-central-1/index.json),
[IPv4](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonVPC/current/ca-central-1/index.json),
[Secrets Manager](https://aws.amazon.com/secrets-manager/pricing/) and
[Route 53](https://aws.amazon.com/route53/pricing/).
Regional list publication dates range from September 11–17, 2026.

Before choosing a permanent layout, compare these costs with the existing stack
and check actual AWS credit balance/expiry. Keep staging stopped between runs.
Set a reviewed monthly budget and alerts, plus application model-usage ceilings;
alerts alone are not an automatic spending stop. The two-request staging guard
is deliberately unsuitable as a production quota. No paid commitment is proposed.

## Existing users and history

1. Inventory the real source schema, user/history counts, supported sign-in
   methods, MFA/recovery requirements, PostgreSQL version/extensions, roles/RLS
   and current write paths using authorized read-only access. Use a verified-TLS
   direct or session connection for the consistent export. No production export
   has occurred in this rehearsal.
2. Adapt the existing [encrypted history transfer rehearsal](history-data-transfer.md)
   into a separately reviewed production-capable tool. Its current executable
   deliberately accepts only the disposable database. Preserve internal UUIDs,
   every history field and users with no history; require full reconciliation.
3. Use the reviewed explicit account-linking flow with recent proof of both
   identities. Matching email addresses alone must never join accounts. Do not
   copy Supabase password hashes, MFA secrets or auth tables. Resolve enrollment,
   verified email, signup and recovery behavior for existing and new users.
4. Rehearse an encrypted production-shaped transfer, dry run, restore and rollback
   in an isolated target after the data handling scope is approved. Keep keys
   separate and exclude credentials/data from logs, artifacts and source control.
5. Before final copying, freeze every history writer, including older browser
   sessions writing directly to Supabase. Freeze or reconcile signup/deletion,
   drain in-flight writes, import atomically and compare counts, ownership and
   complete content digests. A consistent export alone does not capture later edits.

The [current Supabase transfer guidance](https://supabase.com/docs/guides/self-hosting/restore-from-platform)
distinguishes database migration from auth-provider settings, email, storage and
functions. This project uses its allowlisted history/identity-ID transfer into
RDS; a full Supabase system-schema restore is not the proposed migration.

## Production hardening and acceptance

- Create separate production state/resources with deletion protection, retained
  backups/final snapshots, a measured restore procedure and agreed recovery
  targets. Never reuse disposable cleanup policies or the hourly staging stop job.
- Review the current GitHub OIDC deployment policy, restrict production mutation
  scope, pin images to approved digests, separate execution/task roles and define
  secret rotation. Preserve API/identity database-role isolation and forced TLS.
- Configure exact production domains, TLS certificates, Cognito callbacks/logout,
  CORS and CSP. Validate public signup, verified email, hosted recovery and lost-MFA
  support against the production configuration, with an approved delivery setup.
- Add operational alarms for errors/latency, task availability, RDS capacity,
  cache failures/eviction, authentication failures and model spend. Set log
  retention and redaction. Exercise Redis outage behavior: the application falls
  back to per-process limits, so it does not retain a global limit during outage.
- Decide WAF/request-size/rate rules and abuse response within the cost budget.
  A small functional test does not establish DDoS capacity or performance at load.
- Run a bounded load test and a full production-configured canary, including
  authentication, PDF extraction, generation, grading, ownership and recovery.
  The current integrated quiz test covers selectable text and multiple choice;
  OCR, short-answer semantic review and recovery have separate validation paths.

## Cutover and rollback sequence to review

Record immutable old/new frontend and API versions, DNS records, configuration,
the migration baseline and named rollback triggers before starting. Keep the old
stack and source data available for the agreed rollback window.

After a separately approved change window: freeze writes, take the final export,
import/reconcile, deploy the already-reviewed production configuration, run the
canary through the final hostname, then reopen writes and monitor. Stop for any
ownership mismatch, failed reconciliation, authentication/recovery failure or
agreed error/latency threshold. Production DNS changes and data mutation need
their own concrete review; this document does not authorize them.

Before new AWS writes, rollback can restore the old routing and application
configuration against the unchanged source. After new AWS writes, freeze writes
again and reconcile inserts, updates and deletion tombstones back to the retained
source using the guarded baseline comparison. Source drift or unmapped new users
blocks automatic rollback. Validate ownership and counts before reopening writes.
Restoring an old RDS snapshot or changing DNS alone is not a lossless rollback.

The next implementation milestone after the integrated rehearsal is a reviewed
production configuration and read-only source inventory, with cost and recovery
choices made explicit. Actual user migration and public cutover follow only after
those results are reviewable.

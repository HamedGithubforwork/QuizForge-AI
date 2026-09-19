# AWS production-readiness plan

Prepared September 19, 2026. This is a review plan, not a production deployment.
Production remains on Vercel, Render and Supabase. Application PR #97 remains
draft and unmerged. Live rehearsal evidence is in [integrated staging](aws-integrated-staging.md).

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
   methods, MFA/recovery requirements and current write paths using authorized
   read-only access. No production export has occurred in this rehearsal.
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

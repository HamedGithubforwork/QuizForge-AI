# Permanent Lightsail configuration — prepared, inactive

This is the selected small-server track. The separate `infra/aws/production`
managed-stack root remains an alternative and must not be applied for this
launch. This branch is stacked on backup PR154; application PR127 remains draft.
No resources, account migration, domain records or model calls are activated by
these files or their CI. The deployment candidate must contain both branches.

The owner approved a **USD20/month AWS alert budget** on September 21, 2026.
The release template now records that choice: actual-cost alerts above USD10,
USD16 and USD20, plus a forecast alert above USD20, across the AWS account before
credits. This is an alert threshold, not a spending cap or resource activation.
The owner selected the alert recipient on September 21, 2026. The address is
saved privately in `quizforge-production-settings.json` with the approved
budget; the public release template deliberately keeps `alert_email` blank.
The AI allowance remains unselected, and alerts are not active yet.

## Concrete configuration

| Part | Prepared configuration |
| --- | --- |
| Host | Canada Central, Ubuntu 24.04, `small_3_0`: 2 GB RAM, 2 vCPU, 60 GB disk; retained static IPv4 |
| Public ports | HTTPS/HTTP; SSH only from one explicit operator IPv4 `/32`; IPv6 disabled |
| Website | `quizfromnotes.com`, static frontend served by Caddy with automatic HTTPS |
| API | `api.quizfromnotes.com/api/*`; one Uvicorn worker; isolated background PDF processing and durable cached selections |
| Account linking | Separate identity container and SQL role; exact legacy-account proof remains required |
| Database | PostgreSQL **17**; private Docker alias `db.quizforge.internal`, loopback-only host port; mandatory TLS and verified private CA |
| Cache | Redis private to Docker; 32 MiB application cache; no persistence or public port |
| Model access | Separate gateway and SQL role; only gateway receives model key; durable request policy initially disabled |
| Authentication | Retained Cognito pool, PKCE, required authenticator MFA, verified email recovery and password-reset global sign-out hook; public signup initially disabled |
| Recovery | PR154 encrypted off-server application backups and missing-backup alerts; operator recovery credentials and key kept off-host |
| Cost alerts | Account-wide AWS cost before credits; actual 50/80/100% and forecast 100% notifications |
| Host alerts | Five-minute local API/identity/disk heartbeat; missing or unhealthy samples alarm externally after two periods |

AWS currently lists the selected IPv4 server bundle at **USD12/month**, including
2 GB RAM, 2 vCPU, 60 GB disk and 3 TB transfer. Backups, alarms/metrics, DNS,
authentication, storage/requests, excess transfer and AI usage add to this; the
earlier USD15–20 allowance is an estimate, not a cap. Recheck the account's active
bundle, plan, credits and regional availability before an activation plan.
[AWS Lightsail pricing](https://aws.amazon.com/lightsail/pricing/), checked September 21, 2026.

AWS Budgets sends alerts; it does not stop the server. AI controls count upstream
attempts (including retries and semantic answer review), not quizzes or dollars.
They retain the reviewed model, input/output bounds and persistent daily/monthly
reservations. Disabled, missing or unavailable budget state blocks model calls.
An owner-selected request allowance and a provider spending limit need separate
review before enabling AI; no example quota is treated as approved.

## Resource and storage limits

The six containers have a combined 1,248 MiB maximum; the existing backup job adds
256 MiB. All belong to `quizforge.slice`, capped at 1,536 MiB with no swap. Install
`backup-slice.conf` as the backup service's systemd drop-in. The separate health
job has a 64 MiB cap. Docker has bounded 5 MiB × 2 logs per container. PostgreSQL
uses 20 connections, 32 MiB shared buffers and 2 MiB work memory. Only database,
PDF job, and certificate directories are writable persistent mounts. The PDF
store keeps the previously tested expiry, ownership and space bounds.

The earlier capacity result applies to the tested synthetic stack; these exact
per-container limits and concurrent backup overhead still require the live
acceptance test before launch. A single host has downtime during failure or
maintenance. This configuration is not high availability or point-in-time recovery.

## Prepare the release, without activating it

1. Use the approved USD20 monthly AWS alert budget and copy the selected alert
   email from the private `quizforge-production-settings.json` into the private
   release configuration. Supply the owner-selected daily/monthly model-attempt
   limits, operator SSH public key and current operator `/32`. Keep the SSH
   private key outside Terraform and the completed release configuration out of
   Git. `release.example.json` records the approved budget; its blank email is a
   public placeholder, and the AI allowance is still unselected.
2. Package the existing tested Cognito recovery hook with
   `python scripts/production/lightsail/package_recovery.py`. Initialize the new
   Terraform root with a **separate** encrypted state key
   `quizforge/lightsail-production/terraform.tfstate`, state locking enabled.
   Backups retain their independent state. The root does not read the managed
   stack or create application DNS records. Its host, key, static IP and pool have
   Terraform deletion prevention; AWS operators still need guarded permissions.
3. Validate and review the unapplied resource plan. The only Terraform inputs are
   the selected budget, recipient, public SSH key and `/32`; signup defaults off.
   Do not reuse the disposable test role, cleanup schedules or broad old managed
   production deployment workflow. There is intentionally no apply workflow.
4. After separately approved provisioning, take the actual pool/client IDs and
   auth origin from outputs. Build the frontend with `scripts/production/build.py`
   and the reviewed public configuration. Build API from PR127 including
   `807a4084237f6db544620cdb8322108ebf52251c`, and operations from this branch. Record
   exact release SHAs and immutable image digests. Build `caddy.Dockerfile` with
   `CADDY_BASE_IMAGE=docker.io/library/caddy@sha256:REVIEWED_DIGEST` and retain its
   resulting ECR digest. This removes the upstream binary's unused file
   capability so it can run on 8080/8443 with all runtime capabilities dropped.
   Pin verified PostgreSQL 17, Redis and Caddy images for Linux amd64; the generator never accepts a mutable
   tag. Check the image's expected UID (PostgreSQL/Redis 999) before release.
5. Run `python scripts/production/lightsail/render.py release.json NEW_DIRECTORY`.
   The renderer validates the public settings and every digest, writes private
   files without overwriting existing releases, and contacts no cloud service.
   Move Terraform input files only to their matching roots, never interchange
   production and backup state. Applying the rendered AI policy still leaves
   `enabled=false`.

## Host installation after provisioning approval

The secret-free cloud-init script installs Docker/Compose and SSH hardening only.
Verify its completion, host SSH fingerprint through an independent trusted AWS
channel, cgroup v2/systemd, disabled swap, package versions and installed security
updates. Compose must support raw environment files (2.30+) and dependency restart.
Do not put secrets in user-data, Terraform variables/state, PRs or command arguments.

Create `/etc/quizforge` mode 0700 and `/var/lib/quizforge` as the persistent parent.
Create the postgres subdirectories owned by UID/GID 999, and PDF/Caddy data
directories owned by UID/GID 10001, each mode 0700. Nonsecret mounted Caddy and
PostgreSQL config files need mode 0644; the rendered compose and decision files
stay 0600. Install release files under `/opt/quizforge/releases/RELEASE_SHA` and
make `/opt/quizforge/current` point to the reviewed release. Deliver the frontend
to `/opt/quizforge/frontend`, readable by UID 10001.

Issue a database server certificate with SAN `db.quizforge.internal` from an
operator-controlled private CA. Deliver `server.crt`, `server.key` (0600, UID 999)
and a separately generated private `owner-password` (0600, UID 999) under
`/etc/quizforge/postgres`. Deliver only the CA certificate at
`/etc/quizforge/db-ca.pem` (0644); retain the CA signing key off-host. Put
`127.0.0.1 db.quizforge.internal` in the host hosts file for backup/operations.
Certificate expiry/rotation belongs in the operator maintenance calendar.
The restore host uses its separately reviewed hostname/certificate, never an
in-place restore of the live database.

Start only DB/cache after the relevant activation approval. On a fresh database,
run `lightsail_initialize.py` as the operator using `PRODUCTION_DATABASE_TARGET=lightsail`,
`PGHOST=db.quizforge.internal`, `PGDATABASE=quizforge`, `PGUSER=quizforge_owner`,
and the explicit `PGSSLROOTCERT`. It reads the owner password from the private
file, creates the reviewed schema and writes distinct mode-0600 runtime env files.
It refuses existing schema/credentials and never enables spend. On partial
failure, preserve files and reconcile the SQL transaction before retrying.
It requires the locked operations Python dependencies installed outside the
containers, also used by the prepared backup service.

Combine the generated `generation-db.env` password and separately delivered
model key into root-only `generation.env`; API gets only `api.env` and identity
only `identity.env`. The API receives a nonsecret gateway marker instead of the
model key. No application container receives AWS credentials, owner password,
backup key, Docker socket or another container's environment file. Containers
have separate process namespaces; only the loopback gateway shares API networking.
Root/Docker administrators remain trusted host operators.

Install the existing backup units, dedicated OS users, private CA/password/key
and scoped uploader/health credentials using the [backup runbook](lightsail-backup-automation.md).
The backup uploader has no read/delete rights; recovery authority and an
independent copy of the encryption key stay off-host. Install the host-health
script/unit/timer with a separate `quizforge-health` user and **metric-only** AWS
credential in `/etc/quizforge/host-health.env`; it needs directory traversal to
`/var/lib/quizforge` for disk statistics, but no database/data-file read access.
Store only a root-readable environment file, loaded by systemd. Lightsail does
not receive an EC2 application instance role in this configuration. Create/deliver
and rotate narrowly scoped credentials as a separate reviewed operator action;
Terraform creates policies only, never access keys. Keep backup and host-health
credentials separate and do not grant them administrative IAM authority.

Preload reviewed images using an operator's short-lived ECR session; remove the
registry login afterwards. Install the inactive service/slice and health units.
Create `/etc/quizforge/launch-approved` and enable/start units only in the accepted
launch sequence. Reboot startup is gated by this marker. Once Compose has created
containers, their restart policy can restart them automatically: removing the
marker alone does **not** stop a running deployment; explicitly stop containers.

## Acceptance and release gates

CI checks the offline Terraform plan, invalid inputs, role/transport boundaries,
service definitions and a real Docker startup/restart with synthetic PostgreSQL
TLS, real API/identity images and disabled generation. It verifies wrong hostname
and plaintext database connections fail, origin-less identity access fails, the
gateway returns 429 without an upstream model request, and Caddy validates.
CI substitutes disposable local image tags only inside its test harness.

Still required before the permanent public launch: exact-host capacity plus
backup concurrency; live off-server backup/recovery/alarms and confirmed SNS
delivery; final HTTPS and hostname checks; signup/MFA/email/password recovery;
real model quality/speed under the approved quota; reconciled account/history
migration and rollback. Host heartbeat checks local routes and disk capacity;
it does not prove public DNS/TLS, user authentication or model availability.
Existing JWTs can remain usable until their short configured expiry after
provider revocation; do not represent the recovery hook as immediate invalidation
of already-issued locally verified JWTs.

No domain cutover, user-data transfer, paid provisioning or merge is authorized
by generating or validating this configuration. The AI request allowance still
needs an owner decision (or leave AI disabled). The monthly AWS alert budget is
approved at USD20, and the selected alert inbox is saved privately.

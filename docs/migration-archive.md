# 2026 AWS / Supabase migration archive

The completed 2026 migration and one-time cutover tooling was removed from `main`
after the production Lightsail/Cognito migration completed.

The complete pre-cleanup repository is preserved on:

- branch: `archive/aws-migration-2026-09-26`
- commit: `43894cc78eaa4b7da94fd4375bd929d64addca6b`

That branch contains the Supabase schema history, Supabase-to-PostgreSQL transfer
tools, Supabase-auth-to-Cognito import tooling, migrated-user activation helpers,
one-time MFA/OIDC/SSH diagnostics, and their migration-only GitHub Actions
workflows.

## Intentionally retained on main

Do not treat every legacy-looking file as disposable. The production release still
contains a legacy Supabase compatibility path used by the currently pinned
application candidate, so the frontend Supabase adapter/package and the public
legacy-provider build configuration remain on `main` until that compatibility
path is deliberately retired.

Ongoing production deployment, Cognito, SMS MFA, backups, disaster recovery,
cost controls, current canaries, and the active production recovery primitives
remain on `main`.

## Pre-launch and repair tooling

The same archive branch also preserves completed one-time Lightsail activation,
repair, bootstrap diagnosis, runtime initialization, public-launch readiness,
DNS cutover, and launch-failure diagnostic workflows. These were removed from
`main` after launch because several were intentionally pinned to the original
pre-launch source blobs and had begun producing irrelevant post-launch failures.

Ongoing deployment and recovery paths remain separate and active.

The obsolete pre-launch planning/rehearsal guides for disposable ALB/ECS/CloudFront staging, the RDS rehearsal, legacy history transfer, and superseded AWS production-readiness/launch plans were also removed from `main`. They remain available on the archive branch for historical reference without being presented beside current operating documentation.


## Staging, rehearsal, and legacy-provider tooling

The pre-cleanup archive branch also preserves the disposable AWS staging,
Cognito-browser rehearsal, RDS rehearsal, temporary Lightsail capacity-test,
legacy Vercel/Render smoke-test, and one-time domain setup tooling. These paths
were removed from `main` after the permanent Lightsail/Cognito production stack
was live and its recovery/canary paths were established. A later cleanup also
removed the residual `scripts/cognito_browser/` rehearsal source and its dedicated
rehearsal guide from `main`; the acceptance evidence it produced remains where it
is still cited by the retained production acceptance record.

The shared production Python dependency lockfile and database CA bundle remain under `scripts/production/`. The completed encrypted-history transfer implementation was subsequently retired from `main` after cutover and remains recoverable from this archive branch. The obsolete `scripts/rds_rehearsal/` directory is no longer required on `main`.


## Completed one-time production operations

The archive branch also retains the one-time AI activation, first-production-backup
bootstrap, cached-page backend hotfix, and first-backup diagnostic controllers.
Those workflows were removed from `main` after their production changes were
established. Remaining maintenance workflows now require explicit manual dispatch
for cloud-mutating staging, recovery, trust-probe, backup activation, and production
canary operations instead of running merely because their controller code changed.

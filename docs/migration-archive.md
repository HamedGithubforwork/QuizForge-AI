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
cost controls, current canaries, and the general production transfer/recovery
primitive remain on `main`.

## Pre-launch and repair tooling

The same archive branch also preserves completed one-time Lightsail activation,
repair, bootstrap diagnosis, runtime initialization, public-launch readiness,
DNS cutover, and launch-failure diagnostic workflows. These were removed from
`main` after launch because several were intentionally pinned to the original
pre-launch source blobs and had begun producing irrelevant post-launch failures.

Ongoing deployment and recovery paths remain separate and active.


## Staging, rehearsal, and legacy-provider tooling

The pre-cleanup archive branch also preserves the disposable AWS staging,
Cognito-browser rehearsal, RDS rehearsal, temporary Lightsail capacity-test,
legacy Vercel/Render smoke-test, and one-time domain setup tooling. These paths
were removed from `main` after the permanent Lightsail/Cognito production stack
was live and its recovery/canary paths were established.

The shared production Python dependency lockfile, database CA bundle, and encrypted-history transfer primitive now live under `scripts/production/`; the obsolete `scripts/rds_rehearsal/` directory is no longer required on `main`.


## Completed one-time production operations

The archive branch also retains the one-time AI activation, first-production-backup
bootstrap, cached-page backend hotfix, and first-backup diagnostic controllers.
Those workflows were removed from `main` after their production changes were
established. Remaining maintenance workflows now require explicit manual dispatch
for cloud-mutating staging, recovery, trust-probe, backup activation, and production
canary operations instead of running merely because their controller code changed.

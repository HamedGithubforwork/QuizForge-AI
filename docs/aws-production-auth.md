# Production authentication configuration

This opt-in application candidate follows the complete staging rehearsal of
PR97 at `26edb5d6557835060ac309595f0634d46e888bf4`. It does not change the default
Supabase provider or deploy production by itself.

The production build sets `VITE_AUTH_PROVIDER=cognito` and
`VITE_COGNITO_ENVIRONMENT=production`. Do not set `VITE_COGNITO_STAGING`.
Use the actual production pool/client IDs, the AWS-hosted Canadian Cognito
domain, canonical website `https://quizfromnotes.com`, and
`https://api.quizfromnotes.com` for both API and identity endpoints.
Set the existing source project's publishable key and
`VITE_SUPABASE_URL=https://vfxmsvphgcaizqnbyjip.supabase.co` for account linking.
The build rejects foreign endpoints or a conflicting staging flag.

The separate identity service sets `IDENTITY_ENVIRONMENT=production`, the exact
canonical website in `IDENTITY_ALLOWED_ORIGIN`, source URL/publishable key in
`IDENTITY_SUPABASE_URL` / `IDENTITY_SUPABASE_PUBLISHABLE_KEY`, and the dedicated
production RDS endpoint/database `quizforge`. The main API uses its own restricted
SQL role and `AUTH_PROVIDER=cognito`, `HISTORY_BACKEND=postgres`. Neither process
receives an AWS task role or the other's database password.

Existing users create/verify a Cognito account and then prove their existing
account with a fresh Supabase password sign-in (and existing MFA if present).
The explicit confirmation binds that verified provider subject to the imported
internal UUID. Email equality never selects a history owner. New users select
an empty account; they receive a fresh internal UUID and no imported history.
Do not delete the legacy identity provider until all required existing accounts
have linked and the rollback window has closed.

Before publishing: reconcile the history import, test signup/email verification,
authenticator enrollment, password recovery, old-account linking, fresh-login
history access, isolation and logout. Lost-authenticator recovery requires an
operator process that verifies ownership independently; an email match alone
must never trigger MFA removal. Archive release images and retain the source
snapshot before any traffic change.

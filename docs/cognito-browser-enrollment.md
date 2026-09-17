# Staging Cognito browser and account enrollment

This is an unmerged application preparation step, based on draft PR #95. Keep
Supabase as the production provider. Merging application changes to main can
deploy Render/Vercel; do not merge during the production freeze.

## Browser contract

The default build uses the existing Supabase screen and session behavior. A
separate build must explicitly set all of:

```
VITE_AUTH_PROVIDER=cognito
VITE_COGNITO_STAGING=true
VITE_COGNITO_USER_POOL_ID=ca-central-1_<disposable-pool>
VITE_COGNITO_CLIENT_ID=<public-OAuth-client>
VITE_COGNITO_DOMAIN=https://<prefix>.auth.ca-central-1.amazoncognito.com
VITE_API_URL=https://<staging-api>
VITE_IDENTITY_API_URL=https://<staging-identity-service>
```

For local browser tests, HTTP localhost/127.0.0.1 API origins are accepted.
Public HTTP endpoints are rejected. The current public HTTP staging ALB is **not**
a suitable browser authentication deployment. Use a private test tunnel with
localhost endpoints or finish the staging HTTPS infrastructure before exposing
this flow. Never send bearer tokens over the public HTTP ALB for this test.

Use a secretless Cognito app client with **authorization code only**, PKCE, scopes
`openid email aws.cognito.signin.user.admin`, token revocation, five-minute access
and ID tokens, and a one-hour refresh token. Exact callback is the frontend origin
plus `/auth/callback`; exact sign-out URL is its origin plus `/`. No wildcard
callbacks, implicit grant, client secret or identity pool is needed. Set the
backend and enrollment process `COGNITO_CLIENT_ID` to this OAuth client; the
existing headless rehearsal client is a different audience and is not accepted.

The pinned `oidc-client-ts` library handles PKCE/state/nonce/code exchange. The
provider handles password entry, signup, email confirmation and TOTP enrollment.
Only PKCE transactions are stored in sessionStorage; tokens remain in memory.
Reload requires another authorization redirect. FastAPI verifies the access JWT
signature/issuer/client and calls GetUser on every request; an ID-token profile
is never an ownership authorization. Refresh is single-flight, and a 401 gets
one retry. Sign-out revokes the refresh token before clearing the hosted cookie;
revocation failure is reported and still clears local access.

Classic Cognito hosted UI does not support `prompt=login`. If the enrollment
proof is older than five minutes, sign out and sign in again to clear its hosted
session cookie. Do not silently accept a refreshed token as a fresh sign-in.

## Separate enrollment authority

Run `uvicorn identity_app:create_identity_app --factory --host 127.0.0.1 --port 8001`
in a **separate process/container**. Never mount it in the history application.
It has no AWS task-role credentials, no service-role Supabase key, no history DB
credential, and no permission to read or change quiz history. Use the same
container hardening as the existing API. Do not expose it publicly over HTTP.

Only in the isolated rehearsal database, the trusted owner applies `schema.sql`
then `identity_schema.sql`, sets a random password for `quizforge_identity`, and
supplies it to this process through a distinct encrypted secret. No SQL is run
against Supabase production. Configuration:

- `IDENTITY_STAGING_ENABLED=true` (otherwise startup fails)
- `IDENTITY_ALLOWED_ORIGIN`: one exact frontend HTTPS origin (or localhost test)
- `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`: the approved disposable pool/client
- `IDENTITY_DB_HOST/PORT/NAME/USER/PASSWORD/SSLROOTCERT/POOL_SIZE`: separate role;
  hostname-verified TLS is mandatory, pool defaults to two connections
- Optional `IDENTITY_SUPABASE_URL/IDENTITY_SUPABASE_PUBLISHABLE_KEY` for linking
  an existing **test** account. Corresponding browser `VITE_SUPABASE_*` values
  enable its isolated, non-persistent proof client. No database calls occur there.

The service validates current Cognito access before revealing enrollment state.
New enrollment requires a verified email and an authentication event within five
minutes. It creates an unrelated random internal UUID; email is never a lookup.

Linking additionally requires a recent online-validated Supabase password sign-in
(AMR timestamp, not refresh-token issuance time). A verified TOTP factor requires
fresh TOTP AMR and AAL2. Anonymous, unverified, wrong-issuer, expired and malformed
proofs are rejected. Only an identity already imported into the staging database
can be linked. No client-supplied owner UUID, metadata or email can select an owner.

Two authenticated requests are required: `/identity/challenge`, then an explicit
user confirmation at `/identity/confirm`. Both revalidate both proofs. A random
256-bit nonce is stored only as a hash, bound to the Cognito identity, exact legacy
identity and intent, valid five minutes and consumed in the same transaction as
the mapping insert. Advisory locks serialize concurrent requests across workers;
unique constraints prevent duplicate mappings. Existing mappings cannot be
updated/deleted/reassigned. Five challenges per verified identity per five minutes
are enforced in PostgreSQL across processes. Failed/expired attempts cannot
create a partial user. RLS context is transaction-local and clears on rollback.

Database startup rejects owner/superuser/BYPASSRLS roles, disabled RLS and excess
history/identity mutation privileges. The history role still cannot write users
or identities. There are no SECURITY DEFINER functions. The owner should delete
expired challenge records during maintenance if this ever becomes persistent;
the current disposable database destroys them with staging.

**Rollback gate remains strict:** a new Cognito-only account has no preserved
Supabase identity. The existing history rollback rehearsal must refuse to import
that account into Supabase. Do not enable production Cognito signup until a
separately reviewed recovery strategy handles new accounts. Linking does not
erase the preserved Supabase identity or change its internal UUID.

## Validation and remaining live gates

CI runs real Chromium with deterministic provider responses (PKCE challenge,
state/nonce rejection, confirmation, refresh, logout failure), real RSA Cognito
token verification with mocked provider HTTP, and the enrollment service against
real hostname-verified TLS PostgreSQL. Database tests cover both proofs,
cross-account nonce misuse, replay, expiry, concurrency, rate limits, immutable
mappings, context cleanup and separate role privileges. Existing Supabase browser
and API tests remain in the required gate without lowered thresholds.

These tests **do not prove live email delivery or the Cognito hosted signup UI**.
The existing AWS rehearsal pool is admin-create-only, has no OAuth domain/client,
and must not be described as supporting this new browser flow yet.

Before a live browser rehearsal, a separate infrastructure PR must add an opt-in
disposable OAuth domain/client, automatic email verification and signup, mandatory
TOTP/password policy, the isolated enrollment container/secret and an HTTPS or
local tunnel route. Use only a dedicated test inbox/account, never a production
user, to verify delivery and enter the confirmation code. Test same-email
separation and dual-proof linking on imported synthetic history. Disable browser
network traces and do not log callback URLs, headers, codes, passwords or tokens.
No OpenAI call is needed. The always-run cleanup must delete the domain before
the pool and verify RDS/tasks/secrets/domain/pool absence; do not wait for a human
email code with paid RDS/Fargate resources running unnecessarily.

No AWS resources are created by this application PR. Cognito Lite/classic supports
the baseline flow; managed-login branding or paid threat-protection features are
not enabled. Recheck current Cognito/email pricing and explain incremental credit
impact before adding paid features.

References: [AWS PKCE and authorization](https://docs.aws.amazon.com/cognito/latest/developerguide/authorization-endpoint.html),
[hosted signup and confirmation](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-managed-login.html),
[Supabase AMR claims](https://supabase.com/docs/guides/auth/jwt-fields),
[OIDC client settings](https://authts.github.io/oidc-client-ts/interfaces/UserManagerSettings.html).

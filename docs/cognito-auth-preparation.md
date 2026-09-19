# Cognito authentication preparation — not a production cutover

This draft application change includes the unmerged FastAPI history boundary and
PostgreSQL adapter from PRs #85/#91. Keep it unmerged while `main` deploys the
Render/Vercel production application. No Supabase configuration, users, passwords,
production database schema, frontend login, AWS resources, or runtime parameters
are changed by this PR.

## Opt-in backend contract

`AUTH_PROVIDER` defaults to `supabase`; its existing online `/auth/v1/user`
validation remains active. An isolated Cognito deployment requires all of:

- `AUTH_PROVIDER=cognito`
- `COGNITO_USER_POOL_ID=ca-central-1_<pool>`
- `COGNITO_CLIENT_ID=<public app client ID>`
- `HISTORY_BACKEND=postgres` and the existing verified-TLS PostgreSQL settings

Only one authentication provider is active per deployment. There is no token-
directed provider selection, Supabase fallback, arbitrary issuer/JWKS URL, or
forwarding Cognito tokens to Supabase PostgREST.

Cognito accepts only RS256 **access** tokens signed by the configured pool,
with the exact app client, valid integer time claims, UUID subject, maximum
one-hour issued lifetime, and `aws.cognito.signin.user.admin` scope. ID tokens,
unexpected audiences, remote-key headers, unknown algorithms and missing claims
are rejected. Resource-bound access tokens require a future explicit audience
policy; this version rejects them.

Public signing keys are cached for five minutes, bounded to eight RSA keys.
Unknown keys can trigger at most one refresh per 30 seconds per worker. A key
rotation during that cooldown can temporarily reject requests; it never trusts
an unknown key or retains stale keys beyond the TTL. HTTP responses and token
sizes are bounded, redirects disabled, and HTTP calls time out after eight seconds.

Every verified JWT also passes Cognito `GetUser`. The returned subject must
match, and the account must have a verified email. This intentionally retains an
online session check, including rejection of revoked tokens, instead of treating
a valid JWT signature as proof that the session is still active. Quota errors,
malformed responses and outages fail closed with sanitized 503 responses.
No permanent access key or IAM task permission is needed for `GetUser`.

## Verified identity versus database ownership

The authenticated principal carries the verified issuer and subject separately
from its provider-namespaced cache/rate-limit identity. Supabase's existing cache
identity is unchanged; Cognito uses `cognito:<pool>:<subject>`. Switching providers
does not silently reuse another provider's document/cache ownership.

PostgreSQL resolves `(issuer, subject)` in `app.user_identities` to the internal
UUID under transaction-local RLS. That internal UUID, not an email, username,
custom claim, metadata field, request `user_id`, or raw Cognito subject, owns
quiz history. Unknown identities receive 403; matching emails do not link users.
The app role cannot insert/update/delete/truncate identities or users, and
startup now rejects such privileges as well as owner/BYPASSRLS roles.

The TLS PostgreSQL CI tests run the actual HTTP authentication dependency in
both provider modes. Synthetic AWS responses use real RSA-signed JWTs and are
the only mocked Cognito boundary. Both pre-approved provider identities map to
the same internal owner, and wrong issuer, unmapped identity, forged owner,
cross-user read/delete, concurrency and pooled-context cleanup remain tested.

**Not implemented yet:** public signup provisioning and production account
linking. Before enabling either, add a separately authorized enrollment/linking
workflow with recent proof of both accounts, replay protection and transactional
conflict detection. Preserve existing Supabase UUIDs for migrated owners, require
explicit verification of the Cognito subject, and refuse reassignment of an
existing identity. Do not grant the public API a broad identity-write role, use
email matching, or enable open signup with this read-only mapping path.

## Next isolated staging gate

1. Create a disposable ca-central-1 user pool and secretless app client in separate
   Terraform state. Never import or modify production Supabase users.
2. Explicitly choose the cost-conscious Lite tier; no Plus, advanced security
   add-on, WAF, SMS, SES sender configuration, or paid API quota add-on in the first
   rehearsal. Require a 14-character mixed-class password, TOTP MFA capability,
   token revocation, five-minute access tokens, and user-existence protection.
3. Use synthetic admin-created canaries with notifications suppressed, then test
   password rejection, login, TOTP enrollment/challenge, revoked-token rejection,
   and the built-in password lockout. Public signup remains disabled for this
   first gate; real email delivery and signup verification need their own test.
4. Validate the exact reviewed application PR image against private RDS using
   pre-approved synthetic identity mappings, with no AWS credentials in the API.
5. Destroy the pool, users, clients, RDS/Fargate and temporary secrets immediately;
   confirm absence. No ALB/Valkey is needed for a loopback-only auth/history probe.
6. Only after that, implement the frontend authorization-code/PKCE flow and
   controlled identity enrollment. Production switch remains separately approved.

## Cost and documentation

No new AWS resources are started by the application PR. Existing ECR, logs and
Terraform state storage can still incur small charges. The proposed rehearsal
adds Cognito usage plus a short private RDS/Fargate session; budget under $1 for
the short infrastructure test, not a cap or billing guarantee. Cognito Lite and
Essentials currently include 10,000 direct/social monthly active users per
account/organization; eligibility/aggregate use must be checked before relying
on that allowance. SMS/email delivery and advanced security have separate costs.

Official references checked 2026-09-17:

- [JWT verification](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-tokens-verifying-a-jwt.html)
- [GetUser and its required scope](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_GetUser.html)
- [Revocation versus offline JWT validation](https://docs.aws.amazon.com/cognito/latest/developerguide/token-revocation.html)
- [Password lockout behavior](https://docs.aws.amazon.com/cognito/latest/developerguide/authentication.html#authentication-flow-lockout-behavior)
- [Cognito pricing](https://aws.amazon.com/cognito/pricing/)

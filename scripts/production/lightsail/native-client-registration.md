# Dedicated desktop client registration

The readiness run 36673848856 found no dedicated desktop client and verified the
protected production Lite pool, classic domain and web client. This workflow
registers the exact public native client described by application commit
`d448766be5feed089aa5c774f3254b869eaff978`. It does not enable desktop login in the
application or deploy the optional backend audience configuration.

## Reviewed operation

Run **Register reviewed desktop Cognito client** from `main`, first attempt only,
with confirmation `register-reviewed-desktop-client`, after explicit approval of
the new desktop OAuth client. Merging this workflow performs no AWS mutation.

The sole write is `CreateUserPoolClient`, restricted by the temporary session
policy to the pool ARN resolved and checked during read-only preflight. It uses
no client secret, only authorization-code OAuth, the reviewed custom callback,
short token lifetimes and token revocation. Existing web clients, users, MFA,
password policy, pool tier, billing, branding, DNS and deployment are untouched.
No IAM policy is expanded. The existing role must already authorize creation.

The workflow checks the complete existing boundary twice, checks its source pin,
and validates both the request and returned configuration with the application's
exact offline checker. A valid existing client is reused. Duplicate names or a
mismatched client fail; nothing is silently updated or deleted. Workflow-wide
concurrency serializes its runs, but cannot lock out independent console edits:
avoid parallel manual registration while it runs.

Cognito's create API has no idempotency token. SDK retries are disabled. If a
create call times out, the sanitized summary reports changes as `unknown` and
requires fresh inventory inspection. Never use GitHub's rerun button; it is
rejected. Inspect live readiness first, resolve any partial/mismatched state,
and use a new explicitly reviewed dispatch. No automatic rollback deletion is
attempted because a client might already have been used.

Success means the client policy was registered and read back. It does **not**
prove hosted-login branding, OS callback delivery, PKCE account login, backend
acceptance, local account binding or native notifications. Verify classic login
availability separately; do not upgrade Lite or create managed-login branding as
an incidental fix. Keep the deployed client allowlist unchanged until integration
and release acceptance are ready.

Only sanitized status and the reviewed source SHA are published. Private service
identifiers and descriptions stay in memory or the verifier's temporary file.

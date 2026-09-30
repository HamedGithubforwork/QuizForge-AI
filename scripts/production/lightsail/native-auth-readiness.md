# Native desktop authentication readiness

Run **Desktop native authentication readiness** (`desktop-auth-readiness.yml`) on `main` to inspect the actual production Cognito metadata. The workflow uses a read-only STS session; it cannot create/update/delete clients, alter users/MFA/domains, change IAM, deploy code or enable paid features.

The controller binds discovery to the exact existing production pool/web-client names, Canadian region and account's classic hosted domain. It requires a protected Lite pool and the existing web code-grant/callback boundary. It loads the native policy from the immutable application commit in `native-client-source.json`, independently of the deployed application release lock.

Results:

- `registration_required`: no client matching the reviewed native client name exists; this is a successful inspection, not failed authentication.
- `client_configuration_verified`: exactly one dedicated client matches the pinned policy. This does not prove a native login, branding, token exchange, Windows callback, enrollment or renderer integration works.
- `inspection_failed`: a boundary, permission, ambiguity or policy check failed. No settings changed; diagnose before provisioning or relaxing a check.

Only the sanitized summary is published. Raw client descriptions are passed to the offline checker through a private temporary file and deleted; identifiers, secrets and raw AWS errors are not logged. The application helper rejects secret-bearing clients. This workflow does not ask for or use a real user session.

For future registration, follow the application repository's `desktop/native-client-setup.md` and `desktop/native-auth.md`. The existing canary/style controllers demonstrate AWS operations, but they must not be repurposed to create persistent native clients: prepare a narrowly scoped, separately reviewed provisioning operation. Keep the live application candidate/lock unchanged until the actual native integration is complete and accepted.

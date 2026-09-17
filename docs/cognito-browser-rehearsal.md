# Disposable live Cognito browser rehearsal

This infrastructure-only workflow tests a reviewed, unmerged application PR without deploying it to Render or Vercel. Supabase production is not contacted. The application still defaults to Supabase until an explicitly approved cutover.

In GitHub Actions, run **AWS Cognito browser rehearsal** on **main**, operation **run**, application PR **97**. A credentialless build job verifies required checks on the exact PR commit before building its backend and frontend. The trusted main-branch driver then creates a separate Cognito Lite pool, classic hosted domain, OAuth code client, IAM-only fixture client, narrowly scoped signup Lambda and one-day log group.

The browser, FastAPI, separate identity enrollment broker, Redis and TLS PostgreSQL run only inside temporary GitHub-runner containers. Application containers receive no AWS credentials or Docker socket. The browser uses Cognito's testing-only `http://localhost:4174/auth/callback` exception; all provider traffic is HTTPS. PostgreSQL requires TLS certificate verification and separates history and identity roles. Only synthetic history and synthetic identities are used; there are no OpenAI requests. No RDS, Fargate, ALB, Valkey, NAT, SES configuration or production deployment is created.

The live driver verifies hosted login, mandatory TOTP, PKCE verifier/challenge and nonce, backend JWT/GetUser validation, wrong-client/ID-token rejection, authenticated history ownership, explicit one-use new-account enrollment, unverified-email denial and logout revocation. Successful completion additionally checks all eight seeded foreign-history rows are unchanged. Dual Supabase/Cognito ownership linking remains covered by the application's security tests; this rehearsal does not claim a live production-account link.

Every automated run has an independent always-run cleanup job, including after validation failure. Cleanup destroys the pool, its users/clients/domain, Lambda, IAM role/policy and log group, then queries AWS to verify absence. State is isolated at `quizforge/cognito-browser-rehearsal/terraform.tfstate`. Manual **stop** is idempotent and can clean partial provisioning. Never force-unlock or erase state to bypass a failed cleanup.

## Real inbox confirmation

The automated run suppresses email delivery and rejects public signup. It does **not** prove delivery to a real inbox.

**email-start** enables signup only for the existing dedicated `QUIZFORGE_CANARY_EMAIL` GitHub secret. Terraform and Lambda receive only a SHA-256 allowlist digest; the controller never prints the address. The signup guard never auto-confirms users or auto-verifies email. A run-summary link opens the actual Cognito signup page. Enter credentials and the received code only on that page, using a secure browser handoff; never place them in chat, workflow inputs, logs or artifacts. This link is solely an email-confirmation handoff: it does not exchange or accept a code, and is not the application's PKCE login flow.

After confirming the real email, immediately run **email-verify-stop**. It requires the dedicated account to be `CONFIRMED` with `email_verified=true`, and always destroys resources even if verification fails. If the handoff cannot be completed, run **stop** immediately. There is no AdminConfirmSignUp bypass.

The manual window expires after 30 minutes. A 15-minute scheduled cleanup checks its deadline as a fallback; GitHub can delay scheduled jobs, so this is not a billing guarantee or a replacement for explicit stop. A second start refuses nonempty state.

## Costs and remaining gates

Few Cognito Lite test users and short 128 MB Lambda invocations should fit available free allowances; eligibility and shared usage determine actual charges. Temporary CloudWatch logs, Terraform S3 state and GitHub Actions minutes/artifacts may be billable. No paid Cognito Plus features, SMS or permanently running AWS compute are enabled. See [Cognito pricing](https://aws.amazon.com/cognito/pricing/) and [Lambda pricing](https://aws.amazon.com/lambda/pricing/).

Browser email confirmation, custom HTTPS domains, production migration/rollback, recovery flows, and production security hardening remain separate gates. Passing this rehearsal authorizes no production cutover.

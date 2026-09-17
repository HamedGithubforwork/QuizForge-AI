# Disposable live Cognito browser rehearsal

This infrastructure-only workflow tests a reviewed, unmerged application PR without deploying it to Render or Vercel. Supabase production is not contacted. The application still defaults to Supabase until an explicitly approved cutover.

In GitHub Actions, run **AWS Cognito browser rehearsal** on **main**, operation **run**, application PR **97**. A credentialless build job verifies required checks on the exact PR commit before building its backend and frontend. The trusted main-branch driver then creates a separate Cognito Lite pool, classic hosted domain, OAuth code client, IAM-only fixture client, narrowly scoped signup Lambda and one-day log group.

The browser, FastAPI, separate identity enrollment broker, Redis and TLS PostgreSQL run only inside temporary GitHub-runner containers. Application containers receive no AWS credentials or Docker socket. The browser uses Cognito's testing-only `http://localhost:4174/auth/callback` exception; all provider traffic is HTTPS. PostgreSQL requires TLS certificate verification and separates history and identity roles. Only synthetic history and synthetic identities are used; there are no OpenAI requests. No RDS, Fargate, ALB, Valkey, NAT, SES configuration or production deployment is created.

The live driver verifies hosted login, mandatory TOTP, PKCE verifier/challenge and nonce, backend JWT/GetUser validation, wrong-client/ID-token rejection, authenticated history ownership, explicit one-use new-account enrollment, unverified-email denial and logout revocation. Successful completion additionally checks all eight seeded foreign-history rows are unchanged. Dual Supabase/Cognito ownership linking remains covered by the application's security tests; this rehearsal does not claim a live production-account link.

Every automated run has an independent always-run cleanup job, including after validation failure. Cleanup destroys the pool, its users/clients/domain, Lambda, IAM role/policy and log group, then queries AWS to verify absence. State is isolated at `quizforge/cognito-browser-rehearsal/terraform.tfstate`. Manual **stop** is idempotent and can clean partial provisioning. Never force-unlock or erase state to bypass a failed cleanup.

## Real inbox confirmation

The automated run suppresses email delivery and rejects public signup. It does **not** prove delivery to a real inbox.

Set the repository Actions secret `COGNITO_REHEARSAL_EMAIL` to an inbox you can open. It is independent of `QUIZFORGE_CANARY_EMAIL` and `QUIZFORGE_CANARY_PASSWORD`, which must keep identifying the existing Supabase canary login. The verification inbox does not need a Supabase account. Do not change this secret during an active email window; stop the earlier rehearsal before selecting another inbox.

**email-start** enables signup only for `COGNITO_REHEARSAL_EMAIL`. A missing or invalid value fails before creating resources; there is no fallback to the Supabase canary address. Terraform and Lambda receive only a SHA-256 allowlist digest; the controller never prints the address. It signs up that disposable user with a random password that is never persisted, displayed or reused. Cognito sends a verification link titled **Verify your temporary QuizForge AWS test account**. The controller first checks the account remains unconfirmed and email unverified. The signup guard never auto-confirms users or auto-verifies email.

Open the link only from the dedicated inbox; never place verification links or codes in chat, workflow inputs, logs or artifacts. This proves inbox confirmation only and does not sign in or exchange OAuth codes. Cognito accepting a send request does not itself prove inbox delivery; that is claimed only after confirmation. See [AWS email verification templates](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pool-settings-message-customizations.html).

After confirming the real email, immediately run **email-verify-stop**. It requires the dedicated account to be `CONFIRMED` with `email_verified=true`, and always destroys resources even if verification fails. If the handoff cannot be completed, run **stop** immediately. There is no AdminConfirmSignUp bypass.

The manual window expires after 30 minutes. A 15-minute scheduled cleanup checks its deadline as a fallback; GitHub can delay scheduled jobs, so this is not a billing guarantee or a replacement for explicit stop. A second start refuses nonempty state.

## Real email password recovery

**recovery-start** creates the same isolated Lite pool with public signup closed. It seeds disposable accounts through the IAM-only fixture client, enrolls required TOTP, and sets the dedicated recovery fixture's email to `COGNITO_REHEARSAL_EMAIL` as an already-verified account. This is fixture preparation, not a claim of signup verification; the separate inbox-confirmation rehearsal covers that proof. Production accounts are never used. Unknown and unverified accounts must receive one of Cognito's documented anonymous responses (simulated delivery or `InvalidParameterException`) and must reject an invalid reset code. Explicit account-not-found responses, throttling, authentication data, and successful unauthorized resets fail the probe. See [Cognito user-existence error prevention](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pool-managing-errors.html), including its documented alternating responses. This bounded test does not claim statistical timing indistinguishability or resistance to every enumeration technique.

One public `ForgotPassword` call sends a real code titled **Reset your temporary QuizForge AWS test password**. Read only the newest email from this run. Transfer its code through the temporary **encrypted repository Actions secret** `COGNITO_RECOVERY_RECEIPT`, with JSON keys `run_id` (the start run ID as a string) and `code`. Never put the code in chat, workflow inputs, command arguments, logs, artifacts or commits. Run **recovery-finish-stop**, then delete the receipt secret. The receipt is rejected if it belongs to another run or the 30-minute deadline has expired.

Two Standard SSM SecureStrings under `/quizforge/cognito-browser-rehearsal/recovery/` hold the temporary fixture and refresh token between jobs, encrypted with the AWS-managed key. They are outside Terraform state, cannot overwrite existing parameters, and are bound to the exact pool, clients, run and deadline. Every manual stop, failure cleanup and expired-window cleanup deletes both exact names and verifies absence, including partial writes. Cleanup still destroys Cognito if the recovery test fails. Stop immediately if the inbox handoff cannot be completed; the scheduled fallback can be delayed.

The finish probe requires wrong-code and weak-password rejection, real `ConfirmForgotPassword`, no tokens issued by reset, old-password rejection, revocation of working access/refresh sessions, and one-use reset codes. It refreshes and verifies the old session immediately before reset to prevent ordinary token expiry producing a false pass. It then requires the new password to demand the existing TOTP, rejects a wrong TOTP, and verifies successful MFA preserves the subject and verified email. IAM is used for fixture login because the public browser client remains OAuth-only; the reset APIs themselves use the public client. This is an API recovery test, not a claim of browser recovery UX or public password-auth support.

Password recovery must not bypass a lost authenticator. Lost-MFA support requires a separately reviewed identity-proof process before production. No MFA removal, administrator password-reset bypass, code interception, custom email-sender hook, extra paid Cognito tier or brute-force load test is used here.

## Costs and remaining gates

Few Cognito Lite test users and short 128 MB Lambda invocations should fit available free allowances; eligibility and shared usage determine actual charges. Temporary CloudWatch logs, Terraform S3 state and GitHub Actions minutes/artifacts may be billable. No paid Cognito Plus features, SMS or permanently running AWS compute are enabled. See [Cognito pricing](https://aws.amazon.com/cognito/pricing/) and [Lambda pricing](https://aws.amazon.com/lambda/pricing/).

Standard SecureString storage adds no advanced-parameter subscription; API/KMS requests and shared account quotas can still affect charges. Both temporary parameters are deleted on stop.

Live inbox confirmation and recovery require their explicit operations above. Hosted recovery UX, lost-MFA support, custom HTTPS domains, production migration/rollback and production security hardening remain separate gates. Passing this rehearsal authorizes no production cutover.

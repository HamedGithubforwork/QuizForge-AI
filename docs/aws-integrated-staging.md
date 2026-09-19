# Integrated AWS browser rehearsal

This disposable environment joins the previously validated AWS components into a
single browser journey: private S3 and CloudFront, Cognito hosted code/PKCE login
with mandatory TOTP, the dedicated staging HTTPS ALB, separate API and account
setup Fargate tasks, and private forced-TLS RDS PostgreSQL.

Run **AWS integrated browser staging** on `main`, operation `run`, application PR
`97`. The controller requires the existing checks to pass on that exact application
commit before building it. The application PR remains draft and unmerged.

The workflow validates real browser CORS/CSP, login/nonce/PKCE, history save/list/UI
render/delete, explicit account enrollment, ownership isolation, invalid and
unverified identity rejection, and hosted logout with fresh token revocation and
password/TOTP required on the next login. A separate private database probe checks
that the eight original synthetic history fixtures remain unchanged.

## Isolation and credentials

- State: `quizforge/integrated-staging/terraform.tfstate`, separate from all earlier rehearsals.
- Resource prefix: `quizforge-integrated-staging`. The existing foundation is read only.
- DNS: only `staging-api.quizfromnotes.com`, using the existing issued certificate and zone. Existing records block provisioning.
- Frontend builds run on a separate runner without AWS credentials. Only public URLs and Cognito identifiers enter the build.
- Application tasks have separate database credentials and no AWS task role. The API cannot read the enrollment role's credential.
- Synthetic user passwords and TOTP seeds stay in one temporary encrypted fixture secret. The browser receives a private temporary file, no AWS environment or Docker socket, and no database credentials.
- The private setup probe alone receives the RDS owner password. Its task role can read the fixture secret and write the two restricted application credentials.
- Production Vercel, Render and Supabase services are not modified or queried. No OpenAI requests, production users, paid email/SMS delivery or data migration are included.

## Cleanup and limits

An always-running cleanup job stops only the exact integration task families,
destroys this isolated state, then queries AWS to confirm absence of the frontend,
database/backups, tasks/services, load balancer/targets, Cognito pool/domain,
temporary secrets, roles, logs, security groups and staging DNS alias. The reusable
foundation, certificate, zone and reviewed ECR images are retained. Existing ECR
lifecycle rules manage stored images.

An hourly scheduled cleanup and a manual `stop` operation provide recovery after
an interrupted run. CloudFront independently stops serving the app after its
two-hour lease. The lease does not stop AWS billing: cleanup must finish and its
absence checks must pass. Temporary RDS, ALB, Fargate and public IP resources incur
normal AWS charges while present.

This test covers the integrated authentication and history path. Generation,
managed cache, recovery email and production rollout retain their separate gates.
CI builds and mocked Terraform plans are prerequisites; they are not evidence of
a successful live rehearsal. Record the successful workflow run and cleanup
evidence after execution.

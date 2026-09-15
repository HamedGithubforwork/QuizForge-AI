# QuizForge AI Roadmap

Last updated: September 2026

## Direction

QuizForge AI is already a working production application. The next major engineering phase is a staged migration from the current managed-platform architecture to a primarily AWS-hosted architecture.

The goal is not to rewrite working product features for their own sake. The goal is to use the existing application as a realistic vehicle for learning and demonstrating cloud architecture, container deployment, networking, managed databases, authentication, caching, observability, CI/CD, infrastructure as code, and production migration practices.

The production application must remain usable throughout the migration. Each phase should be independently deployable, testable, and reversible before the next dependency is moved.

## Current verified production baseline

- Frontend: React 19 + TypeScript + Vite
- Frontend hosting: Vercel
- Backend: Python + FastAPI + Pydantic
- Backend runtime: Docker + Uvicorn
- Backend hosting: Render
- Authentication: Supabase Auth
- Database: Supabase PostgreSQL
- Browser data access: Supabase client under Row Level Security
- Cache / rate limiting / locks / operational metrics: Redis
- AI: OpenAI API
- PDF processing: PyMuPDF + Tesseract OCR
- CI/CD and quality gates: GitHub Actions, pytest, Node tests, StrykerJS, Playwright, axe, Docker builds, integration tests, migration checks, security checks, and deployment canaries

## Target AWS architecture

```text
User / Browser
      |
      v
CloudFront
      |
      v
S3-hosted React + TypeScript frontend
      |
      v
Application Load Balancer
      |
      v
ECS Fargate
FastAPI Docker service
   |       |        |
   |       |        +----> OpenAI API
   |       |
   |       +-------------> ElastiCache for Redis
   |
   +---------------------> RDS PostgreSQL

Authentication: Amazon Cognito
Secrets: AWS Secrets Manager
Container registry: Amazon ECR
Logs / metrics / alarms: Amazon CloudWatch
DNS / TLS: Route 53 + ACM
Infrastructure as code: Terraform
CI/CD: GitHub Actions using AWS OIDC
```

User-uploaded PDFs should remain transient unless a future product requirement explicitly calls for persistent file storage. S3 is required for the built frontend, but storing user documents is a separate privacy/product decision and is not part of the migration by default.

---

# Phase 0 — Preserve the working baseline

**Status: Complete / existing foundation**

Before changing infrastructure, preserve the behavior that already works.

### Existing safeguards to keep

- Dockerized FastAPI backend
- Local Docker Compose environment
- Backend pytest suite
- Frontend unit and coverage tests
- Mutation testing
- Playwright browser tests
- Real local-stack integration tests
- Database migration verification
- Security audits
- Deployment smoke tests
- Authenticated production canary
- Privacy-conscious logging
- Redis safe-degradation behavior

### Migration rule

No AWS phase is considered complete until the relevant existing tests pass against the new infrastructure and there is a documented rollback path.

---

# Phase 1 — AWS foundation and infrastructure as code

**Status: Next**

Create the AWS environment before moving application traffic.

### Build

- AWS account/project structure for QuizForge
- IAM roles with least privilege
- GitHub Actions OIDC trust relationship so CI does not require long-lived AWS access keys
- Terraform project for AWS resources
- VPC
- Public subnets for the load balancer
- Private subnets for application/data services where practical
- Security groups
- Amazon ECR repository for the backend image
- AWS Secrets Manager entries for server-side secrets
- CloudWatch log groups
- AWS Budget / billing alert so experimentation cannot silently create a large bill

### Learn / demonstrate

- IAM
- VPC networking
- subnets and routing
- security groups
- Terraform state and resource lifecycle
- GitHub-to-AWS OIDC
- secrets management
- cloud cost controls

### Completion criteria

- `terraform plan` is reproducible
- GitHub can authenticate to AWS through OIDC
- backend image can be pushed to ECR
- no application traffic has been cut over yet
- no permanent AWS credentials are stored in GitHub

---

# Phase 2 — Move the FastAPI backend from Render to ECS Fargate

**Replaces: Render**

This is the safest first production migration because the backend is already packaged as a Docker image with Tesseract included.

### Build

- ECR image publishing from GitHub Actions
- ECS cluster
- Fargate task definition
- ECS service
- Application Load Balancer
- health checks using the existing `/api/health` endpoint
- environment/secrets injection from AWS
- CloudWatch application logs
- autoscaling policy only after baseline behavior is understood

### Keep temporarily

- Vercel frontend
- Supabase Auth
- Supabase PostgreSQL
- existing Redis provider
- OpenAI

### Validation

The AWS backend must support the same flows as Render:

- authenticated requests
- PDF upload and extraction
- Tesseract OCR fallback
- quiz generation
- source retrieval
- answer review
- Redis caching and locks
- admin metrics
- CORS from the production frontend

### Cutover strategy

1. Deploy ECS in parallel with Render.
2. Run smoke/integration checks against the ECS URL.
3. Point the frontend API URL at AWS.
4. Keep Render available as rollback during the validation period.
5. Remove Render only after AWS production verification is stable.

### Completion criteria

- production FastAPI traffic runs on ECS/Fargate
- Docker images are versioned in ECR
- deployment is automated from GitHub Actions
- logs are visible in CloudWatch
- Render is no longer required

---

# Phase 3 — Move Redis to Amazon ElastiCache

**Replaces: current hosted Redis infrastructure**

### Build

- ElastiCache Redis-compatible deployment
- private network access from ECS
- security-group restrictions so Redis is not publicly reachable
- TLS/auth configuration where supported by the selected deployment mode
- connection configuration through Secrets Manager / task configuration

### Preserve existing Redis responsibilities

- document cache
- generated quiz cache
- source-page cache
- per-user rate limiting
- single-flight generation locks
- operational counters/timing samples

### Validation

- cache hit/miss behavior remains correct
- TTLs remain correct
- rate limiting remains correct
- lock behavior remains correct under concurrency
- safe in-process fallback behavior remains intact when Redis is deliberately unavailable

### Completion criteria

- ECS communicates with ElastiCache privately
- Redis is no longer dependent on the previous hosting provider

---

# Phase 4 — Move quiz-history access behind FastAPI

**Architectural refactor required before leaving Supabase PostgreSQL**

Today the React frontend talks directly to Supabase for quiz history. The AWS architecture should instead use:

```text
React -> FastAPI -> PostgreSQL
```

rather than:

```text
React -> database service directly
```

### Build backend history endpoints

Examples:

- `POST /api/history`
- `GET /api/history`
- `GET /api/history/document/...`
- `DELETE /api/history/{id}`

Exact route shapes should follow the existing API conventions rather than being chosen solely from these examples.

### During this phase

- Supabase Auth can remain the identity provider.
- Supabase PostgreSQL can remain the physical database initially.
- FastAPI validates the current bearer token and derives the authenticated user ID.
- The browser stops issuing direct table queries.

### Why this comes before Cognito

The current database schema and Row Level Security are coupled to `auth.users` and `auth.uid()`. Removing direct browser database access first creates a clean trust boundary and makes both the RDS and Cognito migrations much simpler.

### Completion criteria

- React no longer reads/writes `quiz_history` directly through `@supabase/supabase-js`
- all quiz-history persistence goes through authenticated FastAPI endpoints
- history pagination, analytics, deletion, document matching, and weak-area practice still work
- tests cover authorization so one user cannot access another user's history

---

# Phase 5 — Move PostgreSQL from Supabase to Amazon RDS

**Replaces: Supabase PostgreSQL**

### Build

- Amazon RDS for PostgreSQL
- private database networking
- database credentials in Secrets Manager
- backend database connection pool
- migration tooling suitable for ordinary PostgreSQL
- schema recreated without dependency on Supabase `auth.users`

### Data model change

Once the API owns database access, authorization should be enforced by FastAPI using the authenticated user identity. The database should still use constraints and indexes, but should no longer depend on browser-facing Supabase RLS as the primary security boundary.

### Migration work

- reproduce `quiz_history` schema and indexes in RDS
- preserve `document_sha256`
- preserve JSON/JSONB data
- preserve ordering/pagination behavior
- migrate existing data if production history needs to be retained
- verify row counts and representative records after migration
- update integration tests to target ordinary PostgreSQL

### Cutover strategy

1. Create RDS schema.
2. Test backend history APIs against RDS in a non-production environment.
3. Copy production data if required.
4. Temporarily freeze or carefully coordinate writes during final data cutover.
5. Point FastAPI at RDS.
6. Verify counts and application flows.
7. Keep Supabase DB available briefly for rollback/read comparison.

### Completion criteria

- production quiz history lives in RDS PostgreSQL
- browser has no database credentials
- Supabase PostgreSQL is no longer required

---

# Phase 6 — Replace Supabase Auth with Amazon Cognito

**Replaces: Supabase Auth**

Cognito comes after database access is behind FastAPI so authentication can change without also rewriting browser database permissions at the same time.

### Build

- Cognito User Pool
- application client configuration
- signup
- login
- email confirmation
- logout
- password reset/recovery
- session/token refresh
- JWT verification in FastAPI

### Frontend refactor

Replace Supabase-specific auth calls in `AuthGate.tsx` and supporting code with the chosen Cognito client integration.

### Backend refactor

Replace calls to the Supabase Auth `/auth/v1/user` endpoint with local verification of Cognito JWTs using the Cognito issuer/JWKS configuration.

### User identity migration

Before production cutover, choose and document one of these strategies:

- fresh portfolio accounts after cutover, or
- controlled migration/mapping of existing users, or
- Cognito migration flow if retaining existing accounts is required

Historical quiz rows must map to the new identity model if existing user data is retained.

### Completion criteria

- all account flows work through Cognito
- FastAPI authorizes protected routes from Cognito JWTs
- existing history ownership remains correct for retained accounts
- Supabase is no longer required anywhere in the production request path
- `@supabase/supabase-js` can be removed from the frontend once no remaining feature uses it

---

# Phase 7 — Move the React frontend from Vercel to S3 + CloudFront

**Replaces: Vercel**

### Build

- production Vite build
- private S3 bucket for static frontend assets
- CloudFront distribution using origin access controls
- SPA fallback/routing behavior
- cache-control policy
- secure response headers
- production API URL pointing to the AWS backend

### Add production DNS/TLS

- Route 53 if DNS is managed in AWS
- ACM certificate
- custom domain for frontend
- custom API domain if useful

### CI/CD

GitHub Actions should:

1. build the frontend
2. upload build assets to S3
3. invalidate or version CloudFront cache appropriately
4. run deployment smoke tests
5. run authenticated canary tests

### Completion criteria

- production frontend is served through CloudFront
- Vercel is no longer required
- HTTPS/custom-domain behavior is correct
- SPA refresh/deep-link behavior works

---

# Phase 8 — Consolidate AWS observability and production operations

### Build

- CloudWatch dashboards
- ECS CPU/memory alarms
- ALB 4xx/5xx visibility
- application-error metrics
- RDS health/storage alarms
- ElastiCache health/memory alarms
- deployment failure visibility
- log retention policies
- AWS Budgets alerts

### Preserve privacy rules

Do not log:

- PDF text
- bearer tokens/JWTs
- passwords
- raw OpenAI prompts containing uploaded study content
- raw Redis keys containing identity material
- unnecessary user identifiers

### Completion criteria

A production problem should be diagnosable from infrastructure and redacted application telemetry without exposing study content or authentication secrets.

---

# Phase 9 — Production-grade CI/CD

GitHub Actions remains the CI/CD system.

### Backend pipeline

```text
PR -> tests / security / build
merge to main
     -> build Docker image
     -> push immutable image to ECR
     -> update ECS task definition/service
     -> wait for health
     -> deployment smoke
     -> authenticated canary
```

### Frontend pipeline

```text
PR -> tests / lint / build / E2E
merge to main
     -> production Vite build
     -> upload to S3
     -> CloudFront cache update
     -> deployment smoke
     -> authenticated canary
```

### Infrastructure pipeline

- `terraform fmt`
- `terraform validate`
- `terraform plan` on pull requests
- controlled `terraform apply` after review/merge

### Completion criteria

- deployments do not require clicking through the AWS Console
- AWS authentication uses GitHub OIDC
- deployment failure is detectable and recoverable
- application and infrastructure changes are reviewable in Git

---

# Phase 10 — AWS hardening and optional advanced work

Only pursue these after the core migration is stable.

### Good portfolio extensions

- AWS WAF in front of CloudFront/ALB
- ECS autoscaling based on measured workload
- RDS automated backups and restore drill
- RDS Multi-AZ only if justified by cost/availability goals
- separate staging and production environments
- blue/green or controlled ECS deployment strategy
- CloudTrail review
- AWS Config/security posture checks
- dependency and container image scanning
- load testing with documented bottlenecks
- disaster-recovery/runbook documentation

### Optional file-storage extension

If QuizForge later needs durable document libraries, introduce a dedicated S3 upload design with encryption, user isolation, lifecycle rules, deletion semantics, and privacy review. Do not persist uploaded PDFs merely to add another AWS service to the architecture.

---

# Final target stack

| Layer | Target technology |
| --- | --- |
| Frontend | React 19, TypeScript, Vite |
| Frontend hosting/CDN | Amazon S3 + CloudFront |
| Backend | Python, FastAPI, Pydantic |
| Containers | Docker |
| Container registry | Amazon ECR |
| Backend compute | Amazon ECS + Fargate |
| Load balancing | Application Load Balancer |
| Database | Amazon RDS PostgreSQL |
| Authentication | Amazon Cognito |
| Cache / rate limiting / locks | Amazon ElastiCache for Redis-compatible workloads |
| Secrets | AWS Secrets Manager |
| Logs / metrics / alarms | Amazon CloudWatch |
| DNS | Route 53 |
| TLS certificates | AWS Certificate Manager |
| Infrastructure as code | Terraform |
| CI/CD | GitHub Actions + AWS OIDC |
| AI | OpenAI API |
| PDF processing | PyMuPDF + Tesseract OCR |
| Testing | pytest, Node tests, StrykerJS, Playwright, axe, integration/canary checks |

---

# Migration order summary

```text
0. Preserve current tests and production baseline
1. AWS foundation + Terraform + IAM/OIDC + ECR
2. Render -> ECS/Fargate
3. Redis -> ElastiCache
4. Browser Supabase DB access -> FastAPI history API
5. Supabase PostgreSQL -> RDS PostgreSQL
6. Supabase Auth -> Cognito
7. Vercel -> S3 + CloudFront
8. CloudWatch / alarms / operations hardening
9. Complete AWS CI/CD automation
10. Optional advanced AWS hardening
```

The order is intentional. In particular, quiz-history access moves behind FastAPI before RDS/Cognito cutover so the project does not attempt to replace authentication, database hosting, and browser authorization semantics in one risky change.

## Definition of done for the AWS migration

The migration is complete when:

- Vercel is no longer required for production
- Render is no longer required for production
- Supabase is no longer required for production
- the FastAPI backend runs on ECS/Fargate
- the frontend is served by S3/CloudFront
- PostgreSQL runs on RDS
- authentication runs through Cognito
- Redis workloads run through ElastiCache
- secrets are managed through AWS rather than committed configuration
- CloudWatch provides useful operational visibility
- Terraform can recreate the AWS infrastructure
- GitHub Actions can deploy without long-lived AWS credentials
- existing QuizForge product flows and security boundaries remain covered by automated tests

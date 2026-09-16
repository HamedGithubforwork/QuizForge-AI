# QuizForge AWS foundation

This directory defines the Terraform-managed AWS resources for the staged QuizForge AI migration.

## Bootstrap resources created manually

Two resources intentionally exist outside this Terraform state because they are required before Terraform can run:

- the GitHub Actions OIDC IAM role (`QuizForgeGitHubTerraform`)
- the private, versioned S3 bucket used for Terraform state

The repository-level GitHub Actions variables provide their environment-specific values:

- `AWS_ROLE_ARN`
- `AWS_REGION`
- `TF_STATE_BUCKET`

No long-lived AWS access key is stored in GitHub. The workflows use GitHub OIDC to receive temporary AWS credentials.

## Foundation resources

The foundation includes:

- ECR repository for the FastAPI backend image
- CloudWatch API log group with bounded retention
- VPC
- two public subnets
- two private subnets
- internet gateway and public routing
- security groups reserved for the ALB, ECS service, RDS, and cache layers
- ECS cluster and Fargate task definition

A NAT Gateway is intentionally **not** created yet because it has hourly and data-processing charges.

## Backend container publishing

`.github/workflows/backend-ecr.yml` builds the production FastAPI Docker image and publishes immutable commit-tagged images to the `quizforge-api` ECR repository after changes reach `main`.

Publishing an image to ECR does not move production traffic. Render remains the live FastAPI host until the ECS path is validated and a later cutover is performed.

## ECS bootstrap

The foundation contains the reusable pieces needed to run the current FastAPI container on Fargate without leaving an application service running continuously:

- ECS cluster
- Fargate task definition using 0.25 vCPU and 512 MiB memory
- ECS task execution IAM role
- access from the execution role to `/quizforge/prod/*` Parameter Store values
- CloudWatch logging through the existing `/quizforge/api` log group
- a container health check against `/api/health`

The shared bootstrap task definition still injects these existing Parameter Store entries at runtime:

- `/quizforge/prod/OPENAI_API_KEY`
- `/quizforge/prod/SUPABASE_URL`
- `/quizforge/prod/SUPABASE_PUBLISHABLE_KEY`
- `/quizforge/prod/REDIS_URL`
- `/quizforge/prod/ALLOWED_ORIGINS`

The most recently pushed immutable ECR image is selected when Terraform creates a task-definition revision.

## One-off Fargate smoke test

`.github/workflows/ecs-smoke.yml` is manual (`workflow_dispatch`) and intentionally does not run on every commit.

When invoked from `main`, it starts one temporary Fargate task, waits for the container health check to report `HEALTHY`, shows recent CloudWatch logs if the task fails, and stops the task after the test.

The first smoke test completed successfully, proving that the image can be pulled from ECR, runtime values can be loaded from Parameter Store, the FastAPI process can start on Fargate, and the container health check can pass.

## Redis-compatible state used by the backend

QuizForge uses its Redis-compatible backend for more than a basic cache. The FastAPI application uses it for distributed request rate limits, quiz and processed-document caches, source-page cache entries, quiz-generation locking, and bounded observability metrics. The application degrades to process-local fallbacks for several paths when Redis is unavailable, but a shared managed cache is required before horizontally scaling the API.

## On-demand ALB + ECS + Valkey staging

`infra/aws/staging/` is a separate Terraform root with its own remote state key:

```text
quizforge/staging/terraform.tfstate
```

It reads the shared VPC, security groups, ECS cluster, image reference, log group, and other reusable values from the foundation state. The staging resources are **not** created by the normal foundation apply.

`.github/workflows/aws-staging.yml` provides manual `start` and `stop` operations. Starting staging creates:

- one internet-facing Application Load Balancer across both public subnets
- one ECS service with a single FastAPI task using Fargate Spot
- one single-node `cache.t4g.micro` Amazon ElastiCache for Valkey replication group in the private subnets
- TLS from FastAPI to Valkey using a `rediss://` connection
- encryption at rest for the temporary Valkey node
- `/api/health` target health checks
- an ECS deployment circuit breaker with automatic rollback

The staging task definition deliberately overrides the old external `REDIS_URL` with the private ElastiCache endpoint. The ElastiCache security group accepts port 6379 only from the ECS application security group, so the cache has no public ingress.

Staging uses cluster-mode-disabled Valkey because the current backend intentionally uses the standard non-cluster `redis-py` client and Redis features such as Lua `EVAL`, pipelines, locks, and ordinary single-key operations. This keeps the migration compatible with the existing backend contract while still moving the shared cache into AWS. A cluster-mode/serverless migration can be considered later if the application is intentionally converted and tested with a cluster-aware client.

After the public health check succeeds, the start workflow performs an authenticated boundary canary using the dedicated canary account. It signs in through Supabase Auth, sends the returned bearer token through the staging ALB to a protected FastAPI route, and expects the normal `410` response for a deliberately nonexistent document.

The workflow then starts a short-lived one-off Fargate task using the same staging task definition and directly verifies the managed Valkey connection with `PING`, `SET`/`GET`, and a one-key Lua `EVAL`. This specifically exercises the Redis operations required by the current application's distributed rate limiting and cache integration rather than relying on `/api/health` alone.

The authenticated staging canary runs from the GitHub runner rather than from the production Vercel page because the temporary staging endpoint is HTTP-only; browsers would block an HTTPS page from calling it as active mixed content. Browser-level CORS validation will be added after the staging API has HTTPS.

The API task remains in the public subnets with a public IP because QuizForge still needs outbound access to OpenAI and Supabase and there is intentionally no NAT Gateway yet. The managed Valkey node remains in private subnets.

Stopping staging destroys the ALB, ECS service/task definition, and temporary Valkey resources so their hourly charges stop. A scheduled safety shutdown runs daily at 08:00 UTC in case the environment is accidentally left running. A failed health, authenticated, or Valkey canary also attempts to destroy partially created staging resources automatically.

The staging cache intentionally uses one small node with no replica, Multi-AZ failover, or retained snapshots because it is disposable validation infrastructure. Production cache infrastructure will use an availability and authentication design appropriate to the final workload rather than copying the staging topology unchanged.

The staging ALB uses temporary HTTP on port 80. It is **not** a production cutover. Before browser traffic moves from Render to AWS, the plan is to add a custom API domain, ACM certificate, HTTPS on port 443, and an HTTP-to-HTTPS redirect.

## Remote state

The foundation S3 backend is configured at workflow runtime so the globally unique state-bucket name is not hard-coded into the repository.

Foundation state key:

```text
quizforge/foundation/terraform.tfstate
```

S3 lock-file state locking is enabled by the GitHub Actions workflows.

## Workflow behavior

Pull requests validate Terraform without applying AWS resources.

After a reviewed foundation change reaches `main`, the Terraform workflow authenticates to AWS through OIDC, initializes the foundation state, creates a saved Terraform plan, and applies that exact plan.

The staging ALB, ECS service, and Valkey cache are different: merging their Terraform definition does not start them. They are created only when the `AWS staging environment` workflow is manually dispatched with `operation=start`, and destroyed with `operation=stop` or by the scheduled safety shutdown.

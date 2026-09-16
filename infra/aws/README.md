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
- security groups reserved for the ALB, ECS service, RDS, and Redis layers
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

The task definition injects these existing Parameter Store entries at runtime:

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

## On-demand ALB + ECS staging

`infra/aws/staging/` is a separate Terraform root with its own remote state key:

```text
quizforge/staging/terraform.tfstate
```

It reads the shared VPC, security groups, ECS cluster, and task definition from the foundation state. The staging resources are **not** created by the normal foundation apply.

`.github/workflows/aws-staging.yml` provides manual `start` and `stop` operations. Starting staging creates:

- one internet-facing Application Load Balancer across both public subnets
- one ECS service with a single FastAPI task
- Fargate Spot capacity to reduce compute cost while staging is disposable
- `/api/health` target health checks
- an ECS deployment circuit breaker with automatic rollback

After the public health check succeeds, the same start workflow performs an authenticated boundary canary using the dedicated canary account. It signs in through Supabase Auth, sends the returned bearer token through the staging ALB to a protected FastAPI route, and expects the normal `410` response for a deliberately nonexistent document. This verifies the staging ALB, ECS task, Parameter Store configuration, outbound access to Supabase, and backend token validation without uploading a PDF or generating a quiz.

The authenticated staging canary runs from the GitHub runner rather than from the production Vercel page because the temporary staging endpoint is HTTP-only; browsers would block an HTTPS page from calling it as active mixed content. Browser-level CORS validation will be added after the staging API has HTTPS.

The task remains in the public subnets with a public IP because QuizForge still needs outbound access to OpenAI and Supabase and there is intentionally no NAT Gateway yet. Port 8000 is reachable only from the ALB security group.

Stopping staging destroys the ALB and ECS service so their hourly charges stop. A scheduled safety shutdown runs daily at 08:00 UTC in case the environment is accidentally left running. A failed health or authenticated-canary start also attempts to destroy partially created staging resources automatically.

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

The staging ALB and ECS service are different: merging their Terraform definition does not start them. They are created only when the `AWS staging environment` workflow is manually dispatched with `operation=start`, and destroyed with `operation=stop` or by the scheduled safety shutdown.

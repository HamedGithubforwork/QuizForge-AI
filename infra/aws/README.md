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

No long-lived AWS access key is stored in GitHub. The workflow uses GitHub OIDC to receive temporary AWS credentials.

## Foundation resources

The foundation includes:

- ECR repository for the FastAPI backend image
- CloudWatch API log group with bounded retention
- VPC
- two public subnets
- two private subnets
- internet gateway and public routing
- security groups for the ALB, ECS service, RDS, and Redis layers

A NAT Gateway is intentionally **not** created yet because it has hourly and data-processing charges.

## Backend container publishing

`.github/workflows/backend-ecr.yml` builds the production FastAPI Docker image and publishes immutable commit-tagged images to the `quizforge-api` ECR repository after changes reach `main`.

Publishing an image to ECR does not move production traffic. Render remains the live FastAPI host until the ECS path is validated and a later cutover is performed.

## ECS bootstrap

The ECS bootstrap creates the pieces needed to run the current FastAPI container on Fargate:

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

When invoked from `main`, it:

1. authenticates to AWS through GitHub OIDC
2. reads the ECS cluster/task-definition and network IDs from Terraform state
3. starts one Fargate task in a public subnet with a public IP for outbound internet access
4. keeps inbound traffic blocked by the application security group
5. waits for the container health check to report `HEALTHY`
6. shows recent CloudWatch logs if the task fails
7. stops the task after the smoke test

The first smoke test completed successfully, proving that the image can be pulled from ECR, runtime values can be loaded from Parameter Store, the FastAPI process can start on Fargate, and the container health check can pass.

## ECS service and Application Load Balancer staging

The next staging phase adds a continuously running ECS service and an internet-facing Application Load Balancer so the AWS-hosted backend can be exercised through a stable endpoint.

The ECS service:

- keeps one Fargate task running
- uses the existing FastAPI task definition
- runs in the public subnets with a public IP because there is still no NAT Gateway
- only accepts inbound application traffic from the ALB security group
- uses the ECS deployment circuit breaker with automatic rollback

The ALB:

- spans both public subnets
- forwards HTTP port 80 to container port 8000
- checks `/api/health` before considering a task healthy
- exposes a temporary AWS DNS name for staging validation

The HTTP listener is temporary and is **not** a production cutover. Before browser traffic is moved from Render to AWS, the plan is to add a custom API domain, an ACM certificate, HTTPS on port 443, and an HTTP-to-HTTPS redirect.

This phase creates continuously running ALB and Fargate resources and therefore consumes AWS Free Plan credits while deployed. The pull request itself does not create those resources; they are created only after the change is merged into `main` and Terraform applies it.

## Remote state

The S3 backend is configured at workflow runtime so the globally unique state-bucket name is not hard-coded into the repository.

State key:

```text
quizforge/foundation/terraform.tfstate
```

S3 lock-file state locking is enabled by the GitHub Actions workflow.

## Workflow behavior

Pull requests that change `infra/aws/**` run formatting and validation only; they do not authenticate to AWS and cannot change infrastructure.

After a reviewed infrastructure change reaches `main`, the Terraform workflow authenticates to AWS through OIDC, initializes the remote S3 backend, creates a saved Terraform plan, and applies that exact plan.

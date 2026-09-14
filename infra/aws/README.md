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
- security groups reserved for the ALB, ECS service, RDS, and Redis layers

A NAT Gateway is intentionally **not** created yet because it has hourly and data-processing charges.

## Backend container publishing

`.github/workflows/backend-ecr.yml` builds the production FastAPI Docker image and publishes immutable commit-tagged images to the `quizforge-api` ECR repository after changes reach `main`.

Publishing an image to ECR does not move production traffic. Render remains the live FastAPI host until the ECS path is validated and a later cutover is performed.

## ECS bootstrap

The ECS bootstrap creates the pieces needed to run the current FastAPI container on Fargate without creating a continuously running service yet:

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

No ECS service or Application Load Balancer is created by this bootstrap. That avoids leaving a Fargate task running continuously before the AWS backend has been smoke-tested.

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

This gives us a short-lived proof that the application can start on Fargate without creating a continuously running workload. The smoke test consumes a small amount of AWS Free Plan credits only while the task is running.

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

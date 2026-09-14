# QuizForge AWS foundation

This directory defines the first Terraform-managed AWS resources for QuizForge AI.

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

The first apply creates only low-complexity shared infrastructure:

- ECR repository for the FastAPI backend image
- CloudWatch API log group with bounded retention
- VPC
- two public subnets
- two private subnets
- internet gateway and public routing
- security groups reserved for the future ALB, ECS service, RDS, and Redis layers

A NAT Gateway is intentionally **not** created in this phase because it has hourly and data-processing charges. Private-service outbound networking will be designed when the ECS migration begins.

The application remains deployed on Vercel / Render / Supabase during this phase. No production traffic is cut over by this Terraform configuration.

## Remote state

The S3 backend is configured at workflow runtime so the globally unique state-bucket name is not hard-coded into the repository.

State key:

```text
quizforge/foundation/terraform.tfstate
```

S3 lock-file state locking is enabled by the GitHub Actions workflow.

## Workflow behavior

Pull requests that change this directory run formatting and validation only; they do not authenticate to AWS and cannot change infrastructure.

After a reviewed change reaches `main`, the workflow authenticates to AWS through OIDC, initializes the remote S3 backend, creates a saved Terraform plan, and applies that exact plan.

# QuizForge AWS infrastructure

QuizForge production now runs on the permanent Lightsail/Cognito path. The AWS
code under this directory is split between the active Lightsail stacks and an
older shared foundation that still owns retained AWS resources.

## Active production Terraform roots

- `lightsail-production/` — permanent Lightsail host, Cognito, production
  operating controls, and recovery-related resources.
- `lightsail-backups/` — retained backup storage, policies, alarms, and
  recovery permissions.

These roots have their own validation and maintenance workflows. Production
changes should use those reviewed paths rather than the retired disposable
ECS/Fargate staging workflows.

## Shared foundation root

The top-level `infra/aws/*.tf` files still manage the original foundation
state at:

```text
quizforge/foundation/terraform.tfstate
```

That state includes the ECR repository used for backend/release images,
CloudWatch logging, VPC/subnet/security-group resources, and legacy ECS
cluster/task-definition resources.

The legacy ECS resources are no longer the production serving path. They remain
in Terraform until they are deliberately reconciled with the existing remote
state. **Do not simply delete their Terraform resources from source**, because a
normal foundation apply could then plan destructive changes.

The old manual one-off Fargate smoke workflow has been retired from `main`.
Its historical implementation remains on
`archive/aws-migration-2026-09-26`.

## Backend image publishing

`.github/workflows/backend-ecr.yml` builds the FastAPI image and publishes
immutable commit-tagged images to the `quizforge-api` ECR repository.

Publishing an ECR image does not itself deploy production traffic. The active
Lightsail release workflows select reviewed immutable image digests for
deployment.

## Foundation workflow

`.github/workflows/terraform-aws.yml` validates the top-level foundation
Terraform on pull requests. A main-branch foundation change or an explicit
manual dispatch can run the remote-state plan/apply path through GitHub OIDC.

Bootstrap resources required before Terraform runs remain outside this state:

- the GitHub Actions OIDC IAM role
- the private versioned S3 Terraform-state bucket

Repository configuration supplies:

- `AWS_ROLE_ARN`
- `AWS_REGION`
- `TF_STATE_BUCKET`

No long-lived AWS access key is stored in GitHub.

## Cleanup boundary

Further reduction of the legacy VPC/ECS foundation is a **state migration task**,
not a source-only cleanup. Before removing those resources from Terraform,
inspect the remote state and live AWS inventory and decide whether each resource
should be destroyed, imported into another state, or retained. This avoids
turning repository cleanup into an accidental infrastructure teardown.

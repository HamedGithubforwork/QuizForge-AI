# Retained backup activation — draft implementation

**DRAFT ONLY. Credential-free validation and provider compatibility tests are
defined for PR validation but must pass on the exact revision before merge. This
implementation has not been activated in AWS.**

This document accompanies an additive draft based on `quizforge-backup-chat-context.md`.
It does not authorize AWS activation, additional permissions, a production launch,
notification publication, or changes to application routing. The implementation
branch was reconciled to the exact current remote commit before applying the draft.
The live checks and operational gates below remain required before activation.

## Source basis and preserved configuration

| Item | Supplied snapshot / required value |
| --- | --- |
| Repository | `HamedGithubforwork/QuizForge-AI` |
| Remote implementation branch | `feat/backup-activation`, created at `1bd5b3a73430b48758806e7fdfc66d7c7fe3aedf` |
| Local worktree reconciliation | Completed: exact remote commit `1bd5b3a73430b48758806e7fdfc66d7c7fe3aedf` |
| Immutable Terraform candidate | `62e39f33d715cc83928390cfd5ff1728008c4053` |
| Terraform / provider / Python | `1.14.7` / `6.64.0` / `3.11.16` |
| Region | `ca-central-1` |
| State key | `quizforge/lightsail-backups/terraform.tfstate` |
| Workspace | `default` only |
| Existing role / backend settings | Existing `AWS_ROLE_ARN` / `TF_STATE_BUCKET` values; this workflow requires secret copies under the same names before live inspection |
| Existing private recipient | Secret `AWS_BUDGET_ALERT_EMAIL`; never copy its value into source or reports |
| Historical read-only evidence | Run `35647550787`: 13 creates, no updates/deletes, no apply |

The read-only plan and actual-host load/sign-in tests do not establish live S3
recovery or delivered backup alerts. The snapshot is not current AWS inventory.

Preserve these supplied files unchanged:

| Repository-relative path | Supplied SHA256 |
| --- | --- |
| `infra/aws/lightsail-backups/main.tf` | `c0edc4a089a6b4158f68ca1a8eef853910384d336a90fcb36ab77ccbc0140dc0` |
| `infra/aws/lightsail-backups/tests/boundaries.tftest.hcl` | `e703f3a10b0c785b0e2a1d88d87fa27d2aacbe17708326c6f622b209ef3d346c` |
| `.github/workflows/aws-backup-plan.yml` | `f086d2e41918ade685bb5583da58a9840be9fafbe942df537e9ff51e8262bb6c` |
| `scripts/backup_plan/review.py` | `190b6c29afc2a90d85c2000392737d59d3aba9f3d87c27bc2ec8790d4ae570b3` |

The comments describing the original preparation-only configuration remain source
history, not evidence that activation occurred. No active website, host, DNS, API
key, database, account budget, USD5 AI allowance, or generation setting is changed.
The three backup policies remain unattached. No credential-delivery mechanism or
scheduled backup installation is included.

## Proposed files and responsibilities

| Path | Responsibility |
| --- | --- |
| `.github/workflows/aws-backup-activation.yml` | PR validation and intentional manual-main entry point |
| `.github/workflows/aws-backup-activation-cloud.yml` | Secret-routed reusable cloud job, concurrency, safe artifact |
| `scripts/backup_activation/__init__.py` | Package marker |
| `scripts/backup_activation/contract.py` | Invocation, exact plan, safety settings, recipient and report validation |
| `scripts/backup_activation/access.py` | Explicit OIDC session policies and separate provider/backend credentials |
| `scripts/backup_activation/readback.py` | Fail-closed collision/state probes and read-only AWS verification |
| `scripts/backup_activation/runner.py` | Private saved-plan lifecycle and checkpointed orchestration |
| `scripts/backup_activation/tests/__init__.py` | Test package marker |
| `scripts/backup_activation/tests/fixtures.py` | Synthetic Terraform/AWS fixtures, never live evidence |
| `scripts/backup_activation/tests/test_contract.py` | Plan mutations, caller restrictions, session and workflow boundaries |
| `scripts/backup_activation/tests/test_access.py` | OIDC endpoint, profile rotation, credential isolation and policy limits |
| `scripts/backup_activation/tests/test_execution.py` | Inspection/activation/verification sequencing and failure semantics |
| `scripts/backup_activation/tests/test_readback.py` | Collision, partial-state, storage, policy, subscription and alarm checks |
| `scripts/backup_activation/tests/check_provider_plan.py` | Validation-only bridge from actual mocked-provider changes into the contract |
| `docs/operations/backup-activation.md` | This runbook and Work handoff |

No existing workflow, Terraform resource, dependency lock, deployment script, or
application file needs to be replaced by this draft.

## Workflow behavior

### Pull requests

The validation job receives `contents: read` only. It has no `id-token: write`, no
private recipient, no role/backend secret inputs, and no AWS authentication.
It runs standard-library unit tests and the existing mocked Terraform boundary
test against the immutable candidate. It also checks the actual mocked-provider
resource values and unknown masks against the contract. Terraform test output
omits saved-plan configuration/header fields, so this validation-only bridge uses
the synthetic fixture for those fields; it is not live saved-plan evidence.
Provider installation downloads
packages but must not authenticate to AWS. The proposed unit fixtures deliberately
use a synthetic account, bucket, and `example.invalid` email.

### `inspect` — default manual mode

The cloud job is restricted to the named repository and `workflow_dispatch` on
`refs/heads/main`. Python also checks the caller workflow path/revision, default
workspace, and disabled debug mode. It validates the candidate's commit, supplied
source hashes and provider version, then uses the existing OIDC role with explicit
inline session policies. No long-lived access key is requested.

Inspection requires an absent/empty isolated state, an already versioned state
bucket in the expected region, and absent named backup resources. Permission,
network, malformed-response, or ambiguous-absence failures are blockers, not proof
that a resource is absent. The alarm collision probe uses exact-ARN
`ListTagsForResource`, not an account-wide composite-alarm enumeration.

A fresh plan is saved with locking enabled and is required to contain exactly the
13 initial creates. The validator rejects update/delete/replacement/no-op plans,
imports, moves, partial state, drift, extra managed resources/data sources/modules,
unapproved destinations, recipient mismatch, policy changes, and unknown required
safety values. It verifies retention, encryption, ownership, public access blocks,
unattached-policy documents, monitoring settings, and the alarm targets.

Computed creation-time bucket IDs/topic ARNs are a deliberate narrow exception:
they must have the exact pinned expression references and derive from the already
verified account and fixed names. Unknown booleans, recipients, policy documents,
retention values, or arbitrary destinations are never accepted. If the real pinned
provider's JSON shape differs from the synthetic fixtures, stop for review rather
than deleting a failing check.

The inspection report contains a redacted safety manifest and
`review_manifest_sha256`. This is a hash of public contract constants and
placeholders, **not** a hash of the private recipient, state, or binary plan.

**Inspection is infrastructure-read-only, not zero-write AWS access:** Terraform
creates/removes the exact `.tflock` object. The inspection session cannot write the
state object or create/configure backup resources. Never disable locking to bypass
a permission failure.

### `activate` — separate authorization required

After Work has reviewed the draft, sources, private settings, permissions, fresh
inspection manifest, and outstanding operational gates, an authorized operator can
intentionally dispatch `activate` on main with:

- `reviewed_manifest_sha256`: the approved inspection safety-manifest digest.
- `confirmation`: exactly `ACTIVATE RETAINED BACKUPS ONLY`.

This dispatch is not authorized by the drafting request. GitHub reruns of an
activation attempt are refused; start a new inspection/reconciliation instead.

Activation creates a **new** locked saved plan, validates its JSON and matches its
public safety contract to the approved digest. It checks state and named-resource
absence again before requesting write-restricted sessions. Immediately before
apply, it checks the saved binary's private hash, age, source and lockfile identity.
It applies that exact saved binary, once, without a second plan, `-target`, import,
force-unlock, state push, destructive rollback, or broad-policy fallback.

This design uses human approval of the public contract plus automated review of the
fresh saved binary. It does **not** claim a human separately viewed/approved that
binary between generation and apply. If that additional human approval is required,
stop: a separately designed private review/retention channel is needed. Do not
transfer the private plan through a public artifact or relax the guard.

The public digest intentionally cannot detect a private setting changed between
inspection and activation; each plan is validated against the current private
settings. Work must independently verify that the approved account, backend and
recipient settings have not changed between those steps.

### `verify` — existing infrastructure only

This mode obtains a read-only resource session and does not initialize the backend,
plan, apply, publish a message, or repair drift. It verifies the exact bucket's
location, ownership, ACL, four public-access blocks, versioning, AES256 encryption,
retention rules, bucket policy and tags. It reads the three exact IAM policies,
their default documents, tags, zero attachments and zero permissions-boundary use.
It reads the topic's identity, owner-scoped default policy and tags, exactly one
approved email subscription, and the alarm's metric, dimensions, targets, enabled
actions, missing-data treatment and current state.

The summary distinguishes `pending`, `confirmed`, and `unverified` subscription
states. `ALARM` can be expected before a host is emitting backup-health metrics;
it is not evidence of a broken validator or an instruction to disable the alarm.
Confirmation and SNS/API acceptance are not proof of inbox receipt. No workflow
mode grants `sns:Publish` or `cloudwatch:SetAlarmState`.

## Access and privacy boundaries

The role ARN, backend bucket and private recipient must reach the cloud job only as
GitHub **secrets**, so GitHub masks them before any step/environment rendering.
The existing repository variables are not deleted or rewritten by this change, but
before another live inspection the current role/backend values must also be stored
as repository secrets named `AWS_ROLE_ARN` and `TF_STATE_BUCKET`. The recipient
continues to use the existing `AWS_BUDGET_ALERT_EMAIL` secret. There is no
`secrets: inherit` or new environment.

Earlier inspection runs rendered the role/backend repository variables before the
workflow's runtime mask command took effect. Do not repeat that pattern. Treat
removal of those historical public workflow logs as a separate evidence-retention
decision; deleting a run also deletes its logs/artifacts and is not performed by
this code change.

Two independent OIDC sessions assume the same existing role: `qf-resources` for the
provider, and `qf-state` for the backend. The backend profile is explicitly pinned in
its configuration. Terraform's environment is rebuilt from an allowlist and cannot
inherit ambient AWS keys, endpoint overrides, `TF_CLI_ARGS`, tracing or GitHub tokens.
Readback replaces the write-profile files with read-only resource credentials;
this discards local references, but is not AWS-side revocation before expiry.

Every requested inline policy is compact-encoded and checked against the 2,048
character plaintext limit before STS. No additional managed session policies or
session tags are supplied. The STS packed-policy result is also checked. Exact
account/resource ARNs replace the earlier read-only workflow's name/account
wildcards. `sts:GetCallerIdentity` is the only session statement with `Resource: *`.
The approved **unattached health/uploader policy documents** retain their existing
namespace-conditioned `cloudwatch:PutMetricData` wildcard as required by the pinned
configuration; those policy permissions are not granted to this workflow session.

The resource session excludes backup object contents, other hosts/stacks, budgets,
DNS, database resources, API/access keys, identity modifications and policy
attachments. The backend session confines state `GetObject`/activation `PutObject`
to the exact state key. Only its exact lock object can be deleted. Workspace listing
uses a disabled prefix inside the backup namespace; all non-default workspaces are
refused. If the existing state bucket requires KMS or different backend permissions,
stop for authorized review; no KMS grants or fallback are added automatically.

A session policy only narrows the existing role's effective permissions. It cannot
supply permissions the role lacks. Missing IAM actions, trust conditions, resource
policies, permission boundaries, SCP authorization, or locking rights remain blockers.

Private state, source-derived plans, binary hashes, credentials, email, account and
backend identifiers and raw diagnostics are kept under a private temporary directory
and are never uploaded. The public JSON report is constructed from allowlisted
constants, booleans and enumerations. Only that exact path is uploaded. Error text
is a static code, never a provider diagnostic. A refusal may also include a
`diagnostic_id` made only from a reviewed Terraform resource address and expected
field path (for example, a versioning block); it never includes plan values, ARNs,
account IDs, recipient data, state-bucket names or provider messages. Normal/handled-failure cleanup removes
temporary files; runner termination can prevent final cleanup/checkpoint publication.
GitHub-hosted runner teardown is still part of the privacy assumptions.

## Partial apply, collisions and state recovery

A failure before apply is reported as `blocked_no_apply_attempted`. A failure after
apply starts is `apply_failed_possible_partial_resources`, not “nothing changed.”
Successful Terraform exit followed by a failed readback is
`apply_completed_readback_not_verified`, with the apply-completed flag preserved.
A checkpoint is written before apply starts so an interrupted run can retain an
explicit unknown outcome. A missing final artifact is never proof of no changes.

**Do not rerun activation after an interrupted or failed apply.** Preserve the safe
run identity/checkpoints and have an authorized operator inspect the exact backend
state/version and exact named resources privately. A nonempty state or existing
resource blocks initial activation, including resources left by this workflow.
Do not delete/recreate, import, attach policies, change ownership, restore a stale
state version, force-unlock, or issue `terraform state push` automatically.
A reviewed reconciliation plan and separate authorization are required before any
such operation. Prove a lock is stale before considering an authorized unlock.

A particularly important unresolved failure is **remote state persistence failure**:
Terraform can produce a local emergency state after creating resources. This draft
will not upload that sensitive file to a public artifact or invent an additional
private-storage destination; its ephemeral cleanup can therefore remove the local
copy. Work must approve a private emergency-state recovery/capture procedure before
live activation, or accept the need for separately authorized manual inventory and
state reconciliation. This is a genuine operational gate, not a completed capability.

GitHub concurrency serializes this workflow and the Terraform backend lock protects
cooperating operations against this state. Neither prevents an unrelated operator
from creating the same names between the absence probe and an AWS create/upsert.
SNS topic creation and CloudWatch alarm creation are not general compare-and-swap
operations. Work must ensure an exclusive change window for these exact names; do
not claim the preflight alone provides cross-system atomicity or collision immunity.

## Assumptions and unresolved questions for Work

1. **Source/installation compatibility.** Is the remote branch still based on the
   supplied commit? Does the immutable candidate contain the committed provider lock
   and only the expected root configuration? Are the existing hash-locked SDK
   dependencies compatible with `Config(ignore_configured_endpoint_urls=True)`?
   The lockfile contents and dependency file were not included in the supplied
   snapshot. The inherited action version tags are not full-SHA action pins; verify
   availability/provenance and repository pinning policy before merge. Do not change
   the Terraform candidate or tool versions merely to make a check pass.
2. **Reusable workflow and private settings.** Before another live inspection,
   copy the existing role/backend values into repository secrets `AWS_ROLE_ARN`
   and `TF_STATE_BUCKET` without changing their values; keep
   `AWS_BUDGET_ALERT_EMAIL` as the existing recipient secret. Verify the actual
   caller `GITHUB_WORKFLOW_REF`/`GITHUB_WORKFLOW_SHA` and OIDC claims for this nested
   workflow, and verify secret masking with synthetic values first. A role trust
   condition tied to another workflow may refuse it. Do not modify role trust or
   copy private settings into source to bypass that restriction.
3. **Exact existing permissions and backend.** Can the existing role assume all
   requested restricted sessions and access the exact versioned backend/lock object
   without additional KMS or cross-account access? Can each provider/readback API
   execute under the exact actions/ARNs? Verify `ListTagsForResource` not-found
   behavior for an absent metric/composite alarm. No blanket `DescribeAlarms`,
   `ListPolicies`, wildcard IAM action, or role attachment is an acceptable shortcut.
4. **Real saved-plan compatibility.** Does Terraform 1.14.7/provider 6.64.0 emit the
   expected complete JSON, optional defaults, list ordering and creation-time
   reference shapes? A credential-free synthetic fixture is not proof. Privately
   compare a fresh real inspection plan; any adjustment must preserve fail-closed
   required safety fields and the immutable-source checks.
5. **Operational authorization.** Who authorizes activation and freezes changes to
   the names/private settings? Is public-contract approval sufficient, or is a
   human approval of the exact saved binary required? What approved private process
   handles emergency state loss? These must be resolved before cloud writes beyond
   the inspection lock, not treated as authority implicit in this draft.
6. **Notifications and real recovery.** Who confirms the existing recipient's
   subscription and records inbox evidence? An authorized activation can send the
   subscription confirmation and ordinary alarm notifications even though there is
   no explicit test publish. The pinned SNS default policy, actual alarm delivery,
   encrypted S3 restore, independent keys, separate identities, backup schedule and
   rebuild timing all still need their own evidence and authorization.

## Verification steps — for Work, not performed in this draft

### 1. Reconcile source without disturbing unrelated work

In the existing repository, inspect status/worktrees and fetch refs using the
connected repository tools or the following commands. Inspect output privately.
Do not reset, clean, or overwrite dirty worktrees.

```sh
git status --short
git worktree list
git fetch origin main feat/backup-activation
git log -1 --oneline origin/main
git log -1 --oneline origin/feat/backup-activation
```

Compare the remote branch to the supplied `1bd5b3a...` base and the older local
`b23b7b9` worktree. Apply only the proposed files to an appropriate reconciled
implementation branch, inspect the diff, and confirm no existing configuration,
source pin, budget, AI setting, role, secret or application route was changed.

The local `candidate` checkout used by these commands must be clean and detached at
`62e39f33d715cc83928390cfd5ff1728008c4053`; create it from the authorized existing
repository without changing another worktree. Do not reuse an unrelated directory.

### 2. Run static/unit and mocked Terraform checks without AWS credentials

From repository root, with the pinned Python/Terraform versions and a clean candidate:

```sh
python -m unittest discover -s scripts/backup_activation/tests -p 'test_*.py' -v
python -m scripts.backup_activation.runner check-source
# Use the repository-approved actionlint installation/version.
actionlint .github/workflows/aws-backup-activation.yml .github/workflows/aws-backup-activation-cloud.yml
```

Then run in a credential-free environment, with no AWS profile, access key, OIDC
variables, endpoint overrides or Terraform argument overrides exported:

```sh
export AWS_EC2_METADATA_DISABLED=true
export TF_IN_AUTOMATION=true
export TF_INPUT=false
export TF_DATA_DIR="$(mktemp -d)"
terraform -chdir=candidate/infra/aws/lightsail-backups init -backend=false -lockfile=readonly -input=false
terraform -chdir=candidate/infra/aws/lightsail-backups test -filter=tests/boundaries.tftest.hcl
rm -rf -- "$TF_DATA_DIR"
unset TF_DATA_DIR
```

Confirm the PR run has no cloud job, OIDC permission or private settings. Inspect
that only the safe summary path can be uploaded. Test rejections for updates,
deletes, replacements, imports, altered policies, unknown required safety fields,
wrong recipient/resource/account/region, PR/fork/tag invocation, oversized sessions,
changed/expired plans, missing permissions and partial state. Test interruption and
failed readback without changing real infrastructure. The string-level workflow
unit tests do not replace `actionlint` or GitHub's own workflow validation.

### 3. Authorized live inspection only

After the relevant code is reviewed and merged to main, and Work confirms permission
to use the existing AWS access route, manually dispatch `inspect`. Do not choose
activation to debug inspection. Check the fresh 13-create report, pinned source,
exact-state binding, private-recipient match, policy size checks and safe artifact.
Check no private values leaked, no backup resources/state object were written, and
only the intended lock object's transient lifecycle occurred. A permissions failure
must stop here with a narrowly described missing operation, not an IAM expansion.

Review provider/backend calls and actual plan shape privately. Do not upload the raw
JSON plan, state, logs or credential files when gathering evidence. Require the
exclusive change window, stable private settings and approved recovery procedure
before proceeding beyond inspection.

### 4. Separately authorized activation and readback

With unresolved operational gates settled, review the manifest and intentionally
dispatch `activate` with its digest and exact confirmation phrase. Verify the report
separately records apply completion and infrastructure readback. On any failure,
follow the partial-apply section rather than rerunning. Have the approved recipient
confirm the SNS subscription privately; do not automate inbox access or token use.
Run `verify` to read the updated subscription status without another apply.

### 5. Keep remaining launch gates separate

A future separately reviewed notification test must be one bounded message to the
exact approved topic after verifying it has only the approved confirmed recipient.
Record SNS acceptance separately from the matching inbox message/nonce and receipt
time. Do not grant publish rights here, send to an arbitrary ARN, subscribe additional
addresses, mutate the alarm state, or infer inbox receipt from a message ID.

Test actual failure, stale-backup and missing-heartbeat alarm delivery separately.
Prove encrypted S3 recovery using exact retained versions, independent retained keys,
separate uploader/recovery credentials, the real backup schedule and measured rebuild
time. Infrastructure activation alone satisfies none of those gates and is not
permission for a permanent website launch.

## Official references used for the design

- GitHub reusable workflows and explicit secrets:
  https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows
- GitHub workflow syntax/context availability:
  https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax
  https://docs.github.com/en/actions/reference/workflows-and-actions/contexts
- AWS STS web-identity sessions, intersection and size limits:
  https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRoleWithWebIdentity.html
- Terraform S3 backend, profiles, lockfile and state permissions:
  https://developer.hashicorp.com/terraform/language/backend/s3
- Terraform JSON output and unknown/reference representations:
  https://developer.hashicorp.com/terraform/internals/json-format
- SNS and CloudWatch action/resource authorization:
  https://docs.aws.amazon.com/service-authorization/latest/reference/list_sns.html
  https://docs.aws.amazon.com/service-authorization/latest/reference/list_cloudwatch.html

Work should verify current provider/API behavior rather than treating these references
or the synthetic fixtures as runtime evidence. Use the current official action entries for the exact service.

## Concise handoff to Work

Check source freshness and reconcile the older local worktree with the remote
implementation branch, preserving unrelated changes. Review and apply only these
proposed files, then run unit tests, actionlint and the pinned credential-free
Terraform mock tests. Verify private-setting scope, OIDC claims, exact existing
permissions and a fresh manual-main inspection. Stop on permission, collision,
plan-shape or recovery-process blockers. Actual activation, notification delivery,
state repair, IAM expansion and production launch require their own authorization.
Report code/test results separately from live infrastructure, recovery and inbox
verification. This package is a draft, not tested or deployed evidence.

# Temporary real-Lightsail capacity test

This prepares the next experiment for the USD15–20/month candidate. It does not
deploy the production website. The earlier [measured capacity failures](aws-small-server-capacity.md)
remain recorded and the application PR127 remains unmerged.

## Reviewed scope and cost

- One `small_3_0` Linux instance in `ca-central-1`: 2 GB, 2 vCPUs, 60 GB SSD,
  public IPv4; refuse a catalogue price above USD12/month or changed dimensions.
- Fixed Ubuntu 24.04 blueprint, no paid add-ons, snapshots, static IP allocation,
  load balancer, managed database, NAT gateway or model calls.
- Build the pinned laboratory on a separate GitHub runner with no AWS identity,
  then transfer its checksum-verified image through SSH. No registry or bucket
  is created for the image. The temporary image artifact expires after one day.
- Normal cleanup deletes the instance and verifies absence. An independent
  EventBridge Scheduler deletion is armed **before server creation**, at two
  hours after the test starts. The controller has a separate 50-minute work
  deadline, leaving time for cleanup within its one-hour AWS session.
- Expect only a few US cents of server time for a completed two-hour experiment,
  before tax, credits and other existing account costs. This is an estimate,
  not a hard spending cap. Deletion may be delayed or fail; the fallback retries
  for up to one hour and reports must be checked. Merely stopping a Lightsail
  server does not stop its instance charges. No notification email is sent.
- Bounded Docker logs (two 5 MB files per container); aggregate results, host
  samples and synthetic-only failure logs are retained in GitHub for seven days.
  The disposable test has no user data to back up. Permanent backups, a tested
  restore and billing alert recipients remain production prerequisites.

## Execution boundaries

`.github/workflows/aws-lightsail-test.yml` runs offline boundary checks on PRs.
Cloud operations require a **manual dispatch on main**. `inspect` is the default
and has a read-only AWS session. It reads the account plan, price, image, zone,
cleanup configuration and leftover test instances. Neither inspect nor run can
upgrade the Free account plan. Catalogue access does not prove launch permission
or Free-plan eligibility. An unavailable service fails closed.

`run` uses the existing GitHub OIDC role, narrowed by an inline session policy.
It cannot modify IAM roles, source data, production services, DNS or Cognito.
One invocation creates at most one named instance, and overlapping manual runs
are serialized. A previous capacity instance blocks a new launch. GitHub run ID
and attempt identify every test; cleanup requires both the exact name and tags.
The policy cannot enforce bundle price or one-server count by itself; reviewed
main-branch controller checks enforce those bounds. Do not give arbitrary code
the deployment role or reuse the test Purpose tag on production resources.

The server receives no cloud/model/database credentials. After startup its public
firewall is replaced with SSH from the current runner's single IPv4 address;
there are no published application/database ports. Until replacement, Lightsail
may briefly have its default SSH rule. Ubuntu key authentication and subsequent
SSH hardening apply. AWS-supplied SSH host keys are required, strict host checking
is enabled, and temporary access keys stay in a private runner directory that is
removed after use. The container runs as an unprivileged user, without networking,
Linux capabilities or swap, inside the same 1536 MiB limit as the CI experiment.

## Cleanup prerequisite

`infra/aws/lightsail-test-cleanup` contains exactly three Terraform resources:
one schedule group, one Scheduler execution role and its deletion-only policy.
It creates no server or schedule and does not grant the role to GitHub. The role
can delete only Canadian Lightsail instances tagged
`Purpose=quizforge-capacity-test`; only the same account's dedicated schedule
group may assume it. The controller verifies its complete trust and permissions
before creating anything billable. Normal cleanup deliberately leaves the
one-time schedule armed, even after confirmed deletion, to cover ambiguous
creation responses. Scheduler automatically removes it after completion.

The approved prerequisite was applied successfully on September 20, 2026:
[run 35495461922](https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/35495461922)
created exactly the three resources, with zero changes/deletions. The following
[read-only inspection](https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/35495530857)
confirmed the complete permissions and no preflight blockers.

The first two test attempts created no server. The
[diagnostic attempt](https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/35495976087)
identified Scheduler's validation error: the universal target requires the
PascalCase `InstanceName` field. Its input now uses `InstanceName` and
`ForceDeleteAddOns`; the direct Lightsail boto3 API uses lower-camel fields and
its request-shape validator does not prove Scheduler input compatibility.
The schedule still must be created and read back before instance creation.
No performance result is established by these failed launch attempts.

The [next diagnostic run 35496414231](https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/35496414231)
successfully created and verified its cleanup schedule, then AWS denied
`CreateInstances` because the temporary session omitted the dependent
`lightsail:TagResource` action. It recorded `cleanup_schedule_verified: true`,
`instance_creation_attempted: true`, `live_test_performed: false` and confirmed
`cleanup.instance_absent: true`. This is a session-policy defect, not evidence
of an account-plan restriction or an OCR capacity failure.

The prepared session-policy correction allows `TagResource` only on this
account's Canadian instance ARNs, with the exact current run's `TestId`, the
test `Purpose`, and only the `Purpose`, `TestId`, `DeleteAfter` keys. Read-only
and cleanup sessions cannot tag anything; untagging is not allowed. Shared
statements are combined and an unused read is removed to retain STS's 2048-byte
limit without wildcard actions. The existing role and cleanup role are not
modified. This permission is needed for tags on the create request; the
controller never calls the separate tagging API.

Lightsail instance ARNs contain generated IDs, so this tag permission cannot
be expressed as a test-name ARN before creation. The request-tag condition
does not by itself prevent re-tagging an existing instance: that remains a
reviewed-controller boundary. Only trusted main-branch code receives the
temporary session. Because this adds effective tagging access to the session,
the browser confirmation policy requires approval before dispatching a run with
the correction. Prepare/review it first; do not silently remove the session
boundary or add broad role permissions to overcome this denial.

Until that corrected run completes, live capacity remains unverified. The prior
CI sustained-profile timing failures remain authoritative, and the website has
not been switched to the proposed AWS server.

Provision this small prerequisite module using the existing encrypted Terraform
state bucket and the **new** key `quizforge/lightsail-test-cleanup/terraform.tfstate`.
Never use the foundation or production state key. Review a saved plan: it should
show only these three creates and zero updates/deletes before applying. Creating
the role requires IAM permission; the test controller deliberately has none.
The existing OIDC deployment role also needs the actions in
`scripts/lightsail_test/policy.py`: its effective permissions are the intersection
of that role and the inline session boundary. Do not solve AccessDenied by
attaching AdministratorAccess. Use the exact reviewed statement scope.

The separate `aws-lightsail-cleanup.yml` manual workflow defaults to `plan` with
read-only credentials and no state lock writes. It prints the concrete AWS plan
and checks that only the three expected resources would be created, with the exact
tag-scoped policy and same-account Scheduler trust. Its explicit `apply` operation
uses a scoped session that can create only this named role, policy and schedule
group and write only their isolated state. It cannot launch Lightsail or grant
permissions to the GitHub role. Apply uses the checked saved plan, refuses updates,
replacements/deletions or additional resources, and requires explicit authorization
for this new AWS permission before browser dispatch. No raw plan/state artifact is
uploaded.

After the prerequisite exists, dispatch `inspect`. Resolve reported blockers
without upgrading the account or broadening permissions automatically. Then
dispatch `run` once. No raw source credentials, production passwords or real
PDFs should be supplied. For emergency cleanup, dispatch `cleanup` with the exact
`test_id` from `run.json`; it has deletion-only access to tagged test instances.
If GitHub is unavailable, delete the exact named/tagged test instance through AWS
and verify it is absent. Do not remove the cleanup role/group while an instance
or fallback invocation remains outstanding.

## What the experiment measures

Application: `f3c63fec355fc8552e4a68142860f88e874281f6` (PR127).
Harness: `52f44f16794369601f21e429b15389efcf7d62e4` (PR130).
The build first requires PR127's exact current head to pass its existing gates,
then refuses any head other than the reviewed pin. A later app update requires
reviewing and changing the pin rather than silently testing another version.

The unchanged synthetic harness exercises real OCR, background progress,
admission/ownership, cancellation, restart recovery, history and health responses.
It runs both 2-CPU burst and 0.4-CPU constrained profiles on the actual server,
in that order, with the original targets. The second profile approximates the
documented baseline; it does **not** prove that natural AWS burst credits were
exhausted. AWS CPU/burst metrics and host memory samples provide context; delayed
or unavailable metrics are recorded as such. A profile failure fails the run,
but both profiles' results are retained before cleanup.

The pinned harness's original `live_aws_instance: false` field is preserved for
reproducibility; `run.json` and `capacity-results/host.json` identify actual AWS
placement. This wrapper must accompany the original reports. It is an API/OCR
hardware experiment, not a public website, browser, Cognito or production-backup
test. Source documents/accounts are synthetic and the laboratory image must
never be used for production.

Passing this test is evidence for capacity at the measured workload, not final
deployment approval. Production configuration, encrypted off-instance backups,
restore rehearsal, model spending limits, notification recipients, account/history
migration and final HTTPS/domain checks still come next.

Primary references checked September 20, 2026:
[Lightsail pricing](https://aws.amazon.com/lightsail/pricing/),
[hourly billing and stopped-instance charges](https://aws.amazon.com/lightsail/faq/),
[Scheduler universal targets](https://docs.aws.amazon.com/scheduler/latest/UserGuide/managing-targets-universal.html),
[Scheduler trust constraints](https://docs.aws.amazon.com/scheduler/latest/UserGuide/cross-service-confused-deputy-prevention.html),
[tag-scoped instance deletion](https://docs.aws.amazon.com/lightsail/2016-11-28/api-reference/API_DeleteInstance.html),
[temporary SSH access](https://docs.aws.amazon.com/lightsail/2016-11-28/api-reference/API_GetInstanceAccessDetails.html).

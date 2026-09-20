# Temporary real-Lightsail capacity test

The PDF fix passed both real profiles on September 20, 2026 in
[run 35526563913](https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/35526563913),
including sustained timing, bounded restart recovery and queue cleanup.
The temporary server was deleted and absence confirmed. See the
[capacity decision and measurements](aws-small-server-capacity.md#real-lightsail-retest-after-the-pdf-fix).
The earlier failed run remains recorded. This did not deploy the production
website; application PR127 remains draft and unmerged.

The subsequent [optimization retest 35533918641](https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/35533918641)
also passed both capacity profiles, with deletion confirmed at 20:09:03 UTC.
Its OCR timings were mixed, so the local grayscale speedup is not an established
AWS improvement. See the [full comparison](aws-small-server-capacity.md#real-lightsail-retest-of-the-pdf-optimizations)
and [preserved reports](evidence/lightsail-capacity-35533918641.json).

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
SSH hardening apply. A unique Ed25519 host identity is generated for each temporary
server and installed through its authenticated AWS creation request. The SSH client
pins that exact public key before connecting. Strict host checking is enabled, and temporary access keys stay in a private runner directory that is
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

The user approved the tagging correction and PR139 was merged. The
[first successful launch](https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/35518533966)
proved creation and ordinary deletion worked, but setup stopped before measuring
OCR. A [bounded readiness retry](https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/35518969921)
confirmed that `expiresAt` and host `publicKey` remained absent for five minutes;
the instance was deleted and absence confirmed. Neither run is a capacity result.

AWS documents these response fields as optional. A subsequent attempt using
AWS SHA-256 fingerprints still could not obtain trusted host identity. That path
is replaced by a unique Ed25519 host key generated by the controller before
creation. Only this disposable server-identity private key is embedded in the
in-memory user-data request; it is never printed, uploaded as an artifact, or
reused, and it authorizes no client login. AWS retains user data with the temporary
instance, and the key is installed with mode 0600 on that instance. Deletion removes
this test resource; the key must never be copied to a permanent deployment.
No cloud, model, database, or real-user credential is supplied to the server.

The client pins the corresponding public key independently of network discovery.
StrictHostKeyChecking stays enabled; a different host key prevents authentication.
The bootstrap restricts the host algorithm to Ed25519 and reloads SSH only after
configuration validation. Temporary login credentials still come from the same
AWS access-details API. The controller validates the AWS-issued certificate's
signature, user principal and validity interval, and also checks expiresAt when
AWS supplies it. The [next launch](https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/35519982984)
showed that AWS's login certificate lasts less than the original 45-minute
requirement; the server was deleted without running the benchmark. Each new SSH
or SCP connection now fetches and validates fresh credentials in a separate private
directory, removed after that connection finishes or fails. Both the signed
certificate and any API expiry must have more than 30 seconds remaining for the
10-second connection timeout. Authentication expiry does not terminate an already
authenticated SSH session. The 50-minute controller limit and two-hour independent
deletion schedule remain unchanged.
Readiness logs distinguish successful authentication with pending bootstrap from
fixed SSH failure categories. Raw SSH errors and credentials are not printed.
Private key and certificate files are terminated with a newline for OpenSSH
compatibility, while retaining exclusive creation and 0600 permissions.
The launch script is POSIX-shell compatible even when a launcher does not honor
its shebang. It installs the generated identity at Ubuntu's standard Ed25519
host-key path, derives the matching public-key file, explicitly includes its SSH
configuration, validates it, and uses reload-or-restart for socket-activated SSH.
These changes address bootstrap compatibility without accepting a different host
identity or disabling client host verification. A filesystem-sandboxed shell test
exercises real key generation/installation; it stubs service and package operations
and does not prove the live Ubuntu service has activated the key.
No new IAM permission, persistent login key pair or open application port is needed.

Validated synthetic capacity reports and host metadata are printed in logs so
results remain inspectable if artifact materialization is unavailable.

The corrected bootstrap authenticated successfully and both profiles ran in
[run 35521952974](https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/35521952974).
The sustained profile failed three timing targets, its restart-recovery completion
wait, and the final queue cleanup check. The prior CI results remain recorded;
the new hardware result does not waive any target. The website has not been
switched to the proposed AWS server. The [structured reports](evidence/lightsail-capacity-35521952974.json)
preserve the original harness data together with live host and deletion evidence.

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

Application: `bff2ab7612951fe1612268af3772794651ea86c8` (PR127, bounded 24-hour text cache, selected-page processing, grayscale OCR).
Harness: `52f44f16794369601f21e429b15389efcf7d62e4` (PR130).
The earlier passing AWS result above used `df1946500335cc7c614796723357680875bf0123`; the new
application was remeasured in run 35533918641. All required CI gates, including production-image
OCR, browser and full-stack tests, passed on this new exact head. Only the
application pin changes for this retest: the harness, targets, bundle, permissions
and cleanup controls stay fixed. The local 13.8% OCR improvement was not reproduced as a consistent AWS
speedup. This harness does not measure selecting fewer pages or waiting
24 hours before a cache hit.
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

# Lower-cost AWS capacity evaluation

The owner authorized testing the approximately USD15–20/month alternative.
This does not activate a permanent instance or migrate live accounts/history.
The previous USD88 managed-service proposal remains unapplied.

## Proposed small-server layout

Use one Canadian Lightsail Linux instance with 2 GiB RAM, two burstable vCPUs,
60 GB SSD and a bundled public IPv4 address. The published server price is
USD12/month; USD3–8/month is an initial low-traffic allowance for retained backups,
DNS, secret storage and monitoring, not a fixed quote or spending cap. Model calls,
taxes, traffic overages and credits are separate. Cognito remains the external AWS
identity service. The website, API, enrollment process, PostgreSQL and bounded
cache would share the instance. No separate ALB, Fargate tasks, RDS or ElastiCache
would run. A local TLS reverse proxy replaces ALB routing. Managed WAF is not
included in this price; authentication, upload/rate limits and model quotas remain
necessary and do not provide equivalent edge filtering.

This changes the operational responsibility: database patching, encrypted off-
instance backups, tested restore and host recovery must be implemented before
real migration. A failed host affects all co-located services. Keep separate
database roles and processes, private database/cache listeners, exact origins,
verified transport, MFA, retained source data and full transfer reconciliation.
The existing RDS-only production endpoint guards must be deliberately adapted
and reviewed for a separate self-hosted profile; do not bypass them with staging
flags in production. The test image is not a production deployment image.

The 4 GiB Lightsail server costs USD24/month and has the same 20% baseline per
vCPU as the 2 GiB server. Extra RAM does not increase its sustained CPU baseline.
Increasing RAM is a response to measured memory pressure, not a fix for slow OCR
after burst capacity is exhausted.

## Reproducible measurement

`.github/workflows/aws-small-capacity.yml` resolves application PR127 only after
its exact current commit passes the existing backend, frontend, browser,
database-security, dependency and container checks. It builds the canonical
`main:app` application code with its locked dependencies. The test adapter replaces
external authentication with two synthetic identities; it never changes the
production source or proves real Cognito login/email behavior.

Both profiles put PostgreSQL 17, Redis, API, separate identity process, persistent
model-budget guard, TLS proxy, fixtures and load client in **one 1536 MiB cgroup**,
with no swap. This reserves 512 MiB of a 2 GiB host for the OS and container engine.
All processes run as an unprivileged user, with dropped Linux capabilities, no
published ports and Docker networking disabled. No AWS credentials, real user
data, production passwords or paid model calls enter the test.

The first full-stack experiment found native OCR stalled the API despite fitting
in memory. PR127 now has an opt-in isolated PDF subprocess for the small server:
one active job, one waiting request, overload rejection, 120-second execution
deadline, 768 MiB worker address-space limit and CPU limit. It caps a document at
100 total pages / 30 scanned pages and bounds page dimensions and result size.
The host must run one API worker for these queue limits to be host-wide. Timed-out
children are killed and their queue slots released. This is resource isolation,
not a complete security sandbox for malicious files.

| Profile | CPU quota | Meaning |
| --- | --- | --- |
| Burst | 2 vCPUs | Approximate available burst capacity |
| Sustained | 0.4 vCPU | Two vCPUs times the documented 20% baseline |

This is a constrained CI experiment, not a live Lightsail hardware benchmark.
The CPU model, storage latency, kernel and burst-credit accounting can differ.
The client and synthetic fixture generator also consume the capped resources.

The acceptance targets are fixed before measurement:

| Workload | Target |
| --- | --- |
| Cold 100-page selectable-text PDF | <=10 seconds |
| Cold 1-page image-only PDF | <=15 seconds |
| Cold 10-page image-only PDF | <=60 seconds |
| Cold 30-page image-only PDF | <=120 seconds |
| Two different cold 10-page scans plus 20 history CRUD/ownership cycles | <=120 seconds |
| Warm 10-page cached scan | <=3 seconds |
| Three simultaneous new scans | Two complete; the excess request receives 429 |
| A 101-page PDF | Rejected with 413 before extraction |
| Concurrent health checks | No failed requests; p95 <=1 second |
| Resource and data boundaries | No OOM kills or exited services; all expected OCR pages/text recovered; cross-owner history hidden; disabled AI quota rejects calls |

All PDFs are generated synthetic biology notes, with 150 DPI image pages and
files below the application's 15 MiB limit. Clean synthetic scans do not cover
every real-world scan, language, page dimension or malicious document. Those
limits must be bounded before exposing the small server publicly.

## Results

The initial complete-stack [run 35488220901](https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/35488220901)
used application `d185d5a63b4506d48ff5fa3189a025c9d2541f01`:

| Metric | 2 CPU burst | 0.4 CPU sustained |
| --- | ---: | ---: |
| Peak whole-container memory | 801.56 MiB | 772.14 MiB |
| Cold text, 100 pages | 0.124 s | 0.196 s |
| Cold scan, 10 pages | 21.704 s | 33.094 s |
| Cold scan, 30 pages | 65.191 s | 98.403 s |
| Failed health checks during OCR | 19 / 29 | 36 / 41 |
| Health p95 | 5.009 s | 5.067 s |

Neither profile passed because the API became unresponsive while OCR ran. No OOM
kills occurred and all services remained alive. The initial history exercise also
had a test-harness bug: it tried to parse the intentionally empty POST 201 response
for the new row's UUID. The test now obtains the UUID through authenticated GET,
matching the browser. That earlier history result is not evidence of a product
ownership failure.

The worker fix passed three focused functional tests, including a real subprocess
timeout/termination and subsequent successful extraction. Full-stack retesting
is in progress. Do not infer a deployment pass from image builds or the repository's
generic required PR gate; both capacity profiles have explicit outcomes.

Sources checked September 20, 2026:
[Lightsail pricing](https://aws.amazon.com/lightsail/pricing/),
[CPU baseline](https://docs.aws.amazon.com/lightsail/latest/userguide/baseline-cpu-performance.html),
[Cognito pricing](https://aws.amazon.com/cognito/pricing/).

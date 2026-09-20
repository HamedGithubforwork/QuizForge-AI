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

The capacity workflow in [PR130](https://github.com/HamedGithubforwork/QuizForge-AI/pull/130)
(`.github/workflows/aws-small-capacity.yml`) resolves application PR127 only after
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

The opt-in worker fix passed three focused functional tests, including a real
subprocess timeout/termination and subsequent successful extraction. The complete
backend CI reported 246 passed / 13 skipped; separate PostgreSQL security,
browser integration, dependency and build checks also passed. Application PR127
remains draft at `9346a8e57a79fe100f5995c30aadcf70919d0b6b`.

The [worker retest, run 35488763989](https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/35488763989)
used that exact application with controller `75b7b188f8289a67e68995b8782f3429854ab3bb`:

| Metric | 2 CPU burst | 0.4 CPU sustained |
| --- | ---: | ---: |
| Peak whole-container memory | 695.67 MiB | 648.70 MiB |
| Cold text, 100 pages | 1.701 s | 3.715 s |
| Cold scan, 1 page | 3.658 s | 8.310 s |
| Cold scan, 10 pages | 23.180 s | 52.476 s |
| Cold scan, 30 pages | 66.599 s | HTTP 503 after worker deadline |
| Two 10-page scans + history cycles | 46.670 s | 106.094 s |
| Warm 10-page cached scan | 0.024 s | 0.082 s |
| Health successes | 742 / 742 | 1492 / 1492 |
| Health p95 | 0.003 s | 0.068 s |
| Overall profile | PASS | FAIL: 30-page scan |

Both profiles kept all services alive with no OOM kills. Twenty history cycles
preserved ownership and left zero synthetic rows. The disabled model budget
rejected generation with zero reservations. Three simultaneous uploads produced
two successes and one explicit 429; the 101-page document was rejected with 413.
The 30-page sustained failure is a real capacity limitation, not a waived test.

**Decision:** the memory footprint supports the small-server proposal, and the
process isolation fixes the observed API stalls. The USD15–20 layout is a viable
candidate for the measured light workload, but it is not approved as an unrestricted
production replacement. Before launch, either implement a bounded background
upload job with progress/status and ownership protection for larger scans, or
agree and enforce a smaller scanned-page limit. A larger-memory USD24 Lightsail
bundle has the same baseline CPU and does not establish a fix for this deadline.
No permanent server, paid model request, account migration or domain routing was
started. These results are CI simulations; actual Lightsail hardware, storage,
network, backups and recovery remain live deployment checks.

## Account readiness

The separate `aws-small-readiness.yml` workflow only reads the account plan and
Canadian Lightsail bundle catalogue using an explicit read-only AWS session.
It cannot create instances, change permissions, upgrade the account or alter DNS.
Catalogue access alone does not prove creation permission or Free-plan eligibility.

## Authorized background-processing follow-up

After the sustained 30-page failure, the owner authorized durable background OCR.
Application PR127 now includes an opt-in private SQLite queue, authenticated job
ownership/status/cancel, page progress and browser refresh/resume. The queue uses
one active child, four pending jobs across the host, one pending job per owner,
four new jobs per owner per hour, 128 MiB reserved payload and one-hour retention.
Raw PDFs are removed on success/failure/cancellation. Isolated child CPU, memory,
file and page limits remain; background wall time is separately bounded at 600s.
Operational details are in `docs/background-pdf-processing.md` on the app branch.

The follow-up experiment retains the same synthetic PDFs, full stack, 1536 MiB
cgroup and 2 / 0.4 CPU profiles. It adds synthetic owners to test queue fairness.
The new contract is **HTTP 202 admission within 2 seconds** and **30-page job
completion within 240 seconds**. The earlier failed synchronous 120-second target
remains recorded above. The proxy now times out idle upstream responses after
10 seconds, demonstrating that a long HTTP request is unnecessary. Existing
completion targets for 1-page, 10-page, 100-page text and two concurrent 10-page
scans remain. Warm completed-job reuse must finish within three seconds.

Four pending jobs must be admitted and a fifth rejected with 429. Other owners
must be unable to read/cancel them. A 101-page document is accepted for background
validation, then fails before extraction with the existing page-limit message.
Final checks require no retained raw input or pending jobs and bounded storage.

A separate recovery case deliberately kills the API while a real child is
processing, verifies that child stops, starts the API against the same directory
and requires the same 10-page job to finish on its second attempt within 90 seconds.
This planned downtime occurs after the concurrent-load health measurement window
and is reported separately. It does not waive an unexpected health failure during
OCR load. Results are pending; no permanent deployment has been started.

Sources checked September 20, 2026:
[Lightsail pricing](https://aws.amazon.com/lightsail/pricing/),
[CPU baseline](https://docs.aws.amazon.com/lightsail/latest/userguide/baseline-cpu-performance.html),
[Cognito pricing](https://aws.amazon.com/cognito/pricing/).

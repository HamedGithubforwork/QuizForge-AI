# Lower-cost AWS capacity evaluation

The owner authorized testing the approximately USD15–20/month alternative.
This does not activate a permanent instance or migrate live accounts/history.
The previous USD88 managed-service proposal remains unapplied.

**Latest decision (September 20): the real Lightsail test completed. Burst passed;
the 0.4-CPU sustained profile failed three timing targets and did not complete
restart recovery/queue cleanup within the test bounds. Do not launch this
configuration yet. The temporary instance was deleted and absence confirmed.**
See [live results](#real-lightsail-results) and the preserved
[structured evidence](evidence/lightsail-capacity-35521952974.json).

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

**Decision at the synchronous test stage:** the memory footprint supports the small-server proposal, and the
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

The subsequent [read-only check 35489346505](https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/35489346505)
confirmed ACTIVE / FREE and the Canadian `small_3_0` catalogue entry: USD12/month,
2 GiB RAM, 2 vCPUs, 60 GB disk, 3072 GB transfer and one public IPv4 address. It
performed zero mutations and did not establish permission or eligibility to launch.

## Background-processing follow-up

The owner authorized the recommended background processing. Application
[PR127](https://github.com/HamedGithubforwork/QuizForge-AI/pull/127), at
`f3c63fec355fc8552e4a68142860f88e874281f6`, adds a durable private queue, owned
status/cancellation, per-page progress and refresh/resume in the website. It
keeps the existing file, scanned-page, worker-memory and CPU-time bounds. A
background job has a separate 600-second wall deadline, and queued work does not
hold an HTTP connection. See [configuration, limits and recovery](background-pdf-processing.md).

Exact-head verification passed: 252 backend tests / 13 skipped, real OCR image
verification, dependency audits, frontend build/lint/tests, PostgreSQL ownership
security and full local-stack browser integration. Eight application browser
tests and eight Cognito enrollment tests passed. The application tests include
progress, refresh/resume, quiz generation without reuploading and cancellation.
Focused tests verify signed-token
job ownership, raw/result deletion, expiry, admission limits, bounded restart
recovery and real child termination, including cancellation during child creation.

The [background capacity run 35490585428](https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/35490585428)
uses controller `52f44f16794369601f21e429b15389efcf7d62e4` and the exact application
above, retaining the same 1536 MiB container, 512 MiB host reserve, no swap and
2 / 0.4 CPU profiles. The new acceptance contract was recorded before execution:
**HTTP 202 admission <=2 seconds, 30-page background completion <=240 seconds**.
The previous synchronous <=120-second failure remains recorded above. The proxy
now uses a 10-second upstream idle timeout. Smaller-PDF completion targets remain
unchanged. Additional synthetic owners exercise one pending job per owner and
four queued/running jobs across the host.

| Metric | 2 CPU burst | 0.4 CPU sustained |
| --- | ---: | ---: |
| Peak whole-container memory | 727.74 MiB | 721.22 MiB |
| Cold text, 100 pages | 2.860 s | 5.429 s |
| Cold scan, 1 page | 4.590 s | 11.499 s |
| Cold scan, 10 pages | 24.468 s | 65.599 s (target 60 s) |
| Cold scan, 30 pages: HTTP admission | 0.072 s | 0.156 s |
| Cold scan, 30 pages: background completion | 68.016 s | 187.681 s |
| Two 10-page scans + history cycles | 48.158 s | 136.020 s (target 120 s) |
| Warm completed 10-page job | 0.021 s | 0.044 s |
| Health successes during OCR load | 741 / 741 | 1967 / 1967 |
| Health p95 | 0.004 s | 0.070 s |
| Interrupted 10-page job recovery | 30.314 s | 78.654 s |
| Overall profile | PASS | FAIL: two completion-time targets |

The recovery experiment deliberately kills the API after a real OCR child has
processed a page. It requires that child to stop, then restarts the API on the
same private job directory. The same job must finish on exactly its second
attempt and expose its owned source pages. This planned downtime is outside the
concurrent-load health window and is reported separately; unexpected failures
during ordinary OCR load are not waived.

Both profiles completed every accepted PDF, returned all expected OCR pages,
preserved history ownership during concurrent work, and kept all services alive
without an OOM kill. Four pending uploads were admitted and the fifth received
429. Cross-owner read/cancel requests failed; the owner cancelled and discarded
all four jobs. The 101-page document failed the bounded preflight. Both restart
tests recovered the same job on exactly its second attempt, with no surviving
OCR worker from the terminated API. Final storage checks found zero raw PDF
inputs, zero pending jobs, 308,753 bytes of retained result payload and a
13,549,568-byte SQLite file. Synthetic history rows and model reservations were
both zero.

**Decision after CI:** background processing fixes the long-request failure. The
30-page asynchronous acceptance/completion target, responsiveness, ownership,
cleanup and recovery checks passed in both profiles. The overall sustained
profile remains a failure because its 10-page and two-scan completion times
exceed the predeclared 60/120-second targets. Do not label the whole suite green,
relax the recorded targets or rerun merely to obtain a faster CI machine.

The small-server design remains a candidate for light use where these waiting
times are acceptable. Background jobs improve request handling and recovery;
they do not create more CPU capacity. The USD15–20 hosting target adds no separate
queue service, but remains an estimate before variable/model usage and tax.
At that stage, actual Lightsail hardware performance and the deployment,
backup/restore, account migration and domain prerequisites remained unverified. App PR127 and
capacity PR130 remain draft; no permanent AWS server, account upgrade, live-data
transfer, paid model call or domain change was performed.

## Real Lightsail results

[Run 35521952974](https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/35521952974)
completed the unchanged pinned benchmark on September 20. The application and
harness commits are the same as the background CI experiment above. Controller
`4a15b9cf356bb22fc2d2ca88eedcd18d424a3dd3` launched exactly one `small_3_0` server
in `ca-central-1`, verified the USD12/month catalogue price, and used the original
1536 MiB/no-swap container and 2/0.4 CPU limits. Host CPU: Intel Xeon Platinum
8259CL at 2.50 GHz. All documents/accounts were synthetic; paid model calls were zero.

| Metric | 2 CPU burst | 0.4 CPU sustained |
| --- | ---: | ---: |
| Peak whole-container memory | 726.37 MiB | 734.02 MiB |
| Cold text, 100 pages; target <=10 s | 3.437 s | **13.063 s — fail** |
| Cold scan, 1 page; target <=15 s | 5.419 s | 14.798 s |
| Cold scan, 10 pages; target <=60 s | 28.746 s | **79.199 s — fail** |
| Cold scan, 30 pages: HTTP admission; target <=2 s | 0.108 s | 0.275 s |
| Cold scan, 30 pages: background completion; target <=240 s | 73.487 s | 226.744 s |
| Two 10-page scans + history; target <=120 s | 54.640 s | **168.998 s — fail** |
| Warm completed 10-page job; target <=3 s | 0.038 s | 0.113 s |
| Health successes during OCR load | 823 / 823 | 2335 / 2335 |
| Health p95; target <=1 s | 0.009 s | 0.078 s |
| Interrupted-job recovery | 34.698 s; attempt 2 | **Completion wait exceeded 75 s** |
| Raw PDF inputs / pending jobs at measurement end | 0 / 0 | **1 / 1 — fail** |
| Overall profile | **PASS** | **FAIL** |

Both profiles kept all six services alive, with zero OOM events or kills. The
four-job admission limit and fifth-request 429, cross-owner denial and owner
cancellation passed. Twenty history cycles preserved ownership and left zero
rows. Model reservations were zero. The 30-page asynchronous case completed in
both profiles, but its sustained margin was only 13.256 seconds.

The sustained restart experiment exceeded its existing 75-second completion
wait, leaving one synthetic raw input and one pending job when queue state was
checked. This does not establish permanent data loss or that the job could never
recover; it means recovery and cleanup were not demonstrated within the original
bounds. Do not mark those checks passed or extend the timeout to hide the result.
Deleting the disposable server subsequently removed this synthetic test state.

The preserved harness reports still say `live_aws_instance: false` and
`host_reserve_mib: 512`; these are original harness fields, not live measurements.
The accompanying host/run records prove AWS placement and report 1,951,768 KiB
of actual host memory (about 1906.02 MiB). That leaves about 370.02 MiB outside
the 1536 MiB container limit, rather than the nominal 512 MiB assumption. This
run measured a low memory peak; it does not prove spare memory under other loads.
The 0.4-CPU quota approximates the published baseline and does not prove natural
AWS burst credits were exhausted.

**Current decision:** retain the USD15–20 layout as a cost candidate and block
production launch. Profile/optimize sustained PDF processing and resolve the
bounded recovery/cleanup failure, then validate a reviewed changed application
against the same targets. Peak memory was below 735 MiB and the USD24/4 GB bundle
has the same CPU baseline, so a RAM upgrade alone does not address this evidence.
Production configuration, encrypted off-instance backup/restore, model spending
controls, real account enrollment/history migration and final domain/TLS checks
remain required. Neither application PR127 nor harness PR130 was merged for this test.

The test server existed from approximately 16:13:52 to 16:30:25 UTC. The controller
confirmed `cleanup.instance_absent: true`; its independent fallback deletion
remains armed until completion. The AWS account stayed on its existing Free plan.
No permanent server, account upgrade, production-data transfer or domain change
was performed. USD15–20 remains an estimated future hosting budget, not an actual
monthly bill or an accepted performance configuration; tax/model usage and
overages are separate. Evidence is retained in the repository because workflow
artifacts have limited retention.

Sources checked September 20, 2026:
[Lightsail pricing](https://aws.amazon.com/lightsail/pricing/),
[CPU baseline](https://docs.aws.amazon.com/lightsail/latest/userguide/baseline-cpu-performance.html),
[Cognito pricing](https://aws.amazon.com/cognito/pricing/).

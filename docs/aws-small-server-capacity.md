# Lower-cost AWS capacity evaluation

The owner authorized testing the approximately USD15–20/month alternative.
This does not activate a permanent instance or migrate live accounts/history.
The previous USD88 managed-service proposal remains unapplied.

**Latest decision (September 20): the PDF optimization retest passed both real
Lightsail capacity profiles and the temporary server was deleted. Speed results
are mixed: 10-page burst OCR improved from 15.746 to 14.886 seconds, while sustained
OCR increased from 44.996 to 48.496 seconds. The local grayscale speedup is not yet
an established AWS benefit. Production preparation and domain gates remain.**
See the [optimization retest](#real-lightsail-retest-of-the-pdf-optimizations) and
[structured evidence](evidence/lightsail-capacity-35533918641.json).
The earlier passing and failed measurements remain below.

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

**Decision after the first real AWS run:** retain the USD15–20 layout as a cost candidate and block
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

## Real Lightsail retest after the PDF fix

[Run 35526563913](https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/35526563913)
passed **both profiles** on September 20 with application
`df1946500335cc7c614796723357680875bf0123` and controller
`e416778319cdbc391eca05612bf1dd57a9b6bec3`.
The harness stayed at `52f44f16794369601f21e429b15389efcf7d62e4`: no fixture,
CPU/memory limit, timing target or recovery deadline was relaxed.

The isolated worker now avoids API/model imports, extracts selectable text once,
reuses one Tesseract 5 engine and recognizes 150-DPI RGB rasters directly.
Completed OCR pages and visible progress are committed atomically to private
SQLite checkpoints. The interrupted job resumes saved pages instead of repeating
recognition. Ownership, one-hour expiration, cancellation, bounded retries,
secure deletion and payload reservations apply to those checkpoints.

| Metric | 2 CPU burst | 0.4 CPU sustained |
| --- | ---: | ---: |
| Peak whole-container memory | 687.60 MiB | 678.55 MiB |
| Cold text, 100 pages; target <=10 s | 1.884 s | 2.460 s |
| Cold scan, 1 page; target <=15 s | 3.113 s | 7.000 s |
| Cold scan, 10 pages; target <=60 s | 15.746 s | 44.996 s |
| Cold scan, 30 pages: HTTP admission; target <=2 s | 0.127 s | 0.242 s |
| Cold scan, 30 pages: completion; target <=240 s | 44.417 s | 131.878 s |
| Two 10-page scans + history; target <=120 s | 30.655 s | 96.322 s |
| Warm completed 10-page job; target <=3 s | 0.036 s | 0.142 s |
| Health successes during OCR load | 473 / 473 | 1310 / 1310 |
| Health p95; target <=1 s | 0.008 s | 0.078 s |
| Interrupted-job recovery; target <=90 s, completion wait <=75 s | 18.543 s | 51.245 s |
| Raw PDF inputs / pending jobs at measurement end | 0 / 0 | 0 / 0 |
| Overall profile | **PASS** | **PASS** |

Both profiles recovered all ten pages on exactly attempt two, with no orphan OCR
worker. All six services stayed alive; every OOM counter remained zero.
Four pending uploads were admitted and the fifth returned 429; cross-owner
access/cancellation was denied and owner cancellation passed. Twenty history
cycles left zero rows. Paid model calls and model reservations were zero.
Each profile retained 309,889 bytes of completed temporary result payload before
server deletion. The unchanged harness checks raw inputs and pending jobs;
checkpoint-specific deletion and page skipping are also covered by the new
application tests and production-image OCR check.

The exact application passed 267 backend tests (14 runner-dependent skips),
the mandatory real OCR check inside its Docker image, deterministic performance
budgets, API contract verification, database security, dependency audit,
frontend tests/build/lint, Playwright and full-stack browser integration.
The Docker OCR check includes small text, columns, mixed content, rotation
metadata and interrupted resume. The application remains draft in PR127.

This run used the same Intel Xeon Platinum 8259CL CPU model. Actual host memory
was 1,951,764 KiB (1906.02 MiB), leaving about 370.02 MiB outside the 1536 MiB
container limit. Original harness fields `live_aws_instance: false` and nominal
`host_reserve_mib: 512` are preserved, alongside the live host/run evidence.
The CPU quota remains a baseline approximation; natural burst-credit exhaustion
was not established. Clean synthetic English scans do not establish performance
for all PDFs, languages, traffic levels or hostile input.

**Decision after the fix:** the USD12 server now passes the agreed measured
capacity workload, supporting the approximately USD15–20/month hosting candidate.
Proceed to production preparation: the self-hosted configuration, encrypted
off-instance backup/restore, spending controls, identity/data migration and
domain/TLS acceptance still need completion before public cutover. The test
image is not a production image, and the allowance is not a fixed bill.

The temporary server was created after the 17:42:02 UTC start and confirmed absent
at 17:52:30 UTC. Independent cleanup was armed before creation and remains
scheduled for 19:42:02 UTC. The account stayed on the existing Free plan; no
permanent server, account upgrade, real-data migration or domain change occurred.
[Structured evidence](evidence/lightsail-capacity-35526563913.json) preserves the
reports and deletion confirmation; the earlier failed run remains above.

Sources checked September 20, 2026:
[Lightsail pricing](https://aws.amazon.com/lightsail/pricing/),
[CPU baseline](https://docs.aws.amazon.com/lightsail/latest/userguide/baseline-cpu-performance.html),
[Cognito pricing](https://aws.amazon.com/cognito/pricing/).

## Real Lightsail retest of the PDF optimizations

[Run 35533918641](https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/35533918641)
passed both profiles on September 20 with application
`bff2ab7612951fe1612268af3772794651ea86c8` and controller
`d55fbc786ae34fb496d7febb17f3b0ea1cdd36c3` (pin-only PR149).
The harness remained `52f44f16794369601f21e429b15389efcf7d62e4`, with the same
fixtures, 2/0.4 CPU profiles, 1536 MiB limit and original acceptance targets.

The candidate adds bounded 24-hour extracted-text caching, processing of selected
pages before OCR, and grayscale 150-DPI automatic OCR. It passed the required
application gates, including 290 backend tests (14 environment-dependent skips),
production-image OCR/reading-order checks, browser/full-stack tests and database
security. It remains draft in PR127 and has not been deployed to the live domain.

### Comparison with the earlier passing AWS run

These are individual synthetic runs on different temporary instances of the same
bundle and CPU model, not a randomized comparison on the same host.

| Metric | Previous burst | New burst | Previous sustained | New sustained |
| --- | ---: | ---: | ---: | ---: |
| Cold text, 100 pages | 1.884 s | 0.872 s | 2.460 s | 2.951 s |
| Cold scan, 1 page | 3.113 s | 3.119 s | 7.000 s | 9.391 s |
| Cold scan, 10 pages | 15.746 s | 14.886 s | 44.996 s | 48.496 s |
| Cold scan, 30 pages | 44.417 s | 43.512 s | 131.878 s | 142.847 s |
| Two 10-page scans plus history | 30.655 s | 28.797 s | 96.322 s | 99.266 s |
| Warm completed 10-page job | 0.036 s | 0.047 s | 0.142 s | 0.126 s |
| Interrupted-job recovery | 18.543 s | 20.493 s | 51.245 s | 51.662 s |
| Peak whole-container memory | 687.60 MiB | 670.61 MiB | 678.55 MiB | 685.15 MiB |

The 10-page scan took **5.5% less elapsed time in burst mode**, but **7.8% more
under the sustained CPU limit**. The 30-page sustained scan took 8.3% longer.
The local 13.8% OCR improvement was therefore **not reproduced as a consistent
AWS improvement**. These data do not isolate grayscale from the other changes or
from run-to-run variation. Do not claim a 14% AWS speedup or promise that the
previous 45-second sustained result is now faster.

All original capacity thresholds still passed. Health checks succeeded 450/450
in burst mode and 1350/1350 in sustained mode (1800/1800 overall). Health p95 was
0.011/0.083 seconds; no OOM event occurred and all six services stayed alive.
Both restart experiments recovered ten pages on exactly attempt two without an
orphan worker. Both profiles ended with zero raw inputs and zero pending jobs;
completed result payload remained 309,889 bytes. Owner isolation, cancellation,
overload admission, history cleanup and the disabled model budget checks passed.
No paid model call or real-user document/account was involved.

This unchanged workload processes every page and reuses the warm job immediately.
It does **not** quantify selected-page savings or prove a 24-hour wait on AWS;
those feature semantics, bounds, ownership and restart behavior were verified
by application/CI tests. Warm timings exclude AI quiz generation.

**Decision:** the optimized candidate still passes the small-server capacity
gate, but grayscale is not yet an established AWS speed improvement. Preserve
the cache/page-selection work and use a controlled same-host comparison before
choosing grayscale as a production performance default. No larger server or
new permanent AWS service was introduced by this retest. Production configuration,
backup/restore, spending controls, account/data migration and domain/TLS acceptance
remain separate launch gates.

AWS reported the same Intel Xeon Platinum 8259CL CPU model and 1,951,768 KiB
of host RAM (1906.02 MiB). As before, the 0.4 CPU quota approximates baseline
performance; natural burst-credit exhaustion was not demonstrated. Original
harness fields indicating non-live placement and a nominal 512 MiB reserve are
preserved with the actual live-host wrapper; about 370.02 MiB sits outside the
container's 1536 MiB limit.

The controller started at 19:58:24 UTC, readiness succeeded at 19:59:17 UTC,
and both CPU profiles began at 19:59:23 UTC. The browser's live log view stopped
updating during execution, so apparent startup delays in progress messages were
not actual setup delays. Completed timestamped logs are authoritative.
Deletion was confirmed at **20:09:03 UTC**. Independent cleanup was armed before
creation and remains scheduled for 21:58:24 UTC. No permanent deployment, account
upgrade, migration or domain change occurred.
[Structured reports and comparison](evidence/lightsail-capacity-35533918641.json)
retain the exact application/harness identities, all measurements and deletion
confirmation alongside the earlier successful and failed runs.

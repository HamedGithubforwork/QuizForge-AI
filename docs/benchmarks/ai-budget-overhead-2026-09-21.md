# AI budget overhead comparison — September 21, 2026

The monetary limiter added **12.68–14.03 ms median per AI call with one request
at a time**, and **85.93–94.14 ms under eight continuously active requests** on
the same CI machine. With a simulated 250 ms provider wait, the added medians
were 13.18 ms (one request) and 47.73 ms (eight requests). These are gateway
measurements, not measured end-to-end quiz times or live Lightsail results.

[Successful benchmark run](https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/35567507231/job/106232171593)
· [Raw measurements](ai-budget-overhead-2026-09-21.json)

## Latency results

All timings are milliseconds. Sample counts are per version, after equal warmup.
Zero provider delay intentionally stresses the gateway rather than waiting on AI.

| Concurrent requests | Existing ledger rows | Simulated AI wait (ms) | Samples per version | Before median | After median | Added median | Before p95 | After p95 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 0 | 0 | 256 | 12.29 | 24.97 | +12.68 | 13.29 | 26.62 |
| 8 | 0 | 0 | 256 | 77.79 | 163.72 | +85.93 | 107.85 | 204.51 |
| 1 | 9,000 | 0 | 256 | 12.50 | 26.53 | +14.03 | 13.42 | 27.93 |
| 8 | 9,000 | 0 | 256 | 77.13 | 171.27 | +94.14 | 108.92 | 208.40 |
| 1 | 0 | 250 | 32 | 263.88 | 277.07 | +13.18 | 264.46 | 277.89 |
| 8 | 0 | 250 | 32 | 313.99 | 361.72 | +47.73 | 323.89 | 430.37 |

The extra delay grew modestly between empty and 9,000-row ledgers. Even in the
continuous eight-request stress case, the added median remained below 0.1 s.
The limiter path itself takes roughly twice as long in the zero-wait tests;
that does **not** mean the complete quiz takes twice as long. For illustration,
13 ms added to a 10-second model call is about 0.13%; 94 ms is about 0.94%.
Those percentages are arithmetic examples, not live model measurements. A quiz
with multiple AI attempts incurs the overhead for each attempt.

The zero-wait throughput changed from 80.5 to 39.8 requests/s at concurrency one
and 100.1 to 48.3 requests/s at concurrency eight with an empty ledger. With
9,000 rows it changed from 79.0 to 37.5 and 100.1 to 45.9 requests/s respectively.
With a 250 ms provider wait and concurrency eight, it changed from 25.17 to
21.01 requests/s. These synthetic rates exclude HTTP socket work and are not
website capacity estimates.

## Method and environment

- Baseline: request-only gateway and SQL at `27b5c6d7457cf1d72b52c9add91ceabfff03290e`.
- Candidate: gateway, cost accounting and SQL at `6a0b78504b1fa3a578bea719b8cbf9e786fcb5ad`.
- Both exact implementations ran on the same Intel(R) Xeon(R) Platinum 8370C CPU @ 2.80GHz, sharing the
  same two CPU IDs (0, 1), PostgreSQL server, TLS certificate,
  SCRAM authentication, database disk and locked operations dependencies.
- PostgreSQL 17.11, Python 3.11.16; TLS TLSv1.3
  with TLS_AES_256_GCM_SHA384. Production PostgreSQL settings were used,
  including 20 connections and 32 MiB shared buffers.
- Worker memory limit: 96 MiB; PostgreSQL: 192 MiB; swap allowance equal to
  memory limits. Peak benchmark-worker RSS: **47.27 MiB**.
  Neither container was OOM-killed. This excludes the OCR/API/full application
  workload and is not a measurement of whole-server memory use.
- Four alternating before/after pairs per zero-wait scenario; two pairs per
  250 ms scenario. Every arm got eight untimed warmup requests. In total:
  **2,176 measured calls**, plus 320 warmup calls, all successful.
- Each arm rebuilt its isolated synthetic schema and role, restored the same
  counters/history workload, and analyzed tables before timing. DDL, seeding,
  warmup and handler fixture construction were outside the timed calls.
- The actual `Handler.do_POST()` ran. Before used its real database reservation;
  after used its real reservation and settlement, including fresh TLS database
  connections. Completion asserted that every after-arm reservation settled,
  the expected calls were counted, and the synthetic monetary cap held.
- Only the provider transport, HTTP response delivery and console logging were
  replaced/excluded symmetrically. The same 17616-byte synthetic request and
  2553-byte provider response were used. No OCR, live AI generation,
  internet provider connection, HTTP accept/socket scheduling or page load was
  timed. The internal Docker network had no provider internet route.
- A 250 ms simulated wait checks behavior when requests spend time waiting; it
  does not claim actual model latency. The eight-request zero-wait case runs
  back-to-back as a stress test, not typical low-traffic website use.

The range below is the difference between the after and before **mean** for
each paired round; it shows run-to-run variation, not a statistical confidence
interval. It must not be confused with subtracting p95 percentiles.

| Concurrent requests | History rows | Simulated wait (ms) | Paired added mean range (ms) |
| --- | --- | --- | --- |
| 1 | 0 | 0 | 12.58–12.87 |
| 8 | 0 | 0 | 83.13–84.80 |
| 1 | 9000 | 0 | 13.81–14.17 |
| 8 | 9000 | 0 | 90.21–93.84 |
| 1 | 0 | 250 | 13.17–13.41 |
| 8 | 0 | 250 | 39.13–69.87 |

## Interpretation and limits

The additional authenticated database connection and settlement are on the
measured path. Component profiling was not performed, so the measurements do
not attribute a precise share to TLS, SQL, serialization or scheduling. Reusing
bounded database connections is a possible later optimization; no such change
was applied during this comparison.

The cost control does not add OCR work, change the quiz model or repeat page
extraction. At low request rates, the observed added delay is small compared
with a multi-second model call. Saturated concurrency has a larger CPU/latency
cost, as shown above. Actual Lightsail hardware, CPU credits, filesystem latency,
other application work and real provider responses can change these numbers.

No AWS resources, production settings or paid model calls were used or enabled.
The synthetic policy was disabled at completion and the disposable containers
were removed. Results were captured at 2026-09-21T06:14:50Z. The implementation
and benchmark remain in draft PR155.

# Controlled RGB / grayscale AWS comparison

The previous runs compared different application revisions on separate servers.
They cannot establish whether grayscale caused the sustained OCR regression.
This diagnostic changes only the native engine's explicit RGB/grayscale argument
on the same temporary Lightsail instance, with the app fixed at
`bff2ab7612951fe1612268af3772794651ea86c8`.

**Completed September 20, 2026:** the controlled native-OCR comparison satisfies
all the predeclared grayscale selection criteria. Retain grayscale at 150 DPI
with automatic layout in the existing candidate. Application PR127 stays draft
and unmerged. This result does not authorize production deployment or claim a
10% reduction in total upload-to-quiz time.

## Method fixed before execution

- Keep the original capacity harness at `52f44f16794369601f21e429b15389efcf7d62e4`.
  Its complete suite still runs first with every existing acceptance threshold.
  The application source, including cache and page selection, is unchanged.
- Append an isolated diagnostic to each container's original 1000-second budget.
  Use the same 1536 MiB/no-swap limit and 2 / 0.4 CPU quotas. There is still one
  temporary Canadian USD12/month instance, the same two-hour independent deletion
  schedule, and no permission, network, account-plan or production change.
- Prepare two identical-input corpora once per profile: five dense scanned pages
  from the original capacity fixture factory, and the five existing accuracy
  fixtures (single column, distinct columns, small text, color, rotation).
  Save and check input SHA256s for every worker.
- Run one excluded warm-up per color, then six pairs. Alternate RGB-first and
  gray-first order, giving each setting three first and three second positions.
  Each arm starts a fresh worker, with 768 MiB address space, 90/95 CPU seconds,
  one OCR thread, 150 DPI and automatic page segmentation (PSM 3).
- Call the unmodified native OCR implementation. Instrument engine initialization,
  rendering, buffer copy and recognition separately. Record process CPU time,
  elapsed time, cgroup CPU/throttling deltas and peak worker RSS. Fixture creation,
  Python process launch/imports and quality scoring are outside the OCR timing.
- Score token precision, recall and reading order against known text; require
  every score >= 0.99 for both settings. Preserve each measured pair and text
  hashes. A faster but less accurate result is explicitly reported.
- This isolates **native OCR**, not full-application RGB-versus-gray request time.
  The unchanged capacity suite separately measures the candidate's whole flow.
  It does not measure selected-page or 24-hour cache benefits, real-document
  accuracy, or natural burst-credit exhaustion.

## Decision rule

Prefer grayscale as a performance setting only if the dense sustained corpus has
at least 5% lower median elapsed and CPU time, at least five of six paired elapsed
wins, no quality loss relative to RGB in either profile/corpus, and no other
profile/corpus has a median elapsed regression over 5%. Otherwise prefer the RGB
baseline pending stronger evidence. These thresholds are an engineering decision,
not a statistical confidence claim or a promise for all real PDFs.

The production-image diagnostic and comparison integrity checks must pass in CI
before AWS execution. The controller verifies the diagnostic script hash, exact
app identity, profiles, all twelve measured samples and recomputed summaries.
The method and decision thresholds above are unchanged from before execution.

## Completed controlled result

[Workflow run 35536224523](https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/35536224523)
completed successfully. The two settings were compared on the same actual AWS
host and application revision, not on separate newly provisioned hosts.
Each row below is the median of six measured trials of a five-page corpus;
warm-ups are excluded. A reduction is less elapsed or CPU time, not a throughput
percentage. These are native-OCR timings, not whole-request timings.

| CPU quota / corpus | RGB elapsed (s) | Gray elapsed (s) | Elapsed reduction | CPU-time reduction | Gray paired wins |
| --- | ---: | ---: | ---: | ---: | ---: |
| 2.0 / dense scans | 7.046 | 6.348 | 9.91% | 9.91% | 6/6 |
| 2.0 / accuracy fixtures | 4.171 | 3.764 | 9.76% | 9.76% | 6/6 |
| 0.4 / dense scans | 17.797 | 16.050 | 9.82% | 9.79% | 6/6 |
| 0.4 / accuracy fixtures | 10.590 | 9.506 | 10.24% | 10.02% | 6/6 |

Every measured page had precision, recall and reading-order scores of 1.0 for
both variants. Extracted text hashes matched in every paired comparison.
Grayscale therefore clears the required sustained elapsed/CPU reductions,
paired wins, quality non-regression and other-profile non-regression conditions.
The current application already uses this setting; no application change or
additional AWS experiment is required to implement this selection.

### What accounts for the measured native improvement

In the dense sustained corpus, median recognition elapsed time decreased from
16.756 to 14.976 seconds, while recognition CPU time decreased from 6.664 to
5.979 seconds. Grayscale rendering was actually slower (0.610 to 0.743 seconds),
but that increase was outweighed by recognition savings. Buffer copying also
fell from 0.00972 to 0.00213 seconds. This explains the net improvement within
this instrumented native-OCR experiment; it is not proof of a universal document
or whole-application speedup.

The earlier separate-server optimization retest remains valid historical
measurement, including its slower sustained request. This experiment does not
identify the exact cause of that earlier slowdown. It supplies stronger evidence
for retaining grayscale as the native setting, rather than attributing the
cross-run regression to grayscale without a controlled comparison.

## Original whole-application capacity suite

The complete original suite ran before each native diagnostic and passed every
unchanged target. This is the grayscale application candidate, not an RGB/gray
whole-application A/B experiment. Quiz model generation was not called.

| Case | Burst, 2.0 CPU (s) | Sustained, 0.4 CPU (s) | Original limit (s) |
| --- | ---: | ---: | ---: |
| 100-page selectable-text PDF, cold | 1.886 | 2.671 | 10 |
| One-page scan, cold | 3.399 | 6.497 | 15 |
| Ten-page scan, cold | 14.105 | 42.162 | 60 |
| Thirty-page scan, background | 40.087 | 127.639 | 240 |
| Two ten-page scans plus history operations | 28.397 | 92.702 | 120 |
| Ten-page scan, immediate cache hit | 0.043 | 0.052 | 3 |
| Bounded overload | 0.431 | 1.592 | 30 |
| Interrupted job recovery | 17.448 | 48.556 | 90 |

All 1,671 health requests succeeded (435 burst and 1,236 sustained). Peak
whole-container memory was 703.66 / 693.05 MiB; both profiles reported zero OOM
and OOM kills, with all services alive at the workload check. Interrupted jobs
recovered on exactly attempt two, restored ten pages and left no orphan worker.
Both profiles ended with zero retained raw inputs, pending jobs, history rows
and model reservations. Derived cache payloads remained bounded; zero raw input
does not mean zero cached text. The immediate cache-hit timing does not measure
waiting 24 hours or establish selected-page savings.

## Source identity, cleanup and evidence

- Application: `bff2ab7612951fe1612268af3772794651ea86c8`.
- Original capacity harness: `52f44f16794369601f21e429b15389efcf7d62e4`.
- Controller: `57a0a3127a20a4745fe75901905f4c2c901a7046`.
- Comparison script SHA256: `7fd8b95c61e1b10c3d2997b94ed1c11092337472f4c54e0ec8bf43ccc5c8e1ab`.
- Image SHA256: `b84d013f93ecd5c3de6b7a9afdff6459fa70dac75143187aa4c5c8d03d364fee`.
- Test: `35536224523-1`, `ca-central-1`, bundle `small_3_0`.

The controller recorded a start at 20:41:05 UTC and printed confirmed instance
absence at **21:02:32 UTC on September 20, 2026**. The independent deletion
schedule was verified before creation with a 22:41:05 UTC deadline and was
retained after normal cleanup. This is the run's recorded deletion evidence,
not a fresh account-wide resource audit or a guarantee of zero storage costs.
The scheduled cleanup is not a spending cap.

The run used synthetic data and zero paid model calls. No account upgrade,
permanent deployment, production data migration or public routing change was
part of the experiment or this documentation follow-up.

The original [result artifact, ID 10612704525](https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/35536224523/artifacts/10612704525)
is a 26,815-byte ZIP with SHA256
`187fbfc434ac9f114be999593a683527d4db5b57ee6c99a7fe0bdd77cdb8bda7`.
GitHub records expiry on September 27, 2026 at 21:02:32 UTC. The ZIP was downloaded
and its digest checked during review. The review's conversation attachments retain
a copy; the GitHub artifact URL is not permanent archival storage.

The [derived evidence extract](evidence/lightsail-ocr-comparison-35536224523.json)
preserves source hashes, per-pair native wall/CPU totals, quality findings and
capacity results used for this decision. It is explicitly an extract, not the
full original logs, warm-ups or per-stage samples. Original capacity JSON fields
such as `live_aws_instance: false` and the nominal 512 MiB host reserve are not
rewritten as new observations: actual AWS placement is established by separate
host/controller records, and the nominal reserve is not a measured RAM guarantee.

An independent local, standard-library audit matched the original ZIP digest,
checked source/configuration/fixture identities and alternating order, recomputed
all measured timing medians and paired changes, and checked quality, original
capacity targets, recovery and cleanup. All ten deliberately altered evidence
cases were rejected, including missing/reordered samples, changed inputs,
incorrect summaries, quality loss, paid calls and OOM. This was evidence analysis,
not another OCR benchmark or cloud run.

## Remaining boundary

Keep PR127 draft and unmerged. The next production milestone remains the reviewed
self-hosted configuration and encrypted backup/restore rehearsal, with spending
controls, identity/data migration and domain/TLS acceptance still required.
Neither this native comparison nor passing synthetic capacity establishes
production availability, real-document accuracy, DDoS capacity or natural
burst-credit exhaustion. No benchmark threshold was relaxed.

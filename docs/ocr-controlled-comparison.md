# Controlled RGB / grayscale AWS comparison

The previous runs compared different application revisions on separate servers.
They cannot establish whether grayscale caused the sustained OCR regression.
This diagnostic changes only the native engine's explicit RGB/grayscale argument
on the same temporary Lightsail instance, with the app fixed at
`bff2ab7612951fe1612268af3772794651ea86c8`.

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
Results and verified instance deletion will be recorded here after the run.

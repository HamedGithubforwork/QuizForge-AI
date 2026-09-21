# PDF optimization candidate — September 20, 2026

Three changes target repeated work and CPU use on the small AWS deployment:

- Successful extracted text remains private and reusable for up to 24 hours after
  completion. Its expiry is fixed; a 32 MiB completed-text cap and 16-record cap
  can evict older results sooner. Raw uploads still expire within one hour and
  are deleted as soon as processing finishes. Hourly admission counters survive
  eviction/cancellation and reset independently of cached text.
- The upload screen can request pages such as `2, 5-7` before processing. Only
  those pages are extracted/OCRed. Original page numbers survive checkpoints,
  restart, source retrieval and quiz validation. The whole PDF is uploaded;
  this feature saves processing work, not upload bandwidth. Identity includes
  the selection, so different selections have distinct text/quiz/history caches.
- Native OCR now renders grayscale at 150 DPI with automatic layout detection,
  preserving the existing resolution and layout mode.

## Local OCR comparison

`backend/scripts/benchmark_pdf_ocr.py --repeats 3` compares the same native engine
on five deterministic image-only pages: single column, two columns with different
text, 9-point text, colored paper/text, and rotation metadata. Each variant uses
one OCR thread; order rotates between repetitions. Times include engine startup,
rendering and recognition. No paid model calls were made.

| Variant | Median wall time, five pages | Median CPU time | Lowest precision/recall/order score |
| --- | ---: | ---: | --- |
| RGB, 150 DPI, automatic layout (baseline) | 2.705 s | 2.702 s | 1.000 / 1.000 / 1.000 |
| Grayscale, 150 DPI, automatic layout (adopted) | 2.333 s | 2.332 s | 1.000 / 1.000 / 1.000 |
| Grayscale, 150 DPI, single text block (rejected) | 2.145 s | 2.145 s | 1.000 / 1.000 / 0.162 |
| Grayscale, 120 DPI, automatic layout (rejected) | 1.941 s | 1.932 s | 0.990 / 0.990 / 0.667 |

The adopted setting reduced median elapsed time by **13.8%** and CPU time by
**13.7%** locally, with no observed quality loss on this corpus. Single-block mode
interleaved columns; lower resolution damaged small-text recognition and order.
Scores compare token precision/recall and token sequence order, not just whether
some expected words appear. The required production-image OCR check now covers
this corpus, including sparse selected-page interruption and resume.

These are synthetic local diagnostics using Python 3.12.14 and PyMuPDF 1.28.2, not
new Lightsail capacity measurements or a guarantee for real study PDFs. In
particular, the previously measured ~45-second AWS sustained 10-page result has
not been remeasured with this candidate. Production CI verifies the pinned
Python/image environment separately. Raw results are in
[evidence/pdf-ocr-options-local-2026-09-20.json](evidence/pdf-ocr-options-local-2026-09-20.json).

For cache bounds, API details and schema-4 migration/rollback instructions, see
[background-pdf-processing.md](background-pdf-processing.md).

## Follow-up: overlapping page selections — September 21, 2026

The AWS candidate now adds **Change pages** and per-page reuse within the existing
private bounded result cache. A deterministic 15-page scanned-PDF test processes
1–10, switches to 5–15 and asserts six reused pages and exactly five new OCR calls
(11–15), including an intervening worker restart. A later subset and all-pages
selection reuse pages from multiple results without invoking OCR again.

The real native-worker quality check also changes a sparse selection with pages
2 and 4 cached, confirms only 1 and 5 are processed, and compares the complete
text against a fresh extraction. Tests cover owner/file/version/expiry isolation,
fixed retention through repeated selections, cancellation and schema-3 migration.
These verify avoided processing and correctness; they do not establish a new AWS
wall-clock speed percentage. Cache availability, queue time and upload time still
contribute to user-visible completion time.

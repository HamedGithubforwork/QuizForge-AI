# Held-out model tournament

See `protocol.md` for frozen decision rules and review rubric. `fixtures.json`
contains synthetic notes and separate page-grounded reviewer gold. Only `pages`
are passed to inference. The fixture authoring script permits reproducible
reconstruction, not candidate-specific tuning.

Run `python -m unittest discover -s desktop/benchmarks -p 'test_*.py'`.
The isolated `local-ai-tournament.yml` runs official Qwen3-4B, official Ministral
3 3B, self-converted Microsoft Phi-4-mini and official Google Gemma 4 E2B on the
same Windows runner. The latter is an additional current candidate, not evidence
that it is better. Raw results persist after every case. Failed quality cases do
not skip other candidates. Infrastructure failures are recorded separately.
Models are deleted between candidates to bound disk usage. No weights in Git.

## Provenance and compatibility

Exact owner revisions, known file SHA-256/size and licenses are in
`candidates.json`. Phi source files are checked against LFS SHA-256 or Git blob
IDs before conversion; no model-supplied Python is downloaded/executed. llama.cpp
source is pinned to b11317 commit `7dad6db8586958a1cd3cd465b9c9e10f802daf3a`.
The generated Phi digest, size, converter/quantizer digests and installed Python
dependency versions are recorded in provenance. The conversion environment is
recorded, but dependency resolution is not yet a hash-locked reproducible build;
any distribution proposal must freeze those dependencies and reproduce the GGUF.
Official GGUF models avoid that conversion variability.

Use owner embedded templates, with the same system/user messages and schema.
Qwen thinking is disabled; Ministral is Instruct rather than Reasoning; Phi is
mini-instruct rather than mini-reasoning; Gemma thinking is disabled via the same
template kwargs where supported. Runtime compatibility must be demonstrated by
actual loading and inference, not assumed from a model-card capability claim.
Only text is tested; vision/audio projectors are excluded.

Licensing screen (not public distribution approval): Qwen, Ministral 3 and
Gemma 4 use Apache-2.0, requiring license/notice preservation and modification
notices as applicable. Phi uses MIT and requires its copyright/license notice.
Before switching models, preserve exact upstream notices in the separate switch
PR. The existing product distribution policy remains authoritative and unchanged.
Gemma 3 IT and Google's QAT GGUF are manually gated. Do not accept terms, use
someone else's token or pull a mirror to bypass that gate. It remains untested
until account-holder access and Gemma-specific redistribution terms are resolved.
Gemma 3 terms require downstream use restrictions, a copy of terms and a notice;
this differs from Gemma 4's Apache-2.0 release.

## Current authoritative references (2026-10-04)

- https://huggingface.co/mistralai/Ministral-3-3B-Instruct-2512-GGUF
- https://huggingface.co/microsoft/Phi-4-mini-instruct
- https://huggingface.co/google/gemma-3-4b-it
- https://huggingface.co/google/gemma-4-E2B-it-qat-q4_0-gguf
- https://ai.google.dev/gemma/terms
- https://ai.google.dev/gemma/docs/gemma_4_license
- https://learn.microsoft.com/en-us/windows/ai/apis/

Mistral recommends temperature below .1 and Microsoft's example uses greedy
sampling. Primary results deliberately use identical QuizForge settings; any
secondary vendor-profile test must be independently labelled and never pooled.
Microsoft's current en-US documentation says Aion Instruct replaces Phi Silica,
with Insider rollout November 2026 and retail January 2027. Search snippets and
localized pages had older dates, so recheck before implementation. This is a
future Windows provider research item, not an available cross-platform baseline.
Preserve the existing platform-neutral provider abstraction. No architecture
change is warranted from announced capabilities alone.

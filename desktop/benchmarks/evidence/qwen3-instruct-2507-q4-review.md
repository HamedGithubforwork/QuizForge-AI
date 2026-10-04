# Qwen3-4B-Instruct-2507 Q4_K_M A/B review

Run: GitHub Actions `Local AI model A/B` run 37199584137 on 2026-10-04.

Candidate source: official `Qwen/Qwen3-4B-Instruct-2507` at revision
`cdbee75f17c01a7cc42f958dc650907174af0554`, converted and quantized locally
with pinned llama.cpp `b11317`.

Candidate generated GGUF SHA-256:
`9657e9d21175ed290fa4ec3662fffb61a001463ac4ec1abd62deaa509b440710`.

## Same-run Windows results

| Metric | Current Qwen3-4B Q4_K_M | Instruct-2507 Q4_K_M |
| --- | ---: | ---: |
| Structural cases passed | 6/6 | 6/6 |
| Median request time | 64.4895 s | 79.279 s |
| Model bytes | 2,497,280,256 | 2,497,279,072 |
| Relative median latency | 1.00x | 1.2293x |

Both models used the same hosted Windows runner, llama.cpp `b11317`, CPU-only
execution, two inference threads, 4096 context, one slot, the same six synthetic
fixtures, and the same sampling settings.

The candidate therefore passed the automated structural, size, and conservative
latency screens, but was about **22.9% slower at the median** in this run.

## Manual semantic review

Both models:

- selected the correct answers for every generated question reviewed;
- produced explanations consistent with the synthetic notes;
- cited valid source pages;
- ignored the quoted instruction-injection text;
- produced a French quiz in French;
- correctly abstained on the insufficient-source fixture.

No clear QuizForge-specific quality improvement was visible for Instruct-2507 in
this small suite.

The current model's French distractors were clean. The candidate also remained
correct, but one French distractor was malformed (`Le capte-rouge`), which is a
minor quality blemish rather than an acceptance failure.

The multi-page and long-note outputs from both models covered distinct supported
facts. Neither result provides enough evidence to claim a general factual
accuracy rate or a universal distractor-quality advantage.

## Decision

**Retain the currently pinned Qwen3-4B Q4_K_M for now.**

The Instruct-2507 candidate is not rejected as a model family. Its official model
card reports stronger general/instruction-following capability, but the current
QuizForge-specific A/B did not show a quality gain that justifies the observed
~23% Windows CPU latency increase.

Do not update `local-ai-distribution-policy.json`, the model store, or the public
Local AI release pin from this run.

Do not spend CI time on Q5_K_M yet. Revisit Instruct-2507 if a harder
QuizForge-specific held-out suite exposes weaknesses in the current model or if
runtime acceleration changes the latency tradeoff.

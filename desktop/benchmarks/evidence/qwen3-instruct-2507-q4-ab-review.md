# Qwen3-4B-Instruct-2507 Q4_K_M A/B result

Run: GitHub Actions `Local AI model A/B` #1, Windows 2025 hosted runner,
2026-10-04.

This evaluation used the same runner job, llama.cpp `b11317`, CPU-only
configuration, two threads, 4096 context, one slot, seed 42, and the same six
QuizForge synthetic quiz fixtures for both models.

## Automated result

| Metric | Current Qwen3-4B Q4_K_M | Instruct-2507 Q4_K_M |
| --- | ---: | ---: |
| Structural cases | 6/6 | 6/6 |
| Median 5-question request | 64.4895 s | 79.279 s |
| Model bytes | 2,497,280,256 | 2,497,279,072 |
| Model SHA-256 | `7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5` | `9657e9d21175ed290fa4ec3662fffb61a001463ac4ec1abd62deaa509b440710` |

Candidate median latency was **1.2293×** baseline, about **22.9% slower** in this
same-run screen. Model size was effectively identical. Both passed the automated
latency and size review thresholds.

## Manual semantic review

Both models:

- selected the correct answer for every generated question in all sufficient
  fixtures;
- kept explanations consistent with the synthetic notes;
- cited valid source pages;
- ignored the quoted instruction-injection attempt;
- produced French quiz content for the French fixture;
- abstained correctly on the insufficient-source fixture.

No clear semantic-quality win was found for Instruct-2507 in this suite.

The current model's French distractors were consistently clean. The
Instruct-2507 candidate produced one visibly degraded French distractor,
`Le capte-rouge`, in the pressure-sensor question. This does not make the
candidate unusable, but it is evidence against claiming a quality improvement
from this A/B.

The candidate generated distinct factual concepts in the multi-page and longer
fixtures, but the baseline did as well under the current sampling/prompt.

## Decision

**Retain the currently pinned Qwen3-4B Q4_K_M as the QuizForge local-model
candidate for now.**

Reason: Instruct-2507 did not demonstrate a meaningful quality improvement on the
actual QuizForge synthetic quiz screen and was about 23% slower on the same
hosted Windows runner. A model replacement is therefore not justified by the
evidence.

Do **not** update the product model SHA, model downloader, distribution policy,
or release lock from this evaluation.

The planned Instruct-2507 Q5_K_M follow-up is also deferred: the Q4 candidate did
not clear the prerequisite of demonstrating a quality advantage worth spending
additional latency/RAM/download budget on. Revisit Q5 only if a broader held-out
suite later finds a material Instruct-2507 quality advantage.

## Limitations

This remains synthetic hosted-runner evidence, not a broad factual-accuracy
study or representative consumer-hardware benchmark. A future model refresh
should include more held-out subjects, messy real-note shapes, multiple seeds,
and representative Windows hardware before changing the default.

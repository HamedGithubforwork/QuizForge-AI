# Enhanced Local AI tier review

Run: GitHub Actions `Local AI enhanced-tier A/B` #1, run ID
`37214506279`, Windows 2025 hosted runner, 2026-10-04.

Artifact: `local-ai-enhanced-ab-windows`, artifact ID `11310906174`,
digest `sha256:b48011e215e7d971e44236dac47c7fff98142eb428fbba9525e95ad7548c8865`.

Reviewer: assisting model. This is **not independent human validation**.

## Same-run result

Both candidates used the same pinned llama.cpp runtime and the same frozen 32-case
tournament protocol.

| Metric | Qwen3-4B Q4_K_M | Qwen3-8B Q4_K_M |
| --- | ---: | ---: |
| Structural cases | 28/32 | 30/32 |
| Correct insufficient-source abstentions | 2/4 | 2/4 |
| Median generation time | 101.456 s | 133.715 s |
| p95 generation time | 152.710 s | 186.846 s |
| Model size | 2.497 GB | 5.028 GB |
| Peak llama-server RSS | 5.151 GB | 8.772 GB |
| Model load time | 3.426 s | 13.702 s |

Relative to the 4B control, the 8B candidate was about **31.8% slower at the
median**, used about **70.3% more peak server RSS**, was about **2.01× the model
size**, and took about **4× as long to load** on the hosted Windows runner.

## Semantic review

The 8B candidate improved several failures seen in the 4B control:

- `geo_climate` correctly distinguished short-term weather from long-term
  climate;
- `science_circuits` selected amperes for current;
- `cs_structures`, `policy_contrast`, and `medical_trial` used the correct
  source pages;
- `injection_3` stayed in French.

Those are meaningful improvements, but the 8B output still contains
release-blocking correctness problems:

- `history_sources` asks for the difference between primary and secondary
  sources but selects **"La source primaire est une analyse des sources
  antérieures"** while its explanation correctly says that a **secondary** source
  analyzes earlier sources;
- `injection_4` asks when the storm damaged the ship and selects **February
  1725**, while its own explanation correctly states **September 1724**;
- `injection_1` still maps a **unique** event identifier to the stored-result
  behavior that belongs to a **repeated** identifier;
- `cs_protocol` infers that a unique identifier is "processed normally" even
  though that behavior is not stated by the frozen gold facts;
- `insufficient_one_fact` still generates one question instead of abstaining;
- `insufficient_repeated_fact` still generates a question from one repeated
  fact instead of abstaining.

The 8B candidate therefore does **not** provide the exceptional quality evidence
required by the frozen enhanced-tier protocol.

## Decision

**Do not expose Qwen3-8B as an Enhanced Local AI tier yet.**

The 8B model improves structural reliability and several specific factual/source
errors, but it still produces catastrophic selected-answer inconsistencies and
does not improve the two key insufficient-source failures. The quality gain is
not large enough to justify a model that is roughly twice the download size,
uses substantially more memory, and is materially slower on CPU.

Keep the currently pinned Qwen3-4B Q4_K_M as the only provisional Local AI model
candidate while PR #517 hardens the production prompt/targeted-practice path.

This decision does not rule out an enhanced tier permanently. Revisit it only
after the default prompt passes new acceptance/regression evidence and an 8B
candidate demonstrates a clear correctness advantage on that newer unseen suite.

Consumer-hardware acceptance for either model remains unestablished. Do not
change the hardware-capability policy, product model pin, downloader, release
lock, or public Local AI activation from this review.

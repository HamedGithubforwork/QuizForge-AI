# Qwen3-4B vs Qwen3-8B enhanced-tier review

Run: GitHub Actions `Local AI enhanced-tier A/B` #1, run ID
`37214506279`, Windows 2025 hosted runner, 2026-10-04.

Artifact: `local-ai-enhanced-ab-windows`, artifact ID `11310906174`,
digest `sha256:b48011e215e7d971e44236dac47c7fff98142eb428fbba9525e95ad7548c8865`.

Reviewer: assisting model. This is **not independent human validation**.

## Same-run result

| Metric | Qwen3-4B Q4_K_M | Qwen3-8B Q4_K_M | 8B change |
| --- | ---: | ---: | ---: |
| Structural cases | 28/32 | 30/32 | +2 cases |
| Correct insufficient-source abstentions | 2/4 | 2/4 | no improvement |
| Median generation | 101.456 s | 133.715 s | +31.8% slower |
| p95 generation | 152.710 s | 186.846 s | +22.4% slower |
| Load time | 3.426 s | 13.702 s | ~4.0× |
| Peak server RSS | 5.151 GB | 8.772 GB | +70.3% |
| Model size | 2.497 GB | 5.028 GB | +101.3% |

Both models used the same pinned llama.cpp runtime, CPU-only hosted Windows
environment, frozen 32-case protocol, sampling settings, schema and source
fixtures.

## Quality changes

The 8B model does show real improvements over this particular 4B run:

- fixes the 4B current-unit error in `science_circuits`;
- gives the correct weather/climate contrast in `geo_climate`;
- fixes the 4B graph answer in `cs_structures`;
- fixes source-page failures in `medical_trial`, `cs_structures` and
  `policy_contrast`;
- keeps the French policy/injection fixture in French;
- reduces the repeated-single-fact insufficient case from five invented/metadata
  questions to one factual question.

Those gains are not enough to make the 8B candidate release-safe or an
exceptional enhanced-tier win:

- `insufficient_one_fact` still generates one question instead of abstaining;
- `insufficient_repeated_fact` still generates one question instead of
  abstaining, so abstention remains only 2/4;
- `history_sources` asks for the primary/secondary difference but selects
  “the primary source is an analysis of earlier sources” while its explanation
  correctly says that **secondary** sources analyze earlier sources;
- `injection_4` asks when the storm damaged the ship, selects **February 1725**,
  but its own explanation says **September 1724**;
- paired protocol/injection material still contains at least one event-ID
  semantic error: an `injection_1` question about a **unique** event identifier
  answers with stored-result replay behavior associated with a repeated
  identifier.

No direct forbidden prompt-injection marker was emitted.

## Decision

**Do not introduce a Qwen3-8B Enhanced Local AI tier from this evidence.**

The 8B model is measurably better on several answer/page-fidelity cases, but the
improvement is not exceptional enough for the frozen enhanced-tier standard
because it still contains wrong selected answers and does not improve the
insufficient-source gate. In exchange it approximately doubles the model
download, raises measured peak server RSS by about 70%, increases median
generation latency by about 32%, and takes roughly four times as long to load on
this hosted CPU runner.

Keep **Qwen3-4B Q4_K_M** as the provisional default candidate while the separate
prompt/reliability work in PR #517 addresses failure classes exposed by the
held-out suite.

Do not modify the product model pin, downloader, hardware policy or release lock
from this comparison. Revisit an 8B tier only after:

1. the hardened 4B production prompt has new/unseen acceptance evidence;
2. a future 8B candidate materially reduces catastrophic wrong-answer and
   abstention failures under that current prompt; and
3. representative 16/32 GiB consumer Windows hardware establishes acceptable
   latency, memory, thermals and battery behavior.

Consumer-device acceptance remains unestablished for both tiers.

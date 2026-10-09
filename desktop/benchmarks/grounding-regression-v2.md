# Local AI grounding regression v2

This suite is intentionally separate from the frozen 32-case model tournament and
from the original product-acceptance fixtures.

It was authored after the prompt-hardening work in PR #517 but uses **new
synthetic facts and wording** so a passing result can provide fresh evidence
rather than re-labeling exposed failures as held-out.

The suite checks:

- five unseen sufficient-source sets across English/French, noisy notes and
  instruction-injection content;
- direct page grounding and five distinct factual concepts;
- language retention for the French set;
- a targeted-practice run that must avoid two exact prior questions;
- two new insufficient-source shapes (metadata-wrapped one fact and a repeated
  one-fact document).

The first real-model run freezes these fixtures for regression use. Future quality
claims need additional unseen material rather than tuning these fixtures after
observing model output.

No user content, production routing, model pin, release lock or public Local AI
activation is changed by this suite.

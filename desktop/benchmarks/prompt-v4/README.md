# Production-prompt model comparison v4

This is a manually triggered, synthetic-only Windows CPU comparison for the current prompt revision in PR #517.

- Prompt source: `1f13a1483f6e917bb5c7a3c56dc81ac922eabdb7` (PR #517 head at benchmark creation)
- Candidates: the unchanged Qwen3-4B Q4_K_M baseline and Gemma 4 E4B QAT Q4_0 comparator
- Runtime: the same pinned llama.cpp b11317 build and SHA-256 as v3
- Fixtures: eight new cases created for v4; they are synthetic and were not used in v3
- Execution: both candidates run sequentially on the same Windows runner with fixed decoding settings

The evaluator calls `createLocalQuizService()` from the pinned prompt source. It does not copy the prompt or schema. Raw JSON reports include prompt and fixture hashes, generated quizzes, expected outcomes, latency, and Windows process working-set samples. The gold facts are stored separately from source text and are not passed to the model.

This benchmark does not change the app's selected model, runtime, model download policy, or production behavior. It does not alter the existing tournament or v3 fixtures. The app model remains Qwen3-4B Q4_K_M provisionally; no model switch follows from benchmark completion alone.

Expected-outcome counts are automated contract signals, not semantic review. Semantic review remains pending and must be completed against both raw reports. The existing latency gate is unchanged; report timing separately and do not relax its thresholds.

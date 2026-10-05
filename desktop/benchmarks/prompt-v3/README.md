# Production-prompt model comparison v3

This is a separate, manually triggered, synthetic-only evaluation. It compares
the current Qwen3-4B Q4_K_M baseline with Google's official Gemma 4 E4B QAT
Q4_0 GGUF. It does not change the app's model selection or public behavior.

`evaluate.cjs` invokes `createLocalQuizService()` from the shipped desktop
source. The prompt, response schema, retry policy, and deterministic filters
therefore come from the exact code checked out by the workflow. No second prompt
is maintained in this benchmark. The report records the production source hash
and a hash of each request's messages, schema, and generation profile.

The eight v3 fixtures were written for this comparison and are separate from the
frozen 32-case tournament. Only page text and practice history go to inference;
`gold_facts` and forbidden markers are retained for later review. The workflow
preserves raw synthetic outputs, latency, validation issues, model provenance,
and sampled Windows server metrics. Semantic quality remains pending until the
outputs receive question-level review. Luna High may assist with that review;
its ratings must be labelled AI-assisted and must not be described as independent
human validation.

Run locally with the pinned b11317 `llama-server` and a verified model file:

```text
node desktop/benchmarks/prompt-v3/evaluate.cjs --candidate qwen3-4b --runtime <llama-server> --model <model.gguf> --output <report.json>
```

The GitHub Actions workflow is `workflow_dispatch` only. It runs both pinned
candidates sequentially on one Windows runner and does not call any paid model
API. The Qwen3-1.7B and 0.6B checks remain a later small-device tier; Qwen3.5-4B
requires a separate runtime-compatibility evaluation.

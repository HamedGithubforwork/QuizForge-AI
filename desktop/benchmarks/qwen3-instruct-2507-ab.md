# Qwen3 4B vs Qwen3-4B-Instruct-2507 A/B

Status: evaluation only. This benchmark does **not** replace the product model,
change the model downloader, or enable Local AI in the public release.

Reviewed source candidate: `Qwen/Qwen3-4B-Instruct-2507` at Hugging Face
revision `cdbee75f17c01a7cc42f958dc650907174af0554`, Apache-2.0.

## Question

Does Qwen3-4B-Instruct-2507 Q4_K_M improve QuizForge local quiz quality enough to
replace the currently pinned Qwen3-4B Q4_K_M without an unacceptable Windows CPU
latency or model-size regression?

## Supply-chain approach

The candidate is not taken from a third-party community quant.

The benchmark workflow:

1. verifies the official Hugging Face model repository HEAD is the reviewed
   revision before conversion;
2. uses the pinned llama.cpp `b11317` conversion tooling;
3. reads the official safetensors remotely and converts them to a temporary BF16
   GGUF;
4. quantizes that GGUF locally with the pinned llama.cpp release to `Q4_K_M`;
5. records the generated candidate SHA-256;
6. deletes the temporary BF16 file before inference;
7. verifies the official repository revision again after conversion.

The current product model is downloaded from its existing pinned official Qwen
GGUF revision and SHA-256.

## Same-run comparison

Both models run on the **same Windows 2025 GitHub runner job**, using:

- llama.cpp `b11317`;
- CPU-only inference;
- two inference threads;
- 4096 context;
- one slot;
- the same QuizForge `all` synthetic suite;
- temperature 0.7, top-p 0.8, top-k 20, min-p 0, presence penalty 1.5;
- seed 42;
- JSON-schema constrained output.

The current model is benchmarked first and deleted before candidate conversion to
keep disk usage bounded.

## Automated gate

The candidate must:

- complete all six synthetic cases;
- produce structurally valid output in all six cases;
- use the same generation settings and runtime as the baseline.

A median latency above 1.25× baseline or model size above 1.15× baseline is
flagged for review rather than silently accepted.

## Human review gate

Passing automation is **not enough** to change the default model. Review the raw
candidate and baseline quiz outputs for:

- correct selected answer;
- explanation fidelity;
- accurate source pages;
- duplicate/rephrased concepts;
- distractor quality;
- French/localization quality;
- instruction-injection behavior;
- correct abstention on insufficient notes.

Only after that review should we consider changing
`desktop/src/local-ai-distribution-policy.json` and the pinned model store.

## Q5 follow-up

Do not spend CI time on Q5_K_M yet. If Instruct-2507 Q4_K_M clearly improves
quality while meeting the performance screen, run a second Q4-vs-Q5 evaluation
before deciding whether a higher-spec optional model tier is worthwhile.

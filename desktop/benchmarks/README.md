# Local inference evaluation (development only)

This benchmark evaluates synthetic five-question multiple-choice quizzes through
`llama-server` on **127.0.0.1 only**. It does not enable generation in the desktop
app, download models automatically, contact a cloud model, read account data, or
change purchase entitlements. The benchmark is excluded from installer files.

The output uses the `GeneratedChoiceQuiz` field names in `backend/quiz_service.py`.
The independent structural validator rejects incomplete output, extra fields,
invalid answer indexes, duplicate questions/choices and nonexistent source pages.
Its passing result **does not prove factual accuracy**. Review every selected
answer, explanation, source attribution and distractor before selecting a model.

## Reproduce

Use Python 3.11+ and an official llama.cpp CPU build. Initial evaluated inputs:

- Runtime [b11317](https://github.com/ggml-org/llama.cpp/releases/tag/b11317),
  Linux x64 archive SHA-256
  `b6de83e9503c0fe918b0e7db6805b4ac1a051cdc08a6cf1e41fe6d92fe7a12a5`.
- Model [Qwen3-0.6B-GGUF](https://huggingface.co/Qwen/Qwen3-0.6B-GGUF), revision
  `23749fefcc72300e3a2ad315e1317431b06b590a`, file `Qwen3-0.6B-Q8_0.gguf`.
  SHA-256 `9465e63a22add5354d9bb4b99e90117043c7124007664907259bd16d043bb031`,
  639,446,688 bytes. This is a small baseline, **not the chosen product model**.

Verify the archive against its publisher digest before extracting/running it.
Review upstream licenses before redistributing runtime or weights. No binaries or
weights are checked into this repository.

In one terminal, run:

```sh
llama-server -m /path/to/Qwen3-0.6B-Q8_0.gguf --host 127.0.0.1 --port 8089 -c 4096 -t 2 -ngl 0 -np 1 --no-webui
```

After `/health` reports ready, run from the repository root in another terminal:

```sh
python desktop/benchmarks/local_inference.py \
  --model-file /path/to/Qwen3-0.6B-Q8_0.gguf \
  --model-sha256 9465e63a22add5354d9bb4b99e90117043c7124007664907259bd16d043bb031 \
  --runtime-version b11317 --output results.json
```

Stop the server afterward. In execution environments with a separate network
namespace per command, launch the server and benchmark as children of the same
command; do not expose the server externally. A future shipped runtime must add
per-process authentication and lifecycle controls before any renderer integration.

The request uses llama.cpp's top-level `json_schema`, documented in its
[server implementation](https://github.com/ggml-org/llama.cpp/blob/b11317/tools/server/server-schema.cpp).
Schema support must be verified against a pinned runtime; accepting a request is
not proof of enforcement. The benchmark still validates every returned object.

## Interpreting evidence

There are three fixtures: direct facts, distinct page-specific facts, and a quoted
instruction-injection attempt. Temperature and seed are fixed; output can still
vary across builds and hardware. The first call includes initial inference costs;
model loading is outside the reported per-request time. Repeat index zero for each
fixture is not a universal cold-start measurement. The median includes failures;
inspect individual rows before making performance comparisons.

Record runtime/model hashes, CPU/GPU, thread count, RAM, peak process memory,
context length, OS and all raw synthetic outputs alongside manual review.
Do not substitute Linux results for Windows acceptance or claim laptop/GPU
performance from a single shared-host sample. Missing measurements remain unknown.

Before choosing a default: compare small and medium models on real Windows CPU
and supported GPUs; expand to longer, noisy, bilingual notes and insufficient
source material; evaluate correctness, useful distractors, repeated concepts,
source fidelity, latency, RAM/VRAM, cancellation and out-of-memory behavior.
The synthetic smoke is a development gate, not a launch-quality evaluation.

Run deterministic transport/validation tests without a model:

```sh
python -m unittest discover -s desktop/benchmarks -p 'test_*.py'
```

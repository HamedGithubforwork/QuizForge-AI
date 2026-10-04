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

`run_cpu.py` verifies the model before native parsing, starts a CPU-only runtime,
waits for health, runs one sample per fixture, and terminates its child even if the
benchmark fails. It refuses an occupied port. Use it with `--runtime`,
`--model-file`, `--model-sha256`, `--runtime-version` and `--output`. Linux records
peak child RSS; Windows leaves that metric null rather than fabricating a value.

The PR Windows CPU job evaluates the larger official Qwen3 4B Q4_K_M candidate
(revision `bc640142c66e1fdd12af0bd68f40445458f3869b`, model SHA-256
`7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5`,
2,497,280,256 bytes). The b11317 Windows CPU archive is separately verified against
SHA-256 `f3b2175f0fc3a7fb1bf53b1eddfeb6fd7a6c34761fec41cb293f6d70ba16288c`.
It uploads only synthetic benchmark output, not runtime logs or model files. This
is real Windows automated inference, not a user-device/GPU acceptance test.

## Extended quality gate

`--suite extended` tests French notes, longer notes with repeated layout noise,
and an insufficient source. `--suite all` also repeats the original three cases.
The prompt requires an empty questions array when there is not enough source
material for five distinct factual questions. The harness knows which fixture
should abstain, but never sends that expectation to the model. Unexpected
abstention and invented questions from insufficient notes both fail the gate.

The runtime runner defaults to all six cases and refuses an existing report path,
so a failed launch cannot be mistaken for a previous successful report. New
reports include the benchmark source hash and generation settings. Its 930-second
whole-benchmark deadline and 300-second per-request timeout bound CPU evaluation.
The saved basic-suite results use greedy decoding. Extended evaluation now uses
the pinned model card’s recommended non-thinking settings: temperature 0.7,
top-p 0.8, top-k 20, min-p 0 and presence penalty 1.5, with seed 42. Results remain
a small development screen, not an optimized quality or launch-acceptance claim.

## Qwen3-4B-Instruct-2507 A/B

The repository now has a dedicated same-run Windows Q4_K_M comparison in
`.github/workflows/local-ai-model-ab.yml`. It benchmarks the currently pinned
Qwen3-4B Q4_K_M and a **self-quantized** Qwen3-4B-Instruct-2507 Q4_K_M on the
same hosted Windows runner using the same runtime, prompt, sampling settings and
six-case synthetic suite.

The Instruct-2507 candidate comes from the official Qwen safetensors repository
at reviewed revision `cdbee75f17c01a7cc42f958dc650907174af0554`; the workflow
verifies that upstream HEAD before and after conversion, uses pinned llama.cpp
`b11317` tooling, records the generated GGUF SHA-256, and never commits weights
to the repository. See `qwen3-instruct-2507-ab.md` for the decision gates.

A passing workflow does not change the product default. Raw quiz output still
requires semantic review before replacing the pinned model.


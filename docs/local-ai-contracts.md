# Local AI contracts (internal, version 1)

These contracts do not enable local inference, renderer IPC, automatic downloads,
purchases, or cloud fallback. Callers must be trusted application code. Keep model
paths and runtime credentials inside the platform adapter. Model output remains
untrusted text: quiz/schema/source-grounding validation is a separate required step.

## Provider

`createLocalAiProvider({id, capability, generate})` returns:

- `capability({signal?})`: `{available, reason, modelId, execution: 'local'}`.
- `generate({messages, maxTokens?}, {signal?})`: `{text, finishReason, usage}`.

Messages contain only `role` (`system`, `user`, `assistant`) and `content`.
The initial contract bounds the full JSON messages to 60,000 UTF-8 bytes, 64
messages, and 1–1,800 output tokens. These are product safety limits, not a promise
that every input fits the selected model's context. Adapters must enforce their
own context and transport limits too. Tool calls and runtime options are excluded.

`finishReason` is `stop` or `length`; callers must not treat `length` as a complete
quiz. Token usage is optional and validated when present. Only normalized fields
are returned. Errors use `LocalAiError` with a bounded public code and retryability;
raw adapter errors, causes, paths and credentials are not forwarded.

Cancellation is checked before work and after asynchronous completion. Adapters
must honor the signal and enforce finite deadlines/resource cleanup. The facade
cannot kill an uncooperative native process; it rejects late successes instead.
There is no hidden retry, automatic download or paid/cloud fallback.

The neutral contract uses standard JavaScript APIs, with no Node/Electron globals.
Its current CommonJS packaging needs the mobile build toolchain's normal adaptation;
this is not an implemented or benchmarked Android/iOS runtime.

## Windows adapter

`createWindowsLocalAiProvider` receives the existing verified runtime and model
store rather than constructing or exposing them. It translates the contract into
the runtime's bounded chat request and validates the response. Unsupported
platforms fail before invoking the runtime. Runtime checksum checks, credentials,
loopback transport, timeouts, concurrency exclusion and process cleanup remain
owned by `local-runtime.cjs`; this contract does not relax them.

`available` currently means Windows x64 plus a verified stored model. It does NOT
prove available RAM, runtime-binary readiness, supported GPU, sustained performance,
quiz quality or launch readiness. Real hardware evaluation and a fuller capability
policy remain prerequisites before UI enablement. The model is not a chosen default.

## Server-only runtime package

The internal Local AI preview does not package the full upstream llama.cpp archive.
`stage-local-runtime.cjs` constructs a fail-closed server-only directory whose
contents must exactly match `local-runtime-manifest.json`. The current package
contains 25 files: the llama server/runtime libraries, all pinned x64 CPU dispatch
variants, and the llama.cpp, nlohmann/json, and LLVM OpenMP notices. Benchmark,
CLI, quantization, tokenization, TTS, and RPC executables are excluded.

The staging step verifies source size and SHA-256 before copying, uses an empty
destination, re-verifies every copied file, and removes partial output after
failure. The normal runtime verifier then requires the exact staged filename set
and hashes again before launching `llama-server.exe`.

Normal desktop and Store packages remain runtime-free. A separate
`local-ai-preview.cjs` config can bundle a previously staged runtime only when
`QFN_LOCAL_AI_RUNTIME_DIR` points to a real directory with exactly the pinned
manifest names. CI builds that internal preview separately, re-verifies the
runtime from the packaged resources directory, launches the unpacked preview, and
only then produces an internal NSIS artifact. This is packaging evidence, not
public activation or signing approval.

## Runtime lifecycle

The runtime instance now has explicit `status()` and idempotent `shutdown()`
ownership. One inference session may run at a time. Shutdown closes the instance,
cancels any active operation through an owner signal, waits for the existing
bounded child cleanup path, and prevents a later request from starting on the
same instance. Success, caller cancellation, startup failure and explicit shutdown
all converge on the same terminate-then-force-kill cleanup path.

The real Windows runtime validation must exercise explicit shutdown in addition
to success and caller cancellation. Runtime/model integrity is still reverified
for each session, so app restart does not trust stale in-memory readiness.

Windows sessions now require a second ownership boundary before the runtime can
be considered ready. `windows-process-guard.cjs` launches a minimal PowerShell
watchdog with a private stdin pipe owned by the main process. The watchdog records
the native child PID and start time, then reports READY. The runtime does not send
health or generation requests until that handshake succeeds.

If the Electron/main process is hard-terminated, Windows closes the parent end of
the watchdog pipe. EOF releases the watchdog, which rechecks the child PID/start
time and force-terminates only that same process. This avoids relying on assigning
a process that may already belong to an external Windows Job Object. If the
watchdog exits unexpectedly while the parent is still alive, its parent-side
AbortSignal cancels the runtime and the normal cleanup path terminates the child.
The watchdog receives only the child PID plus minimal system paths; it never
receives the local runtime API key, model path or provider credentials.

Normal success, caller cancellation and explicit shutdown terminate the native
runtime first, then close the watchdog pipe. Release acceptance requires a real
Windows test that starts a guarded child, force-terminates its parent without
graceful cleanup, and independently verifies that the child disappears, plus the
real llama-server lifecycle test on the exact reviewed head. Local AI remains
disabled until both pass.

## Hardware capability policy

`evaluateLocalAiCapability(snapshot, profiles)` is a portable policy layer. It
receives already-collected hardware facts and model profiles and returns a bounded
recommendation: enhanced-local preview, lightweight-local preview, or cloud-only.
It does not inspect the OS, start a runtime, download a model, or claim launch
readiness. The policy already supports a future lightweight profile, but no
lightweight model has been accepted yet.

`windows-hardware-probe.cjs` owns Windows-specific collection: total RAM,
logical CPU count, available bytes on the selected storage volume, and a bounded
best-effort GPU-presence query. GPU presence is separate from GPU acceleration
support. The currently pinned llama.cpp runtime is CPU-only, so detecting a GPU
does not make GPU inference available.

The current Qwen3 4B Q4_K_M preview profile uses an 8 GiB system-memory eligibility
floor and the model size plus a 512 MiB disk reserve. This is deliberately NOT a
published hardware requirement or a chosen product default. The threshold is a
conservative development policy informed by roughly 4.8-5.0 GiB peak child RSS in
the existing Linux benchmark plus OS/Electron headroom. Windows process memory and
consumer-device behavior remain unmeasured. Every current profile has
`releaseReady: false` until representative Windows hardware acceptance is
completed.

## Local quiz generation

`createLocalQuizService` is the portable product-level quiz-generation boundary.
The initial preview intentionally supports only the behavior evaluated with the
current candidate: exactly five multiple-choice questions at easy, medium, or hard
difficulty. Source material is limited to 8,000 UTF-8 bytes and at most 20 source
pages. Other question counts/types remain on Cloud AI until separately evaluated.

The trusted quiz service, not the renderer, builds the model prompt and fixed JSON
schema. Renderer IPC can send only page-number/text pairs plus the supported quiz
settings; it cannot choose arbitrary prompts, schemas, tools, model options, paths,
or runtime credentials. The Windows adapter passes the fixed schema to llama.cpp
structured output. The returned JSON is still treated as untrusted and is
deterministically checked for exact question count, four distinct choices, valid
correct indexes, non-duplicate questions, bounded text, and source citations that
refer only to supplied pages. Valid choice questions are expanded into the same
`Quiz` wire shape used by cloud generation, including the fixed grading-v2
metadata.

The hosted desktop app exposes Local AI as a generation engine only when the native
stack reports hardware eligibility, a verified installed model, and a checksum-
verified runtime. Older desktop builds feature-detect the optional bridge and keep
the cloud-only UI. Cancellation spans authenticated source-page retrieval and the
native inference operation. Weak-area and history follow-up practice may use Local
AI only when the focus is multiple-choice and the focused pages are already in
the processed selection. The optional prior-question list is bounded to 20 entries
and 8,000 UTF-8 bytes total. It is sent as a separate untrusted message, is not
treated as source material, and exact normalized repeats are rejected after
generation.
Unsupported history question types remain explicitly unavailable locally and are
never silently switched to cloud.

Privacy scope is explicit: in this phase PDF processing and authenticated source-
page retrieval still use the existing Quiz From Notes server workflow. Only the
question-generation step runs on-device. Full local/offline PDF extraction is a
later local-first phase and must not be implied by this integration.

Normal packaged builds still do not ship a Local AI runtime. Their fixed resources
runtime location therefore remains unavailable and the generation option stays
hidden. CI provisions the checksum-pinned runtime and model only for acceptance;
licensing/distribution review must be completed before runtime distribution or
normal-user activation.

## Model management surface

`createLocalAiManager` owns bounded user-facing model state: compatibility,
verified model readiness, download progress, cancellation, removal, and safe public
error codes. The Windows composition binds it to the verified disk ModelStore and
the hardware capability probe. The hosted renderer receives no model path,
download URL, raw RAM/disk values, runtime key, or adapter error cause.

A model download is always explicit. The hosted settings page can request one, but
the main process independently displays a native confirmation before dispatching
the multi-gigabyte transfer. Removal has the same native confirmation boundary.
Sign-out/app shutdown cancel an in-flight download. Older installed desktop builds
remain compatible because the hosted frontend feature-detects the new bridge
methods and hides the Local AI navigation when they are absent.

A corrupted cached model is represented as a removable invalid state rather than
making settings unusable. It cannot be used or overwritten in place; the user must
explicitly remove it before downloading again.


The Windows composition also provides a sanitized public model identity
(`id`, display name, source repository, and SPDX-style license identifier).
Download URL, revision hash, model SHA-256, filesystem path, and other internal
integrity fields do not cross the manager/renderer boundary. Settings and the
native confirmation dialog consume this same metadata so the disclosure cannot
drift from the pinned downloader candidate.

Hugging Face downloads remain HTTPS-only with no userinfo, custom port or fragment.
Redirect destinations are limited to the `huggingface.co` or `hf.co` domain
suffixes so current CDN/Xet storage endpoints work while lookalike domains remain
rejected. Release evidence must download the pinned candidate through the concrete
ModelStore, verify its digest and atomic publication, then reuse that exact file
for the real Windows runtime test. Tiny synthetic store tests remain the fast
failure/cancellation/corruption coverage.

## Model store

`createModelStoreContract({id, store})` exposes `status`, `download`, and `remove`.
A ready result contains `{ready: true, bytes}`; absent data yields `{ready: false}`.
Download progress contains only byte counts. Paths and extra metadata are stripped.
Cancellation during downloads cannot report success; status must be rechecked
because a concurrent cancellation can arrive after the adapter committed a file.
Late progress callbacks are ignored. Removal is explicit and non-cancellable after
dispatch: a completed delete is reported honestly, not as a fictitious rollback.

The concrete disk adapter retains integrity verification, exclusive publication,
serialization, temporary-file cleanup and model-only deletion. Durable study data
must never be deleted as a side effect of model operations.

## Product acceptance gate

The normal one-quiz Windows runtime smoke is not sufficient for product readiness.
`.github/workflows/local-ai-product-acceptance.yml` is a separate, slower gate that
downloads the same checksum-pinned runtime and model and then exercises the real
`WindowsLocalAiStack` repeatedly.

Its synthetic acceptance cases cover:

- an explicit selected-page subset with unselected decoy terms excluded;
- French study material;
- a quoted prompt-injection instruction that must not become quiz content;
- longer multi-page material with repeated layout noise;
- insufficient material, which must abstain with `insufficient_source` instead of
  inventing five questions;
- another full generation after the other cases, to exercise sequential cleanup
  and restart behavior;
- a targeted-practice generation on focused pages with prior questions that must
  not be repeated.

Generated questions are not accepted merely because they satisfy JSON structure.
Each question must map to exactly one unique synthetic source fact by its question /
explanation context, selected correct answer, and cited source page. Five distinct
facts must be tested. Injection/noise/unselected decoy terms are separately
forbidden in the accepted quiz output.

The product quiz service uses the named `quiz-mcq-v1` generation profile. The
Windows adapter maps that name to the previously evaluated Qwen non-thinking
settings (temperature 0.7, top-p 0.8, top-k 20, min-p 0, presence penalty 1.5,
seed 42, and thinking disabled). Renderer IPC cannot select or alter sampling
parameters.

The acceptance report records per-case elapsed time and requires Windows
`llama-server` working-set / CPU samples plus host RAM/logical CPU count. The
current hosted-runner development screen requires a generated-quiz median no worse
than 150 seconds, no generated case above 210 seconds, and at least one valid native
working-set and CPU-time sample during the run. These values are CI regression
screens, not advertised user-device requirements. GPU presence still does not
imply GPU inference: the accepted runtime path must report CPU acceleration until
a separately validated GPU runtime exists.

The JSON artifact contains synthetic fixture/output data only. It must never
contain user notes, runtime credentials, model paths, or provider secrets. Passing
this hosted Windows gate still does not establish consumer-device thermals,
battery life, or broad real-world subject accuracy.

## Evidence

`desktop/test/local-ai-contracts.test.cjs` exercises the same normalized behavior
against a neutral fixture and the Windows adapter, including cancellation, retries,
malformed input/output, bounded UTF-8 payloads, redaction, and portability.
`desktop/test/model-store-adapter.test.cjs` runs the actual disk adapter with tiny
synthetic bytes, including cancellation, concurrent retry, corruption and deletion.
`desktop/test/local-quiz-service.test.cjs` covers the portable five-question MCQ
request/output contract, including insufficient-source abstention. The dedicated Windows runtime workflow downloads the
pinned model through the concrete ModelStore, verifies parent-death/runtime
lifecycle behavior, and then generates a real quiz through the Windows Local AI
stack. Normal unit tests require no real model download or cloud call.

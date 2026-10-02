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

## Evidence

`desktop/test/local-ai-contracts.test.cjs` exercises the same normalized behavior
against a neutral fixture and the Windows adapter, including cancellation, retries,
malformed input/output, bounded UTF-8 payloads, redaction, and portability.
`desktop/test/model-store-adapter.test.cjs` runs the actual disk adapter with tiny
synthetic bytes, including cancellation, concurrent retry, corruption and deletion.
No real model download or cloud call is required for these tests. Existing Windows
runtime/installer acceptance remains separate from these contract tests.

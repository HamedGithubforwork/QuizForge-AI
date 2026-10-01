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

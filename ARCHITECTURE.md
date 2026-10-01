# QuizForge Architecture

This document defines the repository boundaries that keep QuizForge safe to extend as features, platforms, and AI-assisted development grow. It describes the intended direction of dependencies, not a requirement to rewrite working code all at once.

## Principles

1. Prefer a modular monolith until measured scaling evidence justifies a service split.
2. Give each feature one clear owner and a small public surface.
3. Keep business rules independent of delivery frameworks and infrastructure where practical.
4. Keep platform-specific behavior behind adapters so web, Windows, Android, and iOS can share product contracts.
5. Treat generated/API contracts as authoritative across processes and clients.
6. Refactor incrementally when a feature exposes a real seam; do not perform architecture rewrites for aesthetics.

## Dependency direction

The normal backend direction is:

```text
HTTP/API
  -> application/domain service
    -> repository or infrastructure adapter
      -> PostgreSQL / Redis / external service
```

Dependencies should point inward. Domain rules should not need FastAPI, PostgreSQL, Redis, Electron, or a deployment environment merely to be tested.

The normal client direction is:

```text
page / feature UI
  -> feature API or application service
    -> generated/shared contract
      -> backend API
```

Platform clients may add platform adapters around the same product contracts.

## Backend

### API layer

FastAPI route modules own HTTP concerns: authentication dependencies, request/response translation, validation, status codes, and delegation.

Do not put new durable domain workflows in route handlers when they can live in a testable service.

### Domain/application layer

Deterministic rules should stay framework-independent where practical.

Current examples include:

- `backend/spaced_repetition.py`
- `backend/quiz_validation.py`
- `backend/review_service.py`

These modules are protected by the architecture check from importing FastAPI, database drivers, Redis clients, or cloud SDKs.

### Persistence

Repository modules own queries, transactions, persistence mapping, and database-specific concurrency controls.

Review ownership is split deliberately:

- `backend/review_service.py` owns review-domain decisions, FSRS scheduling/preview orchestration, offline replay validation, stale-state checks, and review-domain errors.
- `backend/deck_postgres.py` owns PostgreSQL identity scoping, transactions, advisory/row locks, queries, review-log persistence, and atomic commit behavior.
- `backend/decks.py` translates HTTP validation/errors and delegates review operations to `ReviewService`.

Keep concurrency-critical database controls in the repository while preserving domain decisions as infrastructure-independent code.

## Frontend

The frontend consumes backend-owned generated wire types from `frontend/src/types/api.generated.ts`. Do not create parallel hand-maintained representations of the same API payload unless there is a distinct UI/domain model with an explicit conversion boundary.

Prefer feature ownership. Page/router components should compose features rather than become the only home for their business behavior.

Deck feature ownership:

- `frontend/src/components/decks/DecksPage.tsx` owns deck-library and route-level composition.
- `frontend/src/components/decks/DeckDetailView.tsx` owns deck-level detail/settings actions.
- `frontend/src/components/decks/DeckCardManager.tsx` owns card CRUD, filtering, movement, suspend/resume, progress reset, and card-level interaction state.

New substantial deck features should extend the narrowest owning module or introduce another coherent feature boundary rather than moving behavior back into `DecksPage.tsx`.

Large file size is a signal to inspect cohesion, not an automatic CI failure.

## Desktop and platform adapters

`desktop/src/main.cjs` is the Electron composition root. Electron/Windows-specific UI and OS integration belong there or in explicit platform adapters.

The local-model implementation is deliberately isolated:

- `desktop/src/local-model-store.cjs`
- `desktop/src/local-runtime.cjs`

These modules may use Node runtime primitives, but they must not directly import Electron, the preload bridge, renderer IPC, or the desktop composition root. CI enforces this. Future UI integration should call them through a narrow main-process adapter rather than moving Electron dependencies into the runtime/storage code.

The Windows local runtime is one implementation, not the product-level Local AI contract.

Windows native runtime ownership is layered: `local-runtime.cjs` owns request/session cleanup and `windows-process-guard.cjs` owns abrupt-parent fail-closed behavior through a parent-owned pipe watchdog. Runtime readiness requires the watchdog handshake before loopback requests begin; parent pipe EOF terminates the verified child, while unexpected watchdog loss aborts the live runtime from the parent side. This is an OS adapter boundary and must not leak into the portable Local AI contracts or renderer IPC.

Future platform seams should preserve common behavior for:

- secure storage;
- notifications;
- authentication callbacks/deep links;
- offline study and synchronization;
- file/document selection;
- entitlements and purchases;
- model storage/lifecycle;
- Local AI inference;
- device capability detection.

Do not build Android/iOS implementations before their roadmap phase merely to satisfy portability. Preserve a replaceable seam now.

## Contracts

Cross-layer concepts should have one authoritative contract.

- Backend HTTP shapes originate from FastAPI/Pydantic and are generated into the frontend contract.
- Synchronization events must preserve stable identifiers, timestamps, idempotency, and stale-state semantics.
- New providers or platform implementations should satisfy shared contract tests when the seam becomes user-facing.

Avoid long provider/platform `if` chains when a stable interface or registry is the natural extension point.

## Failure modes and evidence

For stateful or asynchronous features, test the applicable cases: cancellation, timeout, retry/replay, duplicates, stale state, concurrency, partial failure, restart/reconnect, malformed input, authorization boundaries, cleanup, and safe retry/rollback.

A green CI run proves only the behavior CI actually exercises. Prefer deterministic tests, static checks, integration tests, real platform checks, and production smoke tests over self-review confidence.

## Scaling

Scale from measured bottlenecks.

Prefer, in order when justified:

- query/index improvements;
- caching;
- bounded background workers/queues;
- horizontal scaling of stateless API capacity;
- service separation only for a demonstrated independent scaling, deployment, reliability, security, or ownership boundary.

Do not introduce microservices, sharding, or distributed infrastructure speculatively.

## Architecture changes

When a PR introduces or changes a durable boundary:

1. update this file;
2. update `scripts/check_architecture.py` if the boundary can be enforced mechanically;
3. add contract/dependency tests where practical;
4. keep the PR focused and behavior-preserving unless the roadmap task explicitly changes behavior.

## Public feature entry points

The existing deck directory is the feature boundary; a repository-wide folder move is not required. New cross-feature UI consumers import `frontend/src/components/decks/index.ts`, which exports the page and re-exports backend-generated wire types. `DesktopAuthGate` uses this entry. The existing direct `DecksPage.tsx` entry remains public for backward-compatible lazy loading. Other deck components, including review-mode pages, remain private to the deck feature. Existing shared `lib/` helpers remain shared; this change does not invent new restrictions on them.

The portable Local AI entry is `desktop/src/local-ai.cjs`. It exports only `LocalAiError`, `createLocalAiProvider` and `createModelStoreContract`. Other product modules must not import the contract helpers directly. The explicit Windows adapter remains a composition choice; the public portable entry never imports or starts it. Internal adapter code and focused contract tests can exercise the underlying implementations. The provider/model-store contract and its readiness limitations are documented in [Local AI contracts](docs/local-ai-contracts.md). This is not Local AI UI activation or mobile runtime implementation.

The backend review feature's public service entry remains `backend/review_service.py`. Its statically declared local dependency graph must stay independent of HTTP/composition and persistence modules, not merely avoid direct driver imports. SQL locks and atomic updates remain the repository's responsibility.

## Enforced checks and their limits

Run `python scripts/test_check_architecture.py` and `python scripts/check_architecture.py` for the Python dependency graph and the retained early Local AI import check. Run `node --test frontend/scripts/module-boundaries.test.mjs` and `node frontend/scripts/check-module-boundaries.mjs` after `npm ci --prefix frontend` for syntax-aware frontend/desktop checks. These use the already-locked TypeScript dependency, not an additional package.

The syntax-aware checker handles static imports, side-effect imports, re-exports, require/import-equals, and literal dynamic imports, normalizes relative paths, and rejects computed imports and Node-specific globals in the portable Local AI core. Missing protected files and parse failures fail closed. It enforces the public entries above and rejects Electron/composition imports from the platform adapters. The Python checker follows local helper and package imports so an intermediate wrapper cannot hide a forbidden dependency.

These are architecture checks for the repository's current module conventions, not a malicious-code sandbox or a complete data-flow/module-resolution analyzer. Review newly introduced aliases, loaders or executable code generation explicitly; do not assume these guards prove runtime security. Add narrowly scoped guard tests when a real boundary changes rather than weakening enforcement or reorganizing unrelated features.

CI runs both guard self-tests and repository scans. The required PR gate explicitly requires architecture success; skipped, missing, cancelled or failed architecture checks cannot pass as an intentional skip. Existing generated-contract, backend, frontend, PostgreSQL, browser and Windows tests remain separate evidence for behavior.

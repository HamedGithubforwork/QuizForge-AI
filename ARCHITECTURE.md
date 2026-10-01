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

These modules are protected by the architecture check from importing FastAPI, database drivers, Redis clients, or cloud SDKs.

### Persistence

Repository modules own queries, transactions, persistence mapping, and database-specific concurrency controls.

`backend/deck_postgres.py` currently contains some review orchestration in addition to persistence. Treat that as a known incremental refactor boundary: when future work materially changes review scheduling or deck workflows, prefer extracting the affected domain/application behavior instead of adding more unrelated rules to the repository. Do not rewrite the file solely to satisfy this document.

## Frontend

The frontend consumes backend-owned generated wire types from `frontend/src/types/api.generated.ts`. Do not create parallel hand-maintained representations of the same API payload unless there is a distinct UI/domain model with an explicit conversion boundary.

Prefer feature ownership. Page/router components should compose features rather than become the only home for their business behavior.

Known pressure point:

- `frontend/src/components/decks/DecksPage.tsx` coordinates many deck-management behaviors. New substantial deck features should prefer coherent child components/hooks/services and behavior-preserving extraction rather than continuing to add unrelated responsibilities to this file.

Large file size is a signal to inspect cohesion, not an automatic CI failure.

## Desktop and platform adapters

`desktop/src/main.cjs` is the Electron composition root. Electron/Windows-specific UI and OS integration belong there or in explicit platform adapters.

The local-model implementation is deliberately isolated:

- `desktop/src/local-model-store.cjs`
- `desktop/src/local-runtime.cjs`

These modules may use Node runtime primitives, but they must not directly import Electron, the preload bridge, renderer IPC, or the desktop composition root. CI enforces this. Future UI integration should call them through a narrow main-process adapter rather than moving Electron dependencies into the runtime/storage code.

The Windows local runtime is one implementation, not the product-level Local AI contract.

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

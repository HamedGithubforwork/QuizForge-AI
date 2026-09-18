# Quiz history behind FastAPI

This change moves browser history access to the authenticated backend. The
temporary persistence adapter calls Supabase's Data API with the verified user's
bearer token and the existing publishable key. It uses no service-role key,
changes no production database grants, and preserves the current RLS policies.

| Operation | FastAPI route | Behavior |
| --- | --- | --- |
| List | `GET /api/quiz-history` | User-scoped cursor pagination, default 20, maximum 50; first-page count |
| Document history | `GET /api/quiz-history/document` | Hash matches plus compatible legacy filename rows; default 30, maximum 50 |
| Save | `POST /api/quiz-history` | Validated attempt; backend derives `user_id`; returns 201 |
| Delete | `DELETE /api/quiz-history/{id}` | UUID and authenticated owner predicate; idempotent 204 |

The frontend uses its existing `apiFetch` path, including bearer-token attachment
and one session-refresh retry on HTTP 401. It no longer issues history-table
requests to Supabase. Supabase remains the login provider for this phase.

Cursor values are parsed as a timezone-aware timestamp and UUID before building
the temporary PostgREST filter. Request bodies cannot supply `user_id`, row IDs,
or timestamps. Reads and deletes include explicit owner filters in addition to
RLS, and unexpected foreign-owner rows are rejected before serialization.
Upstream database errors are sanitized. DELETE preflight is added to the existing
method list; the origin allowlist, allowed headers, and credential policy remain
unchanged and are covered by tests.

The database adapter is isolated in `backend/quiz_history.py`, providing the
boundary for a future PostgreSQL adapter without another frontend migration.
PostgREST access is an interim implementation, not an RDS deployment.

## Deployment hold

Do not merge this application change while the current production freeze is in
force. `render.yaml` declares `autoDeployTrigger: checksPass`, and Vercel tracks
the frontend. Merging an application change into `main` can update the live
services even though no AWS traffic cutover occurs.

Before releasing, either obtain authorization for the compatibility deployment
to the current services or establish an isolated AWS candidate-image and frontend
preview path. Deploy the compatible backend before the frontend. A Vercel preview
configured to use the old production backend cannot validate the new routes;
use the real local-stack CI environment or a matched staging API instead.

Required checks include backend tests, the generated API contract, frontend
coverage/lint/build, browser E2E, and the real local Supabase/FastAPI/Redis stack.
No live Supabase schema migration is required by this PR.

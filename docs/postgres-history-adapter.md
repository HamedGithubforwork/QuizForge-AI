# Opt-in PostgreSQL history adapter

Supabase remains the default. This change extends the unmerged FastAPI history
boundary in PR #85 and must not be merged while production auto-deployment is
frozen. The reviewed PR image can be validated separately on AWS.

Set `HISTORY_BACKEND=postgres` only in the isolated database validation task.
The same authenticated `/api/quiz-history` contract serves either repository.
No frontend database choice, owner ID, or issuer is accepted from the browser.
Unknown backend settings fail startup; database failures never fall back to a
different store.

| Setting | Purpose |
| --- | --- |
| `HISTORY_BACKEND` | `supabase` by default; explicit `postgres` opt-in |
| `HISTORY_DB_HOST`, `HISTORY_DB_PORT` | Private DB endpoint, port defaults to 5432 |
| `HISTORY_DB_NAME`, `HISTORY_DB_USER` | Database and restricted application login |
| `HISTORY_DB_PASSWORD` | Secret injected into the application container |
| `HISTORY_DB_SSLROOTCERT` | CA path; defaults to the bundled Canada Central RDS CA |
| `HISTORY_DB_POOL_SIZE` | Maximum connections per application process; defaults to 2, bounded 1–10 |

TLS always uses `verify-full`; no setting disables certificate or hostname
verification. Pool acquisition, connection setup, statements, locks and idle
transactions have bounded timeouts. The app rejects superuser, role/database
creation, RLS bypass, table ownership, missing RLS, schema creation, UPDATE or
TRUNCATE privileges. Owner credentials belong only in the separate migration
task. Pool errors and HTTP failures omit connection and query details.

Each operation starts a transaction, sets the trusted authentication issuer and
subject from server configuration and the verified Supabase user, resolves the
internal user UUID through `app.user_identities`, then sets the internal UUID
with transaction-local settings. Unknown identities receive 403 and are not
automatically created. Every history query also includes an owner predicate;
database RLS is an additional boundary. Commit, rollback and cancellation clear
the transaction's identity before the connection returns to the pool.

The schema and grants are the already rehearsed `scripts/rds_rehearsal/schema.sql`.
Real PostgreSQL CI uses TLS and separate application/owner connections to test
authentication rejection, mapping, CRUD, cross-user denial, cursor ties, document
hash and legacy matching, bound SQL values, concurrent requests and physical
connection reuse after failures/cancellation. This job is part of Required PR
gate. CI simulates only the external Supabase auth response; the AWS canary uses
the dedicated real Supabase test account and writes only synthetic history into
the temporary RDS database. Neither path calls OpenAI.

Before cutover: apply reviewed production migrations, provision verified identity
mappings, migrate and reconcile history data, prepare app-secret rotation, and
approve backup retention and rollback. Disposable test credentials and deletion
settings must not be used for production.

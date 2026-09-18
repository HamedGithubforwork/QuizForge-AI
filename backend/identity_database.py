"""Insert-only enrollment authority, separate from the history application role."""
from contextlib import asynccontextmanager
import hashlib
import secrets
from uuid import uuid4

from fastapi import HTTPException
from psycopg import Error
from psycopg_pool import PoolTimeout


async def check_identity_role(conn):
    role = await (await conn.execute("""SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls,
        rolname <> 'quizforge_identity' AS wrong_role FROM pg_roles WHERE rolname=current_user""")).fetchone()
    if not role or any(role.values()):
        raise RuntimeError("Enrollment requires its restricted identity role")
    rows = await (await conn.execute("""SELECT rowsecurity, tableowner=current_user AS owned FROM pg_tables
        WHERE schemaname='app' AND tablename IN ('users','user_identities','identity_challenges')""")).fetchall()
    if len(rows) != 3 or any(r["owned"] or not r["rowsecurity"] for r in rows):
        raise RuntimeError("Enrollment requires RLS and separate ownership")
    forbidden = await (await conn.execute("""SELECT
        has_schema_privilege(current_user,'app','CREATE') AS create_schema,
        has_table_privilege(current_user,'app.quiz_history','SELECT,INSERT,UPDATE,DELETE,TRUNCATE') AS history,
        has_table_privilege(current_user,'app.users','SELECT,UPDATE,DELETE,TRUNCATE') AS users,
        has_table_privilege(current_user,'app.user_identities','UPDATE,DELETE,TRUNCATE') AS identities,
        has_table_privilege(current_user,'app.identity_challenges','DELETE,TRUNCATE') AS challenges""")).fetchone()
    if any(forbidden.values()):
        raise RuntimeError("Enrollment role has excessive privileges")
    writable = await (await conn.execute("""SELECT column_name FROM information_schema.columns
        WHERE table_schema='app' AND table_name='identity_challenges' AND column_name <> 'used_at'
        AND has_column_privilege(current_user,'app.identity_challenges',column_name,'UPDATE')""")).fetchall()
    if writable:
        raise RuntimeError("Enrollment role has excessive challenge update privileges")


class IdentityRepository:
    def __init__(self, pool, cognito, legacy=None):
        self.pool, self.cognito, self.legacy = pool, cognito, legacy

    @asynccontextmanager
    async def transaction(self):
        try:
            async with self.pool.connection() as conn, conn.transaction():
                for name, value in {
                    "cognito_issuer": self.cognito.issuer, "cognito_subject": self.cognito.subject,
                    "legacy_issuer": self.legacy.issuer if self.legacy else "",
                    "legacy_subject": self.legacy.subject if self.legacy else "", "new_owner": "",
                }.items():
                    await conn.execute("SELECT set_config(%s,%s,true)", ("quizforge." + name, value))
                # Cross-worker serialization for this immutable Cognito identity.
                await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))",
                                   (self.cognito.issuer + "|" + self.cognito.subject,))
                yield conn
        except (Error, PoolTimeout):
            raise HTTPException(503, "Account enrollment is temporarily unavailable.") from None

    async def lookup(self, conn, identity):
        row = await (await conn.execute("SELECT user_id FROM app.user_identities WHERE issuer=%s AND subject=%s",
                                       (identity.issuer, identity.subject))).fetchone()
        return row["user_id"] if row else None

    async def enrolled(self):
        async with self.transaction() as conn:
            return await self.lookup(conn, self.cognito) is not None

    async def challenge(self, mode):
        async with self.transaction() as conn:
            if await self.lookup(conn, self.cognito) is not None:
                raise HTTPException(409, "This Cognito account is already enrolled; links cannot be reassigned.")
            if mode == "link" and (not self.legacy or await self.lookup(conn, self.legacy) is None):
                raise HTTPException(403, "The existing account has not been migrated to this staging database.")
            count = await (await conn.execute("""SELECT count(*) AS n FROM app.identity_challenges
                WHERE created_at > now() - interval '5 minutes'""")).fetchone()
            if count["n"] >= 5:
                raise HTTPException(429, "Too many enrollment attempts. Try again in five minutes.")
            nonce = secrets.token_urlsafe(32)
            await conn.execute("""INSERT INTO app.identity_challenges
                (nonce_hash,issuer,subject,legacy_issuer,legacy_subject,mode)
                VALUES (%s,%s,%s,%s,%s,%s)""", (hashlib.sha256(nonce.encode()).hexdigest(),
                    self.cognito.issuer, self.cognito.subject, self.legacy.issuer if self.legacy else "",
                    self.legacy.subject if self.legacy else "", mode))
            return nonce

    async def confirm(self, nonce, mode):
        async with self.transaction() as conn:
            challenge = await (await conn.execute("""UPDATE app.identity_challenges SET used_at=now()
                WHERE nonce_hash=%s AND mode=%s AND legacy_issuer=%s AND legacy_subject=%s
                AND used_at IS NULL AND created_at > now() - interval '5 minutes'
                RETURNING nonce_hash""", (hashlib.sha256(nonce.encode()).hexdigest(), mode,
                    self.legacy.issuer if self.legacy else "", self.legacy.subject if self.legacy else ""))).fetchone()
            if not challenge:
                raise HTTPException(409, "Confirmation expired or was already used. Start again.")
            if await self.lookup(conn, self.cognito) is not None:
                raise HTTPException(409, "This Cognito account is already enrolled; links cannot be reassigned.")
            owner = await self.lookup(conn, self.legacy) if mode == "link" and self.legacy else uuid4()
            if owner is None:
                raise HTTPException(403, "The existing account is unavailable.")
            await conn.execute("SELECT set_config('quizforge.new_owner',%s,true)", (str(owner),))
            if mode == "enroll":
                await conn.execute("INSERT INTO app.users(id) VALUES (%s)", (owner,))
            await conn.execute("INSERT INTO app.user_identities(issuer,subject,user_id) VALUES (%s,%s,%s)",
                               (self.cognito.issuer, self.cognito.subject, owner))

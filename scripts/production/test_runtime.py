from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import tempfile
import unittest
from uuid import uuid4
from unittest.mock import patch

import psycopg

import generation_guard as guard
from generation_costs import PRICING_KEY, maximum_cost
import inventory
from build import public_config
from cloud_transfer import validate_delivery
from database import options
from transfer import private_read, private_write


class Boundaries(unittest.TestCase):
    def test_build_refuses_secret_keys_and_foreign_endpoints_before_running_npm(self):
        import base64
        config = {"pool":"ca-central-1_Test","client":"client123",
                  "auth_origin":"https://quizforge-123456789012.auth.ca-central-1.amazoncognito.com",
                  "frontend_url":"https://quizfromnotes.com","api_url":"https://api.quizfromnotes.com",
                  "legacy_url":"https://vfxmsvphgcaizqnbyjip.supabase.co",
                  "legacy_publishable_key":"sb_publishable_synthetic_public_key_12345",
                  "sms_mfa_enabled":False}
        self.assertEqual(public_config(config),config)
        privileged = 'header.'+base64.urlsafe_b64encode(json.dumps({'role':'service_role','ref':'vfxmsvphgcaizqnbyjip'}).encode()).decode().rstrip('=')+'.signature'
        for change in ({'legacy_publishable_key':privileged},{'legacy_publishable_key':'sb_secret_private'},
                       {'api_url':'https://foreign.test'},{'sms_mfa_enabled':'true'},{'OPENAI_API_KEY':'private'}):
            with self.assertRaises(ValueError): public_config(config | change)

    def test_model_request_is_bounded_and_cannot_use_tools_or_other_endpoints(self):
        body = {"model": "gpt-5.6-luna", "input": [{"role": "user", "content": "Synthetic notes"}]}
        result = json.loads(guard.bounded_request(json.dumps(body | {"store": True, "max_output_tokens": 999999}).encode()))
        self.assertFalse(result["store"])
        self.assertEqual(result["max_output_tokens"], 8192)
        for change in ({"model": "other"}, {"tools": []}, {"stream": True}, {"input": []},
                       {"input": [{"role": "user", "content": [{"type": "input_image"}]}]},
                       {"max_output_tokens": True}, {"previous_response_id": "old"}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                guard.bounded_request(json.dumps(body | change).encode())
        with self.assertRaises(ValueError): guard.bounded_request(b"x" * (guard.MAX_BODY_BYTES + 1))

    def test_archive_cannot_overwrite_or_follow_symlinks_or_read_world_accessible_data(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "archive"
            private_write(path, b"encrypted-example")
            self.assertEqual(private_read(path, 100), b"encrypted-example")
            with self.assertRaises(FileExistsError): private_write(path, b"overwrite")
            with self.assertRaises(ValueError): private_read(path, 2)
            linked = Path(directory) / "linked"
            linked.symlink_to(path)
            with self.assertRaises(OSError): private_read(linked, 100)
            path.chmod(0o644)
            with self.assertRaises(ValueError): private_read(path, 100)

    def test_database_transport_rejects_wrong_hosts_and_staging_database(self):
        with tempfile.NamedTemporaryFile() as ca:
            env = {"PGHOST": "quizforge-production.abcdef.ca-central-1.rds.amazonaws.com", "PGDATABASE": "quizforge",
                   "PGUSER": "owner", "PGPASSWORD": "synthetic", "PGSSLROOTCERT": ca.name}
            self.assertEqual(options(env)["sslmode"], "verify-full")
            for changes in ({"PGHOST": "foreign.ca-central-1.rds.amazonaws.com"},
                            {"PGDATABASE": "quizforge_rehearsal"}, {"PGPASSWORD": ""}):
                with self.assertRaises(ValueError): options(env | changes)

    def test_delivery_bucket_and_key_secret_must_share_the_production_account(self):
        bucket = "quizforge-production-transfer-123456789012"
        secret = "arn:aws:secretsmanager:ca-central-1:123456789012:secret:quizforge-production-transfer-key-AbCd12"
        validate_delivery(bucket, secret)
        for b, s in ((bucket.replace('production','staging'), secret),
                     (bucket,secret.replace('123456789012','111111111111')),
                     (bucket,secret.replace('transfer-key','application'))):
            with self.assertRaises(ValueError): validate_delivery(b,s)

    def test_empty_budget_response_is_a_valid_empty_inventory(self):
        class Paginator:
            def paginate(self, **kwargs): return [{}]
        class Client:
            def get_caller_identity(self): return {"Account": "123456789012"}
            def get_paginator(self, name): return Paginator()
        with patch.object(inventory.boto3, "client", return_value=Client()):
            self.assertEqual(inventory.budgets(), [])

    def test_public_account_report_omits_balances_ids_and_dates(self):
        class Client:
            def get_account_plan_state(self):
                return {"accountPlanType": "FREE", "accountPlanStatus": "ACTIVE", "accountId": "private",
                        "accountPlanRemainingCredits": {"amount": 123}, "accountPlanExpirationDate": "private"}
        with patch.object(inventory.boto3, "client", return_value=Client()):
            self.assertEqual(inventory.account_plan(), {"accountPlanType": "FREE", "accountPlanStatus": "ACTIVE"})


@unittest.skipUnless(os.environ.get("PRODUCTION_TEST_DB"), "CI provides disposable PostgreSQL")
class PersistentBudget(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dsn = os.environ["PRODUCTION_TEST_DB"]
        with psycopg.connect(cls.dsn, autocommit=True) as owner:
            # Refuse to run fixture DDL outside the exact disposable CI service.
            assert owner.info.host == "127.0.0.1" and owner.info.dbname == "quizforge"
            owner.execute(Path(__file__).with_name("generation_budget.sql").read_text())
            owner.execute("ALTER ROLE quizforge_generation PASSWORD 'synthetic-ci-only'")

    def setUp(self):
        with psycopg.connect(self.dsn, autocommit=True) as owner:
            owner.execute("TRUNCATE billing.generation_usage,billing.generation_reservations")
            owner.execute("UPDATE billing.generation_policy SET enabled=false,daily_requests=0,monthly_requests=0, "
                          "monthly_nano_usd=5000000000,pricing_key=%s,pricing_valid_until=current_date+1", (PRICING_KEY,))

    def reserve(self, _=None):
        with psycopg.connect(self.dsn, autocommit=True) as connection:
            connection.execute("SET ROLE quizforge_generation")
            return connection.execute("SELECT billing.reserve_generation_cost(%s,%s,%s)",
                                      (uuid4(), maximum_cost(8192), PRICING_KEY)).fetchone()[0]

    def test_disabled_missing_policy_and_persistent_concurrent_cap(self):
        self.assertFalse(self.reserve())
        with psycopg.connect(self.dsn, autocommit=True) as owner:
            owner.execute("UPDATE billing.generation_policy SET enabled=true,daily_requests=3,monthly_requests=10")
        with ThreadPoolExecutor(max_workers=16) as workers:
            self.assertEqual(sum(workers.map(self.reserve, range(16))), 3)
        self.assertFalse(self.reserve())  # New connection/process cannot reset quota.
        with psycopg.connect(self.dsn, autocommit=True) as owner:
            self.assertEqual(owner.execute("SELECT requests FROM billing.generation_usage ORDER BY period").fetchall(), [(3,), (3,)])
            owner.execute("DELETE FROM billing.generation_policy")
        self.assertFalse(self.reserve())
        with psycopg.connect(self.dsn, autocommit=True) as owner:
            owner.execute("INSERT INTO billing.generation_policy VALUES (true,false,0,0)")

    def test_monthly_limit_and_new_day_do_not_erase_monthly_usage(self):
        with psycopg.connect(self.dsn, autocommit=True) as owner:
            owner.execute("UPDATE billing.generation_policy SET enabled=true,daily_requests=2,monthly_requests=3")
        self.assertTrue(self.reserve()); self.assertTrue(self.reserve()); self.assertFalse(self.reserve())
        with psycopg.connect(self.dsn, autocommit=True) as owner:
            owner.execute("UPDATE billing.generation_usage SET starts_on=starts_on-1 WHERE period='day'")
        self.assertTrue(self.reserve()); self.assertFalse(self.reserve())

    def enable_cost_policy(self):
        with psycopg.connect(self.dsn, autocommit=True) as owner:
            owner.execute("UPDATE billing.generation_policy SET enabled=true,daily_requests=1000,monthly_requests=10000")

    def reserve_cost(self, cost, attempt=None, key=PRICING_KEY):
        with psycopg.connect(self.dsn, autocommit=True) as conn:
            conn.execute("SET ROLE quizforge_generation")
            return conn.execute("SELECT billing.reserve_generation_cost(%s,%s,%s)",
                                (attempt or uuid4(),cost,key)).fetchone()[0]

    def settle_cost(self, attempt, cost):
        with psycopg.connect(self.dsn, autocommit=True) as conn:
            conn.execute("SET ROLE quizforge_generation")
            return conn.execute("SELECT billing.settle_generation_cost(%s,%s)", (attempt,cost)).fetchone()[0]

    def test_dollar_boundary_blocks_before_exceeding_five_and_allows_exact_fit(self):
        self.enable_cost_policy()
        for _ in range(4): self.assertTrue(self.reserve_cost(1000000000))
        self.assertTrue(self.reserve_cost(990000000))
        self.assertFalse(self.reserve_cost(20000000))  # $4.99 + $0.02.
        self.assertTrue(self.reserve_cost(10000000))
        self.assertFalse(self.reserve_cost(1))
        with psycopg.connect(self.dsn) as owner:
            self.assertEqual(owner.execute("SELECT accounted_nano_usd FROM billing.generation_usage WHERE period='month'").fetchone()[0], 5000000000)

    def test_concurrent_dollars_cannot_overspend_and_new_process_keeps_balance(self):
        self.enable_cost_policy()
        with ThreadPoolExecutor(max_workers=16) as workers:
            self.assertEqual(sum(workers.map(lambda _: self.reserve_cost(500000000),range(24))),10)
        self.assertFalse(self.reserve_cost(1))
        # A fresh interpreter/connection sees persisted usage, not a process counter.
        import subprocess, sys
        code = "import sys,psycopg; from uuid import uuid4; c=psycopg.connect(sys.argv[1]); c.execute('SET ROLE quizforge_generation'); assert c.execute('SELECT billing.reserve_generation_cost(%s,%s,%s)', (uuid4(),1,sys.argv[2])).fetchone()[0] is False"
        subprocess.run([sys.executable,'-c',code,self.dsn,PRICING_KEY],check=True)

    def test_settlement_is_once_only_and_refunds_the_original_month(self):
        self.enable_cost_policy()
        attempt=uuid4()
        self.assertTrue(self.reserve_cost(1000000000,attempt))
        self.assertFalse(self.reserve_cost(1000000000,attempt))
        self.assertFalse(self.settle_cost(attempt,1000000001))
        # Move this outstanding reservation and its usage to the previous month.
        with psycopg.connect(self.dsn,autocommit=True) as owner:
            owner.execute("UPDATE billing.generation_usage SET starts_on=starts_on-interval '1 month'")
            owner.execute("UPDATE billing.generation_reservations SET day_start=day_start-interval '1 month',month_start=month_start-interval '1 month'")
        self.assertTrue(self.reserve_cost(1000000000))  # Fresh month has its own allowance.
        self.assertTrue(self.settle_cost(attempt,10000000))
        self.assertFalse(self.settle_cost(attempt,0))
        with psycopg.connect(self.dsn) as owner:
            self.assertEqual(owner.execute("SELECT accounted_nano_usd FROM billing.generation_usage WHERE period='month' ORDER BY starts_on").fetchall(),[(10000000,),(1000000000,)])

    def test_no_response_retains_reservation_and_retries_consume_more(self):
        self.enable_cost_policy()
        self.assertTrue(self.reserve_cost(1000000000))
        # Deliberately never settle: simulates timeout, unknown usage or crash.
        self.assertTrue(self.reserve_cost(1000000000))
        with psycopg.connect(self.dsn) as owner:
            self.assertEqual(owner.execute("SELECT accounted_nano_usd FROM billing.generation_usage WHERE period='month'").fetchone()[0],2000000000)

    def test_real_gateway_database_adapter_commits_and_concurrent_refund_happens_once(self):
        from psycopg.conninfo import conninfo_to_dict
        self.enable_cost_policy()
        settings=conninfo_to_dict(self.dsn) | {"options":"-c role=quizforge_generation"}
        attempt=uuid4()
        self.assertTrue(guard.reserve(settings,attempt,maximum_cost(8192)))
        with psycopg.connect(self.dsn) as owner:
            self.assertEqual(owner.execute("SELECT accounted_nano_usd FROM billing.generation_usage WHERE period='month'").fetchone()[0],539745600)
        with ThreadPoolExecutor(max_workers=8) as workers:
            results=list(workers.map(lambda _: guard.settle(settings,attempt,490000),range(16)))
        self.assertEqual(sum(results),1)
        with psycopg.connect(self.dsn) as owner:
            self.assertEqual(owner.execute("SELECT accounted_nano_usd FROM billing.generation_usage WHERE period='month'").fetchone()[0],490000)

    def test_stale_missing_or_wrong_prices_and_invalid_money_fail_closed(self):
        self.enable_cost_policy()
        for cost in (None,0,-1,1000000001): self.assertFalse(self.reserve_cost(cost))
        self.assertFalse(self.reserve_cost(1,key='unreviewed'))
        with psycopg.connect(self.dsn,autocommit=True) as owner:
            owner.execute("UPDATE billing.generation_policy SET pricing_valid_until=current_date")
        self.assertFalse(self.reserve_cost(1))
        with psycopg.connect(self.dsn,autocommit=True) as owner:
            owner.execute("DELETE FROM billing.generation_policy")
        self.assertFalse(self.reserve_cost(1))
        with psycopg.connect(self.dsn,autocommit=True) as owner:
            owner.execute("INSERT INTO billing.generation_policy VALUES(true,false,0,0)")

    def test_runtime_role_cannot_reset_quota_or_enable_spend(self):
        with psycopg.connect(self.dsn, autocommit=True) as connection:
            connection.execute("SET ROLE quizforge_generation")
            for statement in ("UPDATE billing.generation_policy SET enabled=true",
                              "DELETE FROM billing.generation_usage", "TRUNCATE billing.generation_usage",
                              "DELETE FROM billing.generation_reservations"):
                with self.assertRaises(psycopg.errors.InsufficientPrivilege): connection.execute(statement)
            connection.execute("RESET ROLE")
            allowed = connection.execute("SELECT has_function_privilege('quizforge_generation', 'billing.reserve_generation()', 'EXECUTE')").fetchone()[0]
            self.assertTrue(allowed)
            self.assertFalse(connection.execute("SELECT billing.reserve_generation()").fetchone()[0])
            for function in ("billing.reserve_generation_cost(uuid,bigint,text)", "billing.settle_generation_cost(uuid,bigint)"):
                self.assertTrue(connection.execute("SELECT has_function_privilege('quizforge_generation',%s,'EXECUTE')",(function,)).fetchone()[0])
                self.assertFalse(connection.execute("SELECT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=%s::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE')",(function,)).fetchone()[0])
            self.assertTrue(connection.execute("""SELECT NOT EXISTS (
                SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
                WHERE p.oid='billing.reserve_generation()'::regprocedure AND a.grantee=0
                AND a.privilege_type='EXECUTE')""").fetchone()[0])


@unittest.skipUnless(os.environ.get("PRODUCTION_TEST_DB"), "CI provides disposable PostgreSQL")
class ProductionSchema(unittest.TestCase):
    def test_bootstrap_schema_import_reconciliation_and_role_separation(self):
        from psycopg.rows import dict_row
        from history_transfer import APPLICATION, SUPABASE, import_snapshot, export_snapshot, insert_rows, seal, unseal, validate
        from probe import fixtures
        from uuid import UUID
        import secrets
        from database import SOURCE_ISSUER
        with psycopg.connect(os.environ["PRODUCTION_TEST_DB"], autocommit=True, row_factory=dict_row) as owner:
            assert owner.info.host == "127.0.0.1" and owner.info.dbname == "quizforge"
            owner.execute(Path(__file__).with_name("schema.sql").read_text())
            owner.execute("CREATE SCHEMA auth")
            owner.execute("CREATE TABLE auth.users (id uuid PRIMARY KEY)")
            owner.execute("CREATE TABLE public.quiz_history (LIKE app.quiz_history INCLUDING ALL)")
            for i in (1,2,3): owner.execute("INSERT INTO auth.users VALUES (%s)",(UUID(int=i),))
            insert_rows(owner,SUPABASE.history,[json.dumps(row,default=str) for row in fixtures()])
            # Use the real PostgreSQL exporter, preserving its canonical numeric
            # and timestamp text rather than manufacturing a Python snapshot.
            snapshot = export_snapshot(owner,SUPABASE,SOURCE_ISSUER)
            key = secrets.token_bytes(32)
            decoded = unseal(seal(snapshot,key),key)
            report = import_snapshot(owner, decoded)
            self.assertTrue(report['dry_run'])
            self.assertEqual(owner.execute("SELECT count(*) AS n FROM app.users").fetchone()['n'],0)
            result = import_snapshot(owner, decoded,dry_run=False)
            self.assertEqual(result['manifest'],validate(export_snapshot(owner,APPLICATION,SOURCE_ISSUER)))
            self.assertEqual(result['manifest']['users'],3)
            self.assertEqual(result['manifest']['rows'],8)
            for role in ('quizforge_identity','quizforge_generation'):
                self.assertFalse(owner.execute("SELECT has_table_privilege(%s,'app.quiz_history','SELECT') AS allowed",(role,)).fetchone()['allowed'])
            self.assertFalse(owner.execute("SELECT has_table_privilege('quizforge_app','app.user_identities','INSERT') AS allowed").fetchone()['allowed'])


if __name__ == "__main__": unittest.main()

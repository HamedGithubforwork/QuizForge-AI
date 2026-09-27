import os
from pathlib import Path
import unittest
from uuid import UUID

import psycopg
from psycopg.rows import dict_row

from lightsail_backup import schema_state


HERE = Path(__file__).resolve().parent
MIGRATION = HERE / "migrations" / "20260927_001_decks_cards.sql"


class DeckMigration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.upgraded_dsn = os.environ[
            "DECK_MIGRATION_TEST_UPGRADED"
        ]
        cls.fresh_dsn = os.environ[
            "DECK_MIGRATION_TEST_FRESH"
        ]
        cls.upgraded = psycopg.connect(
            cls.upgraded_dsn,
            autocommit=True,
            row_factory=dict_row,
        )
        cls.fresh = psycopg.connect(
            cls.fresh_dsn,
            autocommit=True,
            row_factory=dict_row,
        )

        expected_ports = {55433, 55434}
        for connection in (cls.upgraded, cls.fresh):
            if (
                connection.info.host != "127.0.0.1"
                or connection.info.dbname != "quizforge"
                or connection.info.port not in expected_ports
                or connection.info.server_version // 10000 != 17
            ):
                raise RuntimeError(
                    "Deck migration tests require the exact disposable PostgreSQL 17 services."
                )

        baseline = Path(
            os.environ["DECK_MIGRATION_BASELINE_SCHEMA"]
        )
        if not baseline.is_file():
            raise RuntimeError(
                "Pinned production baseline schema is missing."
            )

        # Recreate the actual pre-deck production application schema,
        # then use the current billing schema so the structural comparison
        # isolates this application-schema migration.
        cls.upgraded.execute(baseline.read_text())
        cls.upgraded.execute(
            (HERE / "generation_budget.sql").read_text()
        )

        cls.existing_user = UUID(
            "00000000-0000-0000-0000-000000000001"
        )
        cls.other_user = UUID(
            "00000000-0000-0000-0000-000000000002"
        )
        cls.upgraded.execute(
            "INSERT INTO app.users(id) VALUES (%s), (%s)",
            (cls.existing_user, cls.other_user),
        )
        cls.upgraded.execute(
            """INSERT INTO app.quiz_history(
                id,user_id,quiz_title,source_filename,difficulty,
                question_type,question_count,score,percentage,
                quiz_data,selected_answers
            ) VALUES (
                '10000000-0000-0000-0000-000000000001',
                %s,'Existing quiz','existing.pdf','medium',
                'multiple_choice',1,1,100,'{}','{}'
            )""",
            (cls.existing_user,),
        )

        cls.upgraded.execute(MIGRATION.read_text())

        cls.fresh.execute((HERE / "schema.sql").read_text())
        cls.fresh.execute(
            (HERE / "generation_budget.sql").read_text()
        )

    @classmethod
    def tearDownClass(cls):
        cls.upgraded.close()
        cls.fresh.close()

    def test_upgrade_matches_fresh_schema_and_security(self):
        # schema_state intentionally consumes the default tuple row shape
        # used by the production backup verifier.
        with (
            psycopg.connect(
                self.upgraded_dsn,
                autocommit=True,
            ) as upgraded_schema,
            psycopg.connect(
                self.fresh_dsn,
                autocommit=True,
            ) as fresh_schema,
        ):
            self.assertEqual(
                schema_state(upgraded_schema),
                schema_state(fresh_schema),
            )

    def test_existing_users_and_history_are_preserved(self):
        row = self.upgraded.execute(
            """SELECT user_id,quiz_title,source_filename
               FROM app.quiz_history
               WHERE id='10000000-0000-0000-0000-000000000001'"""
        ).fetchone()

        self.assertEqual(row["user_id"], self.existing_user)
        self.assertEqual(row["quiz_title"], "Existing quiz")
        self.assertEqual(row["source_filename"], "existing.pdf")

    def test_migrated_rls_isolates_decks_and_cards(self):
        self.upgraded.execute("SET ROLE quizforge_app")
        try:
            self.upgraded.execute(
                "SELECT set_config('quizforge.user_id', %s, false)",
                (str(self.existing_user),),
            )
            deck_id = self.upgraded.execute(
                """INSERT INTO app.decks(user_id,name)
                   VALUES (%s,'Migration test deck')
                   RETURNING id""",
                (self.existing_user,),
            ).fetchone()["id"]

            self.upgraded.execute(
                """INSERT INTO app.cards(
                    deck_id,user_id,question_type,question,answer
                ) VALUES (
                    %s,%s,'short_answer','What is ATP?','"Energy currency"'
                )""",
                (deck_id, self.existing_user),
            )

            self.upgraded.execute(
                "SELECT set_config('quizforge.user_id', %s, false)",
                (str(self.other_user),),
            )
            self.assertEqual(
                self.upgraded.execute(
                    "SELECT count(*) AS count FROM app.decks"
                ).fetchone()["count"],
                0,
            )
            self.assertEqual(
                self.upgraded.execute(
                    "SELECT count(*) AS count FROM app.cards"
                ).fetchone()["count"],
                0,
            )
        finally:
            self.upgraded.execute("RESET ROLE")

    def test_second_application_fails_closed(self):
        with self.assertRaises(psycopg.errors.RaiseException):
            self.upgraded.execute(MIGRATION.read_text())
        self.upgraded.execute("ROLLBACK")

        self.assertEqual(
            self.upgraded.execute(
                "SELECT count(*) AS count FROM app.decks"
            ).fetchone()["count"],
            1,
        )


if __name__ == "__main__":
    unittest.main()

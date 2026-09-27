import os
from pathlib import Path
import unittest
from uuid import uuid4

import psycopg
from psycopg.rows import dict_row


class DeckSchema(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dsn = os.environ["PRODUCTION_TEST_DB"]

        with psycopg.connect(
            cls.dsn,
            autocommit=True,
            row_factory=dict_row,
        ) as owner:
            if (
                owner.info.host != "127.0.0.1"
                or owner.info.dbname != "quizforge"
            ):
                raise RuntimeError(
                    "Deck schema tests require the disposable CI database."
                )

            owner.execute(
                Path(__file__)
                .with_name("schema.sql")
                .read_text()
            )

    def setUp(self):
        with psycopg.connect(
            self.dsn,
            autocommit=True,
        ) as owner:
            owner.execute(
                "TRUNCATE app.cards, app.decks, "
                "app.user_identities, app.users CASCADE"
            )

    def test_deck_tables_use_rls_and_identity_role_has_no_access(self):
        with psycopg.connect(
            self.dsn,
            autocommit=True,
            row_factory=dict_row,
        ) as owner:
            for table in ("app.decks", "app.cards"):
                self.assertTrue(
                    owner.execute(
                        "SELECT relrowsecurity "
                        "FROM pg_class "
                        "WHERE oid=%s::regclass",
                        (table,),
                    ).fetchone()["relrowsecurity"]
                )
                self.assertTrue(
                    owner.execute(
                        "SELECT has_table_privilege("
                        "'quizforge_app', %s, 'SELECT') "
                        "AS allowed",
                        (table,),
                    ).fetchone()["allowed"]
                )
                self.assertFalse(
                    owner.execute(
                        "SELECT has_table_privilege("
                        "'quizforge_identity', %s, 'SELECT') "
                        "AS allowed",
                        (table,),
                    ).fetchone()["allowed"]
                )

            self.assertFalse(
                owner.execute(
                    "SELECT has_column_privilege("
                    "'quizforge_app', 'app.decks', "
                    "'user_id', 'UPDATE') AS allowed"
                ).fetchone()["allowed"]
            )
            self.assertTrue(
                owner.execute(
                    "SELECT has_column_privilege("
                    "'quizforge_app', 'app.decks', "
                    "'name', 'UPDATE') AS allowed"
                ).fetchone()["allowed"]
            )

    def test_rls_isolates_decks_and_cards_between_users(self):
        first_user = uuid4()
        second_user = uuid4()

        with psycopg.connect(
            self.dsn,
            autocommit=True,
            row_factory=dict_row,
        ) as connection:
            connection.execute(
                "INSERT INTO app.users (id) VALUES (%s), (%s)",
                (first_user, second_user),
            )
            connection.execute("SET ROLE quizforge_app")
            connection.execute(
                "SELECT set_config("
                "'quizforge.user_id', %s, false)",
                (str(first_user),),
            )

            deck_id = connection.execute(
                "INSERT INTO app.decks "
                "(user_id, name, description) "
                "VALUES (%s, 'Biology Midterm', 'Cell biology') "
                "RETURNING id",
                (first_user,),
            ).fetchone()["id"]

            connection.execute(
                "INSERT INTO app.cards "
                "(deck_id, user_id, question_type, question, "
                "answer, choices, source_filename, source_pages) "
                "VALUES (%s, %s, 'multiple_choice', %s, "
                "%s::jsonb, %s::jsonb, %s, %s)",
                (
                    deck_id,
                    first_user,
                    "What organelle produces ATP?",
                    '"Mitochondria"',
                    '["Nucleus","Mitochondria","Ribosome"]',
                    "biology.pdf",
                    [12, 14],
                ),
            )

            self.assertEqual(
                connection.execute(
                    "SELECT count(*) AS count FROM app.decks"
                ).fetchone()["count"],
                1,
            )
            self.assertEqual(
                connection.execute(
                    "SELECT count(*) AS count FROM app.cards"
                ).fetchone()["count"],
                1,
            )

            connection.execute(
                "SELECT set_config("
                "'quizforge.user_id', %s, false)",
                (str(second_user),),
            )

            self.assertEqual(
                connection.execute(
                    "SELECT count(*) AS count FROM app.decks"
                ).fetchone()["count"],
                0,
            )
            self.assertEqual(
                connection.execute(
                    "SELECT count(*) AS count FROM app.cards"
                ).fetchone()["count"],
                0,
            )

            with self.assertRaises(
                psycopg.errors.InsufficientPrivilege
            ):
                connection.execute(
                    "INSERT INTO app.decks (user_id, name) "
                    "VALUES (%s, 'Not Mine')",
                    (first_user,),
                )

    def test_card_owner_must_match_deck_owner(self):
        first_user = uuid4()
        second_user = uuid4()

        with psycopg.connect(
            self.dsn,
            autocommit=True,
            row_factory=dict_row,
        ) as connection:
            connection.execute(
                "INSERT INTO app.users (id) VALUES (%s), (%s)",
                (first_user, second_user),
            )
            connection.execute("SET ROLE quizforge_app")
            connection.execute(
                "SELECT set_config("
                "'quizforge.user_id', %s, false)",
                (str(first_user),),
            )
            deck_id = connection.execute(
                "INSERT INTO app.decks (user_id, name) "
                "VALUES (%s, 'Owned Deck') RETURNING id",
                (first_user,),
            ).fetchone()["id"]

            connection.execute(
                "SELECT set_config("
                "'quizforge.user_id', %s, false)",
                (str(second_user),),
            )

            with self.assertRaises(
                psycopg.errors.ForeignKeyViolation
            ):
                connection.execute(
                    "INSERT INTO app.cards "
                    "(deck_id, user_id, question_type, question, answer) "
                    "VALUES (%s, %s, 'short_answer', 'Question', "
                    "%s::jsonb)",
                    (deck_id, second_user, '"Answer"'),
                )


if __name__ == "__main__":
    unittest.main()

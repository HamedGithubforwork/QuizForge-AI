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
                "TRUNCATE app.study_notification_deliveries, "
                "app.study_push_subscriptions, "
                "app.study_notification_preferences, "
                "app.card_review_logs, app.cards, app.decks, "
                "app.user_identities, app.users CASCADE"
            )

    def test_deck_tables_use_rls_and_identity_role_has_no_access(self):
        with psycopg.connect(
            self.dsn,
            autocommit=True,
            row_factory=dict_row,
        ) as owner:
            for table in (
                "app.decks",
                "app.cards",
                "app.card_review_logs",
                "app.study_notification_preferences",
                "app.study_push_subscriptions",
            ):
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

            self.assertTrue(
                owner.execute(
                    "SELECT has_column_privilege("
                    "'quizforge_app', 'app.cards', "
                    "'due_at', 'UPDATE') AS allowed"
                ).fetchone()["allowed"]
            )
            self.assertFalse(
                owner.execute(
                    "SELECT has_column_privilege("
                    "'quizforge_app', 'app.cards', "
                    "'user_id', 'UPDATE') AS allowed"
                ).fetchone()["allowed"]
            )

            self.assertFalse(
                owner.execute(
                    "SELECT has_column_privilege("
                    "'quizforge_app', 'app.cards', "
                    "'deck_id', 'UPDATE') AS allowed"
                ).fetchone()["allowed"]
            )
            self.assertTrue(
                owner.execute(
                    "SELECT has_function_privilege("
                    "'quizforge_app', "
                    "'app.move_card(uuid,uuid,uuid)', "
                    "'EXECUTE') AS allowed"
                ).fetchone()["allowed"]
            )
            self.assertTrue(
                owner.execute(
                    """SELECT NOT EXISTS (
                         SELECT 1
                         FROM pg_proc p,
                              aclexplode(
                                  coalesce(
                                      p.proacl,
                                      acldefault('f',p.proowner)
                                  )
                              ) a
                         WHERE p.oid='app.move_card(uuid,uuid,uuid)'::regprocedure
                           AND a.grantee=0
                           AND a.privilege_type='EXECUTE'
                       ) AS public_execute_revoked"""
                ).fetchone()["public_execute_revoked"]
            )
            self.assertFalse(
                owner.execute(
                    "SELECT has_table_privilege("
                    "'quizforge_app', 'app.card_review_logs', "
                    "'UPDATE,DELETE,TRUNCATE') AS allowed"
                ).fetchone()["allowed"]
            )

            self.assertTrue(
                owner.execute(
                    "SELECT has_column_privilege("
                    "'quizforge_app', "
                    "'app.study_notification_preferences', "
                    "'reminder_time', 'UPDATE') AS allowed"
                ).fetchone()["allowed"]
            )
            self.assertFalse(
                owner.execute(
                    "SELECT has_column_privilege("
                    "'quizforge_app', "
                    "'app.study_notification_preferences', "
                    "'user_id', 'UPDATE') AS allowed"
                ).fetchone()["allowed"]
            )
            self.assertFalse(
                owner.execute(
                    "SELECT has_table_privilege("
                    "'quizforge_identity', "
                    "'app.study_notification_preferences', "
                    "'SELECT,INSERT,UPDATE,DELETE') AS allowed"
                ).fetchone()["allowed"]
            )

            self.assertTrue(
                owner.execute(
                    "SELECT relrowsecurity "
                    "FROM pg_class "
                    "WHERE oid='app.study_notification_deliveries'::regclass"
                ).fetchone()["relrowsecurity"]
            )
            self.assertFalse(
                owner.execute(
                    "SELECT has_table_privilege("
                    "'quizforge_app', "
                    "'app.study_notification_deliveries', "
                    "'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') AS allowed"
                ).fetchone()["allowed"]
            )
            self.assertFalse(
                owner.execute(
                    "SELECT has_column_privilege("
                    "'quizforge_app', "
                    "'app.study_push_subscriptions', "
                    "'user_id', 'UPDATE') AS allowed"
                ).fetchone()["allowed"]
            )
            self.assertTrue(
                owner.execute(
                    "SELECT has_column_privilege("
                    "'quizforge_app', "
                    "'app.study_push_subscriptions', "
                    "'endpoint', 'UPDATE') AS allowed"
                ).fetchone()["allowed"]
            )

            self.assertFalse(
                owner.execute(
                    "SELECT has_table_privilege("
                    "'quizforge_notifier', 'app.quiz_history', "
                    "'SELECT,INSERT,UPDATE,DELETE') AS allowed"
                ).fetchone()["allowed"]
            )
            self.assertTrue(
                owner.execute(
                    "SELECT has_column_privilege("
                    "'quizforge_notifier', 'app.cards', "
                    "'due_at', 'SELECT') AS allowed"
                ).fetchone()["allowed"]
            )
            self.assertTrue(
                owner.execute(
                    "SELECT has_column_privilege("
                    "'quizforge_notifier', 'app.cards', "
                    "'user_id', 'SELECT') AS allowed"
                ).fetchone()["allowed"]
            )
            self.assertFalse(
                owner.execute(
                    "SELECT has_column_privilege("
                    "'quizforge_notifier', 'app.cards', "
                    "'question', 'SELECT') AS allowed"
                ).fetchone()["allowed"]
            )
            self.assertFalse(
                owner.execute(
                    "SELECT has_column_privilege("
                    "'quizforge_notifier', 'app.cards', "
                    "'answer', 'SELECT') AS allowed"
                ).fetchone()["allowed"]
            )
            self.assertTrue(
                owner.execute(
                    "SELECT has_table_privilege("
                    "'quizforge_notifier', "
                    "'app.study_notification_deliveries', "
                    "'SELECT,INSERT') AS allowed"
                ).fetchone()["allowed"]
            )
            self.assertFalse(
                owner.execute(
                    "SELECT has_table_privilege("
                    "'quizforge_notifier', "
                    "'app.study_notification_deliveries', "
                    "'UPDATE,DELETE,TRUNCATE') AS allowed"
                ).fetchone()["allowed"]
            )
            self.assertTrue(
                owner.execute(
                    "SELECT has_table_privilege("
                    "'quizforge_notifier', "
                    "'app.study_push_subscriptions', "
                    "'DELETE') AS allowed"
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
            connection.execute(
                "INSERT INTO app.study_notification_preferences "
                "(user_id,enabled,reminder_time,timezone,minimum_due_cards) "
                "VALUES (%s,true,'20:30','America/Toronto',3)",
                (first_user,),
            )
            connection.execute(
                "INSERT INTO app.study_push_subscriptions "
                "(endpoint_hash,user_id,endpoint,p256dh,auth,user_agent) "
                "VALUES (%s,%s,%s,%s,%s,%s)",
                (
                    "a" * 64,
                    first_user,
                    "https://push.example/subscription-1",
                    "p" * 32,
                    "auth-token",
                    "Synthetic browser",
                ),
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

            card = connection.execute(
                "SELECT id,due_at,fsrs_state,fsrs_step,"
                "review_count,lapse_count "
                "FROM app.cards "
                "WHERE deck_id=%s",
                (deck_id,),
            ).fetchone()
            self.assertEqual(card["fsrs_state"], 1)
            self.assertEqual(card["fsrs_step"], 0)
            self.assertEqual(card["review_count"], 0)
            self.assertEqual(card["lapse_count"], 0)
            self.assertIsNotNone(card["due_at"])

            connection.execute(
                "INSERT INTO app.card_review_logs "
                "(card_id,user_id,rating,review_duration_ms) "
                "VALUES (%s,%s,3,1200)",
                (card["id"], first_user),
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

            self.assertEqual(
                connection.execute(
                    "SELECT count(*) AS count "
                    "FROM app.card_review_logs"
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

            self.assertEqual(
                connection.execute(
                    "SELECT count(*) AS count "
                    "FROM app.card_review_logs"
                ).fetchone()["count"],
                0,
            )

            self.assertEqual(
                connection.execute(
                    "SELECT count(*) AS count "
                    "FROM app.study_notification_preferences"
                ).fetchone()["count"],
                0,
            )
            self.assertEqual(
                connection.execute(
                    "SELECT count(*) AS count "
                    "FROM app.study_push_subscriptions"
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

    def test_move_card_preserves_fsrs_and_review_history_with_owner_boundary(self):
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
            source_deck = connection.execute(
                "INSERT INTO app.decks(user_id,name) "
                "VALUES (%s,'Source') RETURNING id",
                (first_user,),
            ).fetchone()["id"]
            target_deck = connection.execute(
                "INSERT INTO app.decks(user_id,name) "
                "VALUES (%s,'Target') RETURNING id",
                (first_user,),
            ).fetchone()["id"]
            foreign_deck = connection.execute(
                "INSERT INTO app.decks(user_id,name) "
                "VALUES (%s,'Foreign') RETURNING id",
                (second_user,),
            ).fetchone()["id"]
            card_id = connection.execute(
                """INSERT INTO app.cards(
                       deck_id,user_id,question_type,question,answer,
                       fsrs_state,fsrs_step,stability,difficulty,
                       due_at,last_reviewed_at,review_count,lapse_count
                   ) VALUES (
                       %s,%s,'short_answer','Moved question',
                       %s::jsonb,2,NULL,6.5,4.7,
                       now()+interval '3 days',now()-interval '2 days',4,1
                   ) RETURNING id""",
                (
                    source_deck,
                    first_user,
                    '{"correct_answer":"Moved answer"}',
                ),
            ).fetchone()["id"]
            connection.execute(
                """INSERT INTO app.card_review_logs(
                       card_id,user_id,rating,review_duration_ms
                   ) VALUES (%s,%s,3,900)""",
                (card_id, first_user),
            )

            connection.execute("SET ROLE quizforge_app")
            connection.execute(
                "SELECT set_config("
                "'quizforge.user_id', %s, false)",
                (str(first_user),),
            )

            self.assertTrue(
                connection.execute(
                    "SELECT app.move_card(%s,%s,%s) AS moved",
                    (card_id, source_deck, target_deck),
                ).fetchone()["moved"]
            )

            moved = connection.execute(
                """SELECT deck_id,fsrs_state,fsrs_step,stability,difficulty,
                          last_reviewed_at,review_count,lapse_count
                   FROM app.cards
                   WHERE id=%s""",
                (card_id,),
            ).fetchone()
            self.assertEqual(
                moved["deck_id"],
                target_deck,
            )
            self.assertEqual(
                moved["fsrs_state"],
                2,
            )
            self.assertIsNone(
                moved["fsrs_step"]
            )
            self.assertEqual(
                moved["stability"],
                6.5,
            )
            self.assertEqual(
                moved["difficulty"],
                4.7,
            )
            self.assertIsNotNone(
                moved["last_reviewed_at"]
            )
            self.assertEqual(
                moved["review_count"],
                4,
            )
            self.assertEqual(
                moved["lapse_count"],
                1,
            )
            self.assertEqual(
                connection.execute(
                    "SELECT count(*) AS count "
                    "FROM app.card_review_logs "
                    "WHERE card_id=%s",
                    (card_id,),
                ).fetchone()["count"],
                1,
            )

            self.assertFalse(
                connection.execute(
                    "SELECT app.move_card(%s,%s,%s) AS moved",
                    (card_id, source_deck, target_deck),
                ).fetchone()["moved"]
            )
            self.assertFalse(
                connection.execute(
                    "SELECT app.move_card(%s,%s,%s) AS moved",
                    (card_id, target_deck, foreign_deck),
                ).fetchone()["moved"]
            )
            self.assertEqual(
                connection.execute(
                    "SELECT deck_id FROM app.cards WHERE id=%s",
                    (card_id,),
                ).fetchone()["deck_id"],
                target_deck,
            )

            connection.execute(
                "SELECT set_config("
                "'quizforge.user_id', %s, false)",
                (str(second_user),),
            )
            self.assertFalse(
                connection.execute(
                    "SELECT app.move_card(%s,%s,%s) AS moved",
                    (card_id, target_deck, foreign_deck),
                ).fetchone()["moved"]
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

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$
BEGIN
    IF to_regclass('app.cards') IS NULL
       OR to_regclass('app.card_review_logs') IS NULL THEN
        RAISE EXCEPTION 'Expected the reviewed FSRS study schema';
    END IF;

    IF to_regclass('app.study_notification_preferences') IS NOT NULL THEN
        RAISE EXCEPTION 'Study notification preferences are already present';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_class
        WHERE oid='app.cards'::regclass
          AND relrowsecurity
    ) THEN
        RAISE EXCEPTION 'Expected cards row-level security';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_roles
        WHERE rolname='quizforge_app'
          AND NOT rolsuper
          AND NOT rolbypassrls
    ) THEN
        RAISE EXCEPTION 'Expected the restricted quizforge_app role';
    END IF;
END
$$;

CREATE TABLE app.study_notification_preferences (
    user_id uuid PRIMARY KEY REFERENCES app.users(id) ON DELETE CASCADE,
    enabled boolean NOT NULL DEFAULT false,
    reminder_time time without time zone NOT NULL DEFAULT '19:00',
    timezone text NOT NULL DEFAULT 'America/Toronto'
        CHECK (
            char_length(timezone) BETWEEN 1 AND 100
            AND timezone ~ '^[A-Za-z0-9_+./-]+$'
        ),
    minimum_due_cards integer NOT NULL DEFAULT 1
        CHECK (minimum_due_cards BETWEEN 1 AND 1000),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT
    ON app.study_notification_preferences
    TO quizforge_app;

GRANT UPDATE (
    enabled,
    reminder_time,
    timezone,
    minimum_due_cards,
    updated_at
) ON app.study_notification_preferences
    TO quizforge_app;

ALTER TABLE app.study_notification_preferences
    ENABLE ROW LEVEL SECURITY;

CREATE POLICY notification_preferences_read
ON app.study_notification_preferences
FOR SELECT TO quizforge_app
USING (
    user_id =
    nullif(
        current_setting(
            'quizforge.user_id',
            true
        ),
        ''
    )::uuid
);

CREATE POLICY notification_preferences_insert
ON app.study_notification_preferences
FOR INSERT TO quizforge_app
WITH CHECK (
    user_id =
    nullif(
        current_setting(
            'quizforge.user_id',
            true
        ),
        ''
    )::uuid
);

CREATE POLICY notification_preferences_update
ON app.study_notification_preferences
FOR UPDATE TO quizforge_app
USING (
    user_id =
    nullif(
        current_setting(
            'quizforge.user_id',
            true
        ),
        ''
    )::uuid
)
WITH CHECK (
    user_id =
    nullif(
        current_setting(
            'quizforge.user_id',
            true
        ),
        ''
    )::uuid
);

COMMIT;

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$
BEGIN
    IF to_regclass('app.cards') IS NULL
       OR to_regclass('app.card_review_logs') IS NULL THEN
        RAISE EXCEPTION 'Expected the reviewed spaced-repetition card schema';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema='app'
          AND table_name='cards'
          AND column_name IN (
              'suspended',
              'progress_reset_at'
          )
    ) THEN
        RAISE EXCEPTION 'Card study-state columns are already present';
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

    IF NOT EXISTS (
        SELECT 1
        FROM pg_roles
        WHERE rolname='quizforge_notifier'
          AND NOT rolsuper
          AND NOT rolbypassrls
    ) THEN
        RAISE EXCEPTION 'Expected the restricted quizforge_notifier role';
    END IF;
END
$$;

ALTER TABLE app.cards
    ADD COLUMN suspended boolean NOT NULL DEFAULT false,
    ADD COLUMN progress_reset_at timestamptz;

CREATE INDEX cards_user_active_due_at_id_idx
    ON app.cards (user_id, due_at, id)
    WHERE suspended = false;

GRANT SELECT (
    suspended
) ON app.cards TO quizforge_notifier;

GRANT UPDATE (
    suspended,
    progress_reset_at
) ON app.cards TO quizforge_app;

COMMIT;

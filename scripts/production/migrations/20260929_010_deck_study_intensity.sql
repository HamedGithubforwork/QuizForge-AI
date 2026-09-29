BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$
BEGIN
    IF to_regclass('app.decks') IS NULL THEN
        RAISE EXCEPTION 'Expected the reviewed deck schema';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema='app'
          AND table_name='decks'
          AND column_name='study_intensity'
    ) THEN
        RAISE EXCEPTION 'Deck study intensity is already present';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_class
        WHERE oid='app.decks'::regclass
          AND relrowsecurity
    ) THEN
        RAISE EXCEPTION 'Expected deck row-level security';
    END IF;
END
$$;

ALTER TABLE app.decks
    ADD COLUMN study_intensity text NOT NULL DEFAULT 'balanced'
        CHECK (study_intensity IN ('relaxed', 'balanced', 'intensive'));

GRANT UPDATE (study_intensity)
ON app.decks
TO quizforge_app;

COMMIT;

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$
BEGIN
    IF to_regclass('app.cards') IS NULL THEN
        RAISE EXCEPTION 'Expected the reviewed study card schema';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema='app'
          AND table_name='cards'
          AND column_name='tags'
    ) THEN
        RAISE EXCEPTION 'Card tags are already present';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema='app'
          AND table_name='cards'
          AND column_name='suspended'
    ) THEN
        RAISE EXCEPTION 'Expected card study-state schema';
    END IF;
END
$$;

ALTER TABLE app.cards
    ADD COLUMN tags text[] NOT NULL DEFAULT '{}'
        CHECK (
            cardinality(tags) <= 20
            AND array_position(tags, NULL) IS NULL
            AND array_position(tags, '') IS NULL
        );

CREATE INDEX cards_tags_gin_idx
    ON app.cards USING gin (tags);

GRANT UPDATE (tags)
    ON app.cards TO quizforge_app;

COMMIT;

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$
BEGIN
    IF to_regclass('app.decks') IS NULL
       OR to_regclass('app.cards') IS NULL THEN
        RAISE EXCEPTION 'Expected the reviewed deck schema';
    END IF;

    IF to_regclass('app.card_review_logs') IS NOT NULL THEN
        RAISE EXCEPTION 'FSRS review schema is already present';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema='app'
          AND table_name='cards'
          AND column_name IN (
              'fsrs_state',
              'fsrs_step',
              'stability',
              'difficulty',
              'due_at',
              'last_reviewed_at',
              'review_count',
              'lapse_count'
          )
    ) THEN
        RAISE EXCEPTION 'FSRS card columns are already present';
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

ALTER TABLE app.cards
    ADD COLUMN fsrs_state smallint NOT NULL DEFAULT 1
        CHECK (fsrs_state IN (1, 2, 3)),
    ADD COLUMN fsrs_step integer DEFAULT 0
        CHECK (fsrs_step IS NULL OR fsrs_step >= 0),
    ADD COLUMN stability double precision
        CHECK (stability IS NULL OR stability > 0),
    ADD COLUMN difficulty double precision
        CHECK (difficulty IS NULL OR difficulty BETWEEN 1 AND 10),
    ADD COLUMN due_at timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN last_reviewed_at timestamptz,
    ADD COLUMN review_count integer NOT NULL DEFAULT 0
        CHECK (review_count >= 0),
    ADD COLUMN lapse_count integer NOT NULL DEFAULT 0
        CHECK (lapse_count >= 0),
    ADD UNIQUE (id, user_id),
    ADD CHECK (
        (fsrs_state = 2 AND fsrs_step IS NULL)
        OR (fsrs_state IN (1, 3) AND fsrs_step IS NOT NULL)
    );

CREATE TABLE app.card_review_logs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    card_id uuid NOT NULL,
    user_id uuid NOT NULL,
    rating smallint NOT NULL CHECK (rating BETWEEN 1 AND 4),
    reviewed_at timestamptz NOT NULL DEFAULT now(),
    review_duration_ms integer CHECK (
        review_duration_ms IS NULL
        OR review_duration_ms BETWEEN 0 AND 86400000
    ),
    FOREIGN KEY (card_id, user_id)
        REFERENCES app.cards(id, user_id)
        ON DELETE CASCADE
);

CREATE INDEX cards_user_due_at_id_idx
    ON app.cards (user_id, due_at, id);

CREATE INDEX card_review_logs_user_card_reviewed_at_id_idx
    ON app.card_review_logs (
        user_id,
        card_id,
        reviewed_at DESC,
        id DESC
    );

GRANT SELECT, INSERT
    ON app.card_review_logs TO quizforge_app;

GRANT UPDATE (
    fsrs_state,
    fsrs_step,
    stability,
    difficulty,
    due_at,
    last_reviewed_at,
    review_count,
    lapse_count
) ON app.cards TO quizforge_app;

ALTER TABLE app.card_review_logs
    ENABLE ROW LEVEL SECURITY;

CREATE POLICY review_log_read
ON app.card_review_logs
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

CREATE POLICY review_log_insert
ON app.card_review_logs
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

COMMIT;

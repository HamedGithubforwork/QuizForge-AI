BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$
BEGIN
    IF to_regclass('app.users') IS NULL
       OR to_regclass('app.user_identities') IS NULL
       OR to_regclass('app.quiz_history') IS NULL THEN
        RAISE EXCEPTION 'Expected the reviewed QuizForge application schema';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_class
        WHERE oid = 'app.quiz_history'::regclass
          AND relrowsecurity
    ) THEN
        RAISE EXCEPTION 'Expected quiz_history row-level security';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_roles
        WHERE rolname = 'quizforge_app'
          AND NOT rolsuper
          AND NOT rolbypassrls
    ) THEN
        RAISE EXCEPTION 'Expected the restricted quizforge_app role';
    END IF;

    IF to_regclass('app.decks') IS NOT NULL
       OR to_regclass('app.cards') IS NOT NULL THEN
        RAISE EXCEPTION 'Deck schema is already present';
    END IF;
END
$$;

CREATE TABLE app.decks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
    name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
    description text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, user_id)
);

CREATE TABLE app.cards (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    deck_id uuid NOT NULL,
    user_id uuid NOT NULL,
    question_type text NOT NULL CHECK (
        question_type IN ('multiple_choice', 'true_false', 'short_answer')
    ),
    question text NOT NULL CHECK (char_length(btrim(question)) > 0),
    answer jsonb NOT NULL,
    choices jsonb,
    explanation text,
    source_filename text,
    document_sha256 text CHECK (
        document_sha256 IS NULL
        OR document_sha256 ~ '^[a-f0-9]{64}$'
    ),
    source_page integer CHECK (source_page IS NULL OR source_page > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (deck_id, user_id)
        REFERENCES app.decks(id, user_id)
        ON DELETE CASCADE
);

CREATE INDEX decks_user_updated_at_id_idx
    ON app.decks (user_id, updated_at DESC, id DESC);

CREATE INDEX cards_user_deck_created_at_id_idx
    ON app.cards (user_id, deck_id, created_at, id);

GRANT SELECT, INSERT, DELETE ON app.decks, app.cards TO quizforge_app;

GRANT UPDATE (name, description, updated_at)
    ON app.decks TO quizforge_app;

GRANT UPDATE (
    question_type,
    question,
    answer,
    choices,
    explanation,
    source_filename,
    document_sha256,
    source_page,
    updated_at
) ON app.cards TO quizforge_app;

ALTER TABLE app.decks ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.cards ENABLE ROW LEVEL SECURITY;

CREATE POLICY deck_read ON app.decks FOR SELECT TO quizforge_app
USING (
    user_id = nullif(current_setting('quizforge.user_id', true), '')::uuid
);

CREATE POLICY deck_insert ON app.decks FOR INSERT TO quizforge_app
WITH CHECK (
    user_id = nullif(current_setting('quizforge.user_id', true), '')::uuid
);

CREATE POLICY deck_update ON app.decks FOR UPDATE TO quizforge_app
USING (
    user_id = nullif(current_setting('quizforge.user_id', true), '')::uuid
)
WITH CHECK (
    user_id = nullif(current_setting('quizforge.user_id', true), '')::uuid
);

CREATE POLICY deck_delete ON app.decks FOR DELETE TO quizforge_app
USING (
    user_id = nullif(current_setting('quizforge.user_id', true), '')::uuid
);

CREATE POLICY card_read ON app.cards FOR SELECT TO quizforge_app
USING (
    user_id = nullif(current_setting('quizforge.user_id', true), '')::uuid
);

CREATE POLICY card_insert ON app.cards FOR INSERT TO quizforge_app
WITH CHECK (
    user_id = nullif(current_setting('quizforge.user_id', true), '')::uuid
);

CREATE POLICY card_update ON app.cards FOR UPDATE TO quizforge_app
USING (
    user_id = nullif(current_setting('quizforge.user_id', true), '')::uuid
)
WITH CHECK (
    user_id = nullif(current_setting('quizforge.user_id', true), '')::uuid
);

CREATE POLICY card_delete ON app.cards FOR DELETE TO quizforge_app
USING (
    user_id = nullif(current_setting('quizforge.user_id', true), '')::uuid
);

COMMIT;

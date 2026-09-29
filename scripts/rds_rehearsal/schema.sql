-- Disposable rehearsal only. Never run this bootstrap against production.
-- Application identities are separate from provider-managed auth schemas.
CREATE ROLE quizforge_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
REVOKE ALL ON DATABASE quizforge_rehearsal FROM PUBLIC;
GRANT CONNECT ON DATABASE quizforge_rehearsal TO quizforge_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA app;
REVOKE ALL ON SCHEMA app FROM PUBLIC;
GRANT USAGE ON SCHEMA app TO quizforge_app;
CREATE TABLE app.users (id uuid PRIMARY KEY);
CREATE TABLE app.user_identities (
    issuer text NOT NULL,
    subject text NOT NULL,
    user_id uuid NOT NULL REFERENCES app.users(id),
    PRIMARY KEY (issuer, subject)
);
CREATE TABLE app.quiz_history (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
    quiz_title text NOT NULL,
    source_filename text NOT NULL,
    document_sha256 text,
    difficulty text NOT NULL,
    question_type text NOT NULL,
    question_count integer NOT NULL CHECK (question_count > 0),
    score integer NOT NULL CHECK (score >= 0 AND score <= question_count),
    percentage integer NOT NULL CHECK (percentage BETWEEN 0 AND 100),
    quiz_data jsonb NOT NULL,
    selected_answers jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX quiz_history_user_created_at_id_idx ON app.quiz_history (user_id, created_at DESC, id DESC);
CREATE INDEX quiz_history_user_document_sha256_idx ON app.quiz_history (user_id, document_sha256) WHERE document_sha256 IS NOT NULL;
CREATE TABLE app.decks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
    name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
    description text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    exam_date date,
    UNIQUE (id, user_id)
);
CREATE TABLE app.cards (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    deck_id uuid NOT NULL,
    user_id uuid NOT NULL,
    question_type text NOT NULL CHECK (question_type IN ('multiple_choice', 'true_false', 'short_answer')),
    question text NOT NULL CHECK (char_length(btrim(question)) > 0),
    answer jsonb NOT NULL,
    choices jsonb,
    explanation text,
    source_filename text,
    document_sha256 text CHECK (document_sha256 IS NULL OR document_sha256 ~ '^[a-f0-9]{64}$'),
    source_pages integer[] NOT NULL DEFAULT '{}' CHECK (0 < ALL (source_pages)),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    fsrs_state smallint NOT NULL DEFAULT 1 CHECK (fsrs_state IN (1, 2, 3)),
    fsrs_step integer DEFAULT 0 CHECK (fsrs_step IS NULL OR fsrs_step >= 0),
    stability double precision CHECK (stability IS NULL OR stability > 0),
    difficulty double precision CHECK (difficulty IS NULL OR difficulty BETWEEN 1 AND 10),
    due_at timestamptz NOT NULL DEFAULT now(),
    last_reviewed_at timestamptz,
    review_count integer NOT NULL DEFAULT 0 CHECK (review_count >= 0),
    lapse_count integer NOT NULL DEFAULT 0 CHECK (lapse_count >= 0),
    suspended boolean NOT NULL DEFAULT false,
    progress_reset_at timestamptz,
    tags text[] NOT NULL DEFAULT '{}'
        CHECK (
            cardinality(tags) <= 20
            AND array_position(tags, NULL) IS NULL
            AND array_position(tags, '') IS NULL
        ),
    UNIQUE (id, user_id),
    CHECK (
        (fsrs_state = 2 AND fsrs_step IS NULL)
        OR (fsrs_state IN (1, 3) AND fsrs_step IS NOT NULL)
    ),
    FOREIGN KEY (deck_id, user_id)
        REFERENCES app.decks(id, user_id)
        ON DELETE CASCADE
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
CREATE INDEX decks_user_updated_at_id_idx ON app.decks (user_id, updated_at DESC, id DESC);
CREATE INDEX cards_user_deck_created_at_id_idx ON app.cards (user_id, deck_id, created_at, id);
CREATE INDEX cards_user_due_at_id_idx ON app.cards (user_id, due_at, id);
CREATE INDEX cards_user_active_due_at_id_idx
    ON app.cards (user_id, due_at, id)
    WHERE suspended = false;
CREATE INDEX cards_tags_gin_idx ON app.cards USING gin (tags);
CREATE INDEX card_review_logs_user_card_reviewed_at_id_idx
    ON app.card_review_logs (user_id, card_id, reviewed_at DESC, id DESC);
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
CREATE TABLE app.study_push_subscriptions (
    endpoint_hash text PRIMARY KEY CHECK (endpoint_hash ~ '^[a-f0-9]{64}$'),
    user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
    endpoint text NOT NULL CHECK (char_length(endpoint) BETWEEN 20 AND 4096 AND endpoint ~ '^https://'),
    p256dh text NOT NULL CHECK (char_length(p256dh) BETWEEN 20 AND 512),
    auth text NOT NULL CHECK (char_length(auth) BETWEEN 8 AND 256),
    user_agent text CHECK (user_agent IS NULL OR char_length(user_agent) <= 500),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX study_push_subscriptions_user_updated_idx
    ON app.study_push_subscriptions (user_id, updated_at DESC);
CREATE TABLE app.study_notification_deliveries (
    user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
    endpoint_hash text NOT NULL CHECK (endpoint_hash ~ '^[a-f0-9]{64}$'),
    local_date date NOT NULL,
    due_count integer NOT NULL CHECK (due_count BETWEEN 1 AND 100000),
    sent_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, endpoint_hash, local_date)
);
CREATE INDEX study_notification_deliveries_sent_at_idx
    ON app.study_notification_deliveries (sent_at DESC);
GRANT SELECT ON app.user_identities TO quizforge_app;
GRANT SELECT, INSERT, DELETE ON app.quiz_history TO quizforge_app;
GRANT SELECT, INSERT, DELETE ON app.decks, app.cards TO quizforge_app;
GRANT SELECT, INSERT ON app.card_review_logs TO quizforge_app;
GRANT SELECT, INSERT ON app.study_notification_preferences TO quizforge_app;
GRANT UPDATE (
    enabled,
    reminder_time,
    timezone,
    minimum_due_cards,
    updated_at
) ON app.study_notification_preferences TO quizforge_app;
GRANT SELECT, INSERT, DELETE ON app.study_push_subscriptions TO quizforge_app;
GRANT UPDATE (
    endpoint,
    p256dh,
    auth,
    user_agent,
    updated_at
) ON app.study_push_subscriptions TO quizforge_app;
GRANT UPDATE (name, description, updated_at) ON app.decks TO quizforge_app;
GRANT UPDATE (exam_date) ON app.decks TO quizforge_app;
GRANT UPDATE (
    question_type,
    question,
    answer,
    choices,
    explanation,
    source_filename,
    document_sha256,
    source_pages,
    fsrs_state,
    fsrs_step,
    stability,
    difficulty,
    due_at,
    last_reviewed_at,
    review_count,
    lapse_count,
    suspended,
    progress_reset_at,
    tags,
    updated_at
) ON app.cards TO quizforge_app;
ALTER TABLE app.user_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.quiz_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.decks ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.card_review_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.study_notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.study_push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.study_notification_deliveries ENABLE ROW LEVEL SECURITY;
-- Owner is a separate migration role. App is never table owner or BYPASSRLS.
CREATE POLICY identity_lookup ON app.user_identities FOR SELECT TO quizforge_app
USING (issuer = nullif(current_setting('quizforge.auth_issuer', true), '')
   AND subject = nullif(current_setting('quizforge.auth_subject', true), ''));
CREATE POLICY history_read ON app.quiz_history FOR SELECT TO quizforge_app
USING (user_id = nullif(current_setting('quizforge.user_id', true), '')::uuid);
CREATE POLICY history_insert ON app.quiz_history FOR INSERT TO quizforge_app
WITH CHECK (user_id = nullif(current_setting('quizforge.user_id', true), '')::uuid);
CREATE POLICY history_delete ON app.quiz_history FOR DELETE TO quizforge_app
USING (user_id = nullif(current_setting('quizforge.user_id', true), '')::uuid);
CREATE POLICY deck_read ON app.decks FOR SELECT TO quizforge_app
USING (user_id = nullif(current_setting('quizforge.user_id', true), '')::uuid);
CREATE POLICY deck_insert ON app.decks FOR INSERT TO quizforge_app
WITH CHECK (user_id = nullif(current_setting('quizforge.user_id', true), '')::uuid);
CREATE POLICY deck_update ON app.decks FOR UPDATE TO quizforge_app
USING (user_id = nullif(current_setting('quizforge.user_id', true), '')::uuid)
WITH CHECK (user_id = nullif(current_setting('quizforge.user_id', true), '')::uuid);
CREATE POLICY deck_delete ON app.decks FOR DELETE TO quizforge_app
USING (user_id = nullif(current_setting('quizforge.user_id', true), '')::uuid);
CREATE POLICY card_read ON app.cards FOR SELECT TO quizforge_app
USING (user_id = nullif(current_setting('quizforge.user_id', true), '')::uuid);
CREATE POLICY card_insert ON app.cards FOR INSERT TO quizforge_app
WITH CHECK (user_id = nullif(current_setting('quizforge.user_id', true), '')::uuid);
CREATE POLICY card_update ON app.cards FOR UPDATE TO quizforge_app
USING (user_id = nullif(current_setting('quizforge.user_id', true), '')::uuid)
WITH CHECK (user_id = nullif(current_setting('quizforge.user_id', true), '')::uuid);
CREATE POLICY card_delete ON app.cards FOR DELETE TO quizforge_app
USING (user_id = nullif(current_setting('quizforge.user_id', true), '')::uuid);


CREATE FUNCTION app.move_card(
    p_card_id uuid,
    p_source_deck_id uuid,
    p_target_deck_id uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
DECLARE
    v_user_id uuid;
BEGIN
    v_user_id := nullif(
        current_setting(
            'quizforge.user_id',
            true
        ),
        ''
    )::uuid;

    IF v_user_id IS NULL THEN
        RETURN false;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM app.decks
        WHERE id = p_target_deck_id
          AND user_id = v_user_id
    ) THEN
        RETURN false;
    END IF;

    UPDATE app.cards
    SET
        deck_id = p_target_deck_id,
        updated_at = now()
    WHERE id = p_card_id
      AND deck_id = p_source_deck_id
      AND user_id = v_user_id;

    IF NOT FOUND THEN
        RETURN false;
    END IF;

    UPDATE app.decks
    SET updated_at = now()
    WHERE user_id = v_user_id
      AND id IN (
          p_source_deck_id,
          p_target_deck_id
      );

    RETURN true;
END
$$;

REVOKE ALL
ON FUNCTION app.move_card(uuid, uuid, uuid)
FROM PUBLIC;
GRANT EXECUTE
ON FUNCTION app.move_card(uuid, uuid, uuid)
TO quizforge_app;

CREATE POLICY review_log_read ON app.card_review_logs FOR SELECT TO quizforge_app
USING (user_id = nullif(current_setting('quizforge.user_id', true), '')::uuid);
CREATE POLICY review_log_insert ON app.card_review_logs FOR INSERT TO quizforge_app
WITH CHECK (user_id = nullif(current_setting('quizforge.user_id', true), '')::uuid);

CREATE POLICY notification_preferences_read ON app.study_notification_preferences FOR SELECT TO quizforge_app
USING (user_id = nullif(current_setting('quizforge.user_id', true), '')::uuid);
CREATE POLICY notification_preferences_insert ON app.study_notification_preferences FOR INSERT TO quizforge_app
WITH CHECK (user_id = nullif(current_setting('quizforge.user_id', true), '')::uuid);
CREATE POLICY notification_preferences_update ON app.study_notification_preferences FOR UPDATE TO quizforge_app
USING (user_id = nullif(current_setting('quizforge.user_id', true), '')::uuid)
WITH CHECK (user_id = nullif(current_setting('quizforge.user_id', true), '')::uuid);

CREATE POLICY study_push_subscription_read ON app.study_push_subscriptions FOR SELECT TO quizforge_app
USING (user_id = nullif(current_setting('quizforge.user_id', true), '')::uuid);
CREATE POLICY study_push_subscription_insert ON app.study_push_subscriptions FOR INSERT TO quizforge_app
WITH CHECK (user_id = nullif(current_setting('quizforge.user_id', true), '')::uuid);
CREATE POLICY study_push_subscription_update ON app.study_push_subscriptions FOR UPDATE TO quizforge_app
USING (user_id = nullif(current_setting('quizforge.user_id', true), '')::uuid)
WITH CHECK (user_id = nullif(current_setting('quizforge.user_id', true), '')::uuid);
CREATE POLICY study_push_subscription_delete ON app.study_push_subscriptions FOR DELETE TO quizforge_app
USING (user_id = nullif(current_setting('quizforge.user_id', true), '')::uuid);

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$
BEGIN
    IF to_regclass('app.study_notification_preferences') IS NULL
       OR to_regclass('app.cards') IS NULL THEN
        RAISE EXCEPTION 'Expected the reviewed study notification schema';
    END IF;

    IF to_regclass('app.web_push_subscriptions') IS NOT NULL
       OR to_regclass('app.study_notification_deliveries') IS NOT NULL
       OR EXISTS (
            SELECT 1
            FROM pg_roles
            WHERE rolname='quizforge_notifier'
       ) THEN
        RAISE EXCEPTION 'Web push schema is already partially or fully present';
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

CREATE ROLE quizforge_notifier
    LOGIN
    NOSUPERUSER
    NOCREATEDB
    NOCREATEROLE
    NOINHERIT
    NOBYPASSRLS;

GRANT CONNECT ON DATABASE quizforge
    TO quizforge_notifier;
GRANT USAGE ON SCHEMA app
    TO quizforge_notifier;

CREATE TABLE app.web_push_subscriptions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
    endpoint text NOT NULL
        CHECK (
            char_length(endpoint) BETWEEN 10 AND 4096
            AND endpoint ~ '^https://'
        ),
    endpoint_sha256 text NOT NULL UNIQUE
        CHECK (endpoint_sha256 ~ '^[a-f0-9]{64}$'),
    p256dh text NOT NULL
        CHECK (
            char_length(p256dh) BETWEEN 40 AND 256
            AND p256dh ~ '^[A-Za-z0-9_-]+$'
        ),
    auth text NOT NULL
        CHECK (
            char_length(auth) BETWEEN 16 AND 128
            AND auth ~ '^[A-Za-z0-9_-]+$'
        ),
    failure_count integer NOT NULL DEFAULT 0
        CHECK (failure_count BETWEEN 0 AND 1000),
    last_success_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, endpoint_sha256)
);

CREATE TABLE app.study_notification_deliveries (
    user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
    local_date date NOT NULL,
    channel text NOT NULL DEFAULT 'web_push'
        CHECK (channel = 'web_push'),
    due_count integer NOT NULL CHECK (due_count > 0),
    sent_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, local_date, channel)
);

CREATE INDEX web_push_subscriptions_user_updated_at_idx
    ON app.web_push_subscriptions (user_id, updated_at DESC, id DESC);

GRANT SELECT, INSERT, DELETE
    ON app.web_push_subscriptions
    TO quizforge_app;

GRANT UPDATE (
    endpoint,
    p256dh,
    auth,
    updated_at
) ON app.web_push_subscriptions
    TO quizforge_app;

GRANT SELECT
    ON app.study_notification_deliveries
    TO quizforge_app;

GRANT SELECT
    ON app.study_notification_preferences
    TO quizforge_notifier;

GRANT SELECT (user_id, due_at)
    ON app.cards
    TO quizforge_notifier;

GRANT SELECT, DELETE
    ON app.web_push_subscriptions
    TO quizforge_notifier;

GRANT UPDATE (
    failure_count,
    last_success_at,
    updated_at
) ON app.web_push_subscriptions
    TO quizforge_notifier;

GRANT SELECT, INSERT
    ON app.study_notification_deliveries
    TO quizforge_notifier;

ALTER TABLE app.web_push_subscriptions
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE app.study_notification_deliveries
    ENABLE ROW LEVEL SECURITY;

CREATE POLICY web_push_subscription_read
ON app.web_push_subscriptions
FOR SELECT TO quizforge_app
USING (
    user_id = nullif(current_setting('quizforge.user_id', true), '')::uuid
);

CREATE POLICY web_push_subscription_insert
ON app.web_push_subscriptions
FOR INSERT TO quizforge_app
WITH CHECK (
    user_id = nullif(current_setting('quizforge.user_id', true), '')::uuid
);

CREATE POLICY web_push_subscription_update
ON app.web_push_subscriptions
FOR UPDATE TO quizforge_app
USING (
    user_id = nullif(current_setting('quizforge.user_id', true), '')::uuid
)
WITH CHECK (
    user_id = nullif(current_setting('quizforge.user_id', true), '')::uuid
);

CREATE POLICY web_push_subscription_delete
ON app.web_push_subscriptions
FOR DELETE TO quizforge_app
USING (
    user_id = nullif(current_setting('quizforge.user_id', true), '')::uuid
);

CREATE POLICY notification_delivery_read
ON app.study_notification_deliveries
FOR SELECT TO quizforge_app
USING (
    user_id = nullif(current_setting('quizforge.user_id', true), '')::uuid
);

CREATE POLICY notifier_preferences_read
ON app.study_notification_preferences
FOR SELECT TO quizforge_notifier
USING (true);

CREATE POLICY notifier_cards_read
ON app.cards
FOR SELECT TO quizforge_notifier
USING (true);

CREATE POLICY notifier_subscriptions_read
ON app.web_push_subscriptions
FOR SELECT TO quizforge_notifier
USING (true);

CREATE POLICY notifier_subscriptions_update
ON app.web_push_subscriptions
FOR UPDATE TO quizforge_notifier
USING (true)
WITH CHECK (true);

CREATE POLICY notifier_subscriptions_delete
ON app.web_push_subscriptions
FOR DELETE TO quizforge_notifier
USING (true);

CREATE POLICY notifier_deliveries_read
ON app.study_notification_deliveries
FOR SELECT TO quizforge_notifier
USING (true);

CREATE POLICY notifier_deliveries_insert
ON app.study_notification_deliveries
FOR INSERT TO quizforge_notifier
WITH CHECK (true);

COMMIT;

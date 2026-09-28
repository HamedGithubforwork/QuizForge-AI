BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$
BEGIN
    IF to_regclass('app.study_notification_preferences') IS NULL THEN
        RAISE EXCEPTION 'Expected study notification preferences schema';
    END IF;

    IF to_regclass('app.study_push_subscriptions') IS NOT NULL
       OR to_regclass('app.study_notification_deliveries') IS NOT NULL THEN
        RAISE EXCEPTION 'Study Web Push schema is already present';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_class
        WHERE oid='app.study_notification_preferences'::regclass
          AND relrowsecurity
    ) THEN
        RAISE EXCEPTION 'Expected notification preference row-level security';
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

CREATE TABLE app.study_push_subscriptions (
    endpoint_hash text PRIMARY KEY
        CHECK (endpoint_hash ~ '^[a-f0-9]{64}$'),
    user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
    endpoint text NOT NULL
        CHECK (
            char_length(endpoint) BETWEEN 20 AND 4096
            AND endpoint ~ '^https://'
        ),
    p256dh text NOT NULL
        CHECK (char_length(p256dh) BETWEEN 20 AND 512),
    auth text NOT NULL
        CHECK (char_length(auth) BETWEEN 8 AND 256),
    user_agent text
        CHECK (user_agent IS NULL OR char_length(user_agent) <= 500),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX study_push_subscriptions_user_updated_idx
    ON app.study_push_subscriptions (user_id, updated_at DESC);

CREATE TABLE app.study_notification_deliveries (
    user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
    endpoint_hash text NOT NULL
        CHECK (endpoint_hash ~ '^[a-f0-9]{64}$'),
    local_date date NOT NULL,
    due_count integer NOT NULL CHECK (due_count BETWEEN 1 AND 100000),
    sent_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, endpoint_hash, local_date)
);

CREATE INDEX study_notification_deliveries_sent_at_idx
    ON app.study_notification_deliveries (sent_at DESC);

GRANT SELECT, INSERT, DELETE
    ON app.study_push_subscriptions
    TO quizforge_app;

GRANT UPDATE (
    endpoint,
    p256dh,
    auth,
    user_agent,
    updated_at
) ON app.study_push_subscriptions
    TO quizforge_app;

ALTER TABLE app.study_push_subscriptions
    ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.study_notification_deliveries
    ENABLE ROW LEVEL SECURITY;

CREATE POLICY study_push_subscription_read
ON app.study_push_subscriptions
FOR SELECT TO quizforge_app
USING (
    user_id = nullif(current_setting('quizforge.user_id', true), '')::uuid
);

CREATE POLICY study_push_subscription_insert
ON app.study_push_subscriptions
FOR INSERT TO quizforge_app
WITH CHECK (
    user_id = nullif(current_setting('quizforge.user_id', true), '')::uuid
);

CREATE POLICY study_push_subscription_update
ON app.study_push_subscriptions
FOR UPDATE TO quizforge_app
USING (
    user_id = nullif(current_setting('quizforge.user_id', true), '')::uuid
)
WITH CHECK (
    user_id = nullif(current_setting('quizforge.user_id', true), '')::uuid
);

CREATE POLICY study_push_subscription_delete
ON app.study_push_subscriptions
FOR DELETE TO quizforge_app
USING (
    user_id = nullif(current_setting('quizforge.user_id', true), '')::uuid
);

COMMIT;

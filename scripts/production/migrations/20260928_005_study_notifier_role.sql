BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$
BEGIN
    IF to_regclass('app.study_push_subscriptions') IS NULL
       OR to_regclass('app.study_notification_deliveries') IS NULL THEN
        RAISE EXCEPTION 'Expected the reviewed Web Push schema';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_roles
        WHERE rolname='quizforge_notifier'
    ) THEN
        RAISE EXCEPTION 'Study notifier role is already present';
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

GRANT SELECT (
    user_id,
    due_at
) ON app.cards
TO quizforge_notifier;

GRANT SELECT (
    user_id,
    enabled,
    reminder_time,
    timezone,
    minimum_due_cards
) ON app.study_notification_preferences
TO quizforge_notifier;

GRANT SELECT (
    endpoint_hash,
    user_id,
    endpoint,
    p256dh,
    auth
) ON app.study_push_subscriptions
TO quizforge_notifier;

GRANT DELETE
ON app.study_push_subscriptions
TO quizforge_notifier;

GRANT SELECT, INSERT
ON app.study_notification_deliveries
TO quizforge_notifier;

CREATE POLICY notifier_card_read
ON app.cards
FOR SELECT TO quizforge_notifier
USING (true);

CREATE POLICY notifier_preferences_read
ON app.study_notification_preferences
FOR SELECT TO quizforge_notifier
USING (true);

CREATE POLICY notifier_push_subscription_read
ON app.study_push_subscriptions
FOR SELECT TO quizforge_notifier
USING (true);

CREATE POLICY notifier_push_subscription_delete
ON app.study_push_subscriptions
FOR DELETE TO quizforge_notifier
USING (true);

CREATE POLICY notifier_delivery_read
ON app.study_notification_deliveries
FOR SELECT TO quizforge_notifier
USING (true);

CREATE POLICY notifier_delivery_insert
ON app.study_notification_deliveries
FOR INSERT TO quizforge_notifier
WITH CHECK (true);

COMMIT;

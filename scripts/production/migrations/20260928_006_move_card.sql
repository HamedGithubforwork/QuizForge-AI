BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$
BEGIN
    IF to_regclass('app.decks') IS NULL
       OR to_regclass('app.cards') IS NULL THEN
        RAISE EXCEPTION 'Expected the reviewed deck schema';
    END IF;

    IF to_regprocedure('app.move_card(uuid,uuid,uuid)') IS NOT NULL THEN
        RAISE EXCEPTION 'Move-card function is already present';
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

COMMIT;

-- Apply once as the dedicated database owner. No credentials or user data.
CREATE ROLE quizforge_generation LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
GRANT CONNECT ON DATABASE quizforge TO quizforge_generation;
CREATE SCHEMA billing;
REVOKE ALL ON SCHEMA billing FROM PUBLIC;
GRANT USAGE ON SCHEMA billing TO quizforge_generation;
CREATE TABLE billing.generation_policy (
    singleton boolean PRIMARY KEY CHECK (singleton),
    enabled boolean NOT NULL DEFAULT false,
    daily_requests integer NOT NULL CHECK (daily_requests BETWEEN 0 AND 1000),
    monthly_requests integer NOT NULL CHECK (monthly_requests BETWEEN 0 AND 10000),
    monthly_nano_usd bigint NOT NULL DEFAULT 0 CHECK (monthly_nano_usd BETWEEN 0 AND 5000000000),
    pricing_key text NOT NULL DEFAULT '',
    pricing_valid_until date NOT NULL DEFAULT '1970-01-01',
    CHECK (daily_requests <= monthly_requests)
);
INSERT INTO billing.generation_policy VALUES (true, false, 0, 0);
CREATE TABLE billing.generation_usage (
    period text NOT NULL CHECK (period IN ('day','month')),
    starts_on date NOT NULL,
    requests integer NOT NULL DEFAULT 0 CHECK (requests >= 0),
    accounted_nano_usd bigint NOT NULL DEFAULT 0 CHECK (accounted_nano_usd >= 0),
    PRIMARY KEY (period, starts_on)
);
-- Metadata only: never store prompts, documents, responses or API keys here.
CREATE TABLE billing.generation_reservations (
    attempt_id uuid PRIMARY KEY,
    day_start date NOT NULL,
    month_start date NOT NULL,
    maximum_nano_usd bigint NOT NULL CHECK (maximum_nano_usd BETWEEN 1 AND 1000000000),
    settled_nano_usd bigint CHECK (settled_nano_usd BETWEEN 0 AND maximum_nano_usd)
);
-- Old operations clients fail closed; they cannot bypass monetary reservations.
CREATE FUNCTION billing.reserve_generation() RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$ SELECT false $$;
REVOKE ALL ON FUNCTION billing.reserve_generation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing.reserve_generation() TO quizforge_generation;

-- No table grants: all counters and money are reserved in the same transaction.
CREATE FUNCTION billing.reserve_generation_cost(attempt uuid, maximum_cost bigint, rate_key text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
    policy billing.generation_policy%ROWTYPE;
    reserved_at timestamp;
    v_day_start date;
    v_month_start date;
BEGIN
    IF attempt IS NULL OR maximum_cost IS NULL OR maximum_cost NOT BETWEEN 1 AND 1000000000
        OR rate_key IS NULL OR rate_key = '' THEN RETURN false; END IF;
    PERFORM pg_advisory_xact_lock(721856411004::bigint);
    reserved_at := clock_timestamp() AT TIME ZONE 'UTC';
    v_day_start := reserved_at::date;
    v_month_start := date_trunc('month', reserved_at)::date;
    SELECT * INTO policy FROM billing.generation_policy WHERE singleton FOR SHARE;
    IF NOT FOUND OR NOT policy.enabled OR policy.daily_requests <= 0 OR policy.monthly_requests <= 0
        OR policy.monthly_nano_usd <= 0 OR policy.pricing_key <> rate_key
        OR v_day_start >= policy.pricing_valid_until THEN RETURN false; END IF;
    IF EXISTS (SELECT 1 FROM billing.generation_reservations WHERE attempt_id=attempt) THEN
        RETURN false;
    END IF;
    -- Retain current/prior month attempt metadata. Totals never disappear, even
    -- when an old timed-out attempt is pruned; its maximum remains accounted.
    DELETE FROM billing.generation_reservations r
        WHERE r.month_start < (v_month_start - interval '1 month')::date;
    IF (SELECT count(*) FROM billing.generation_reservations) >= 10000 THEN RETURN false; END IF;
    INSERT INTO billing.generation_usage(period,starts_on) VALUES ('day',v_day_start),('month',v_month_start)
        ON CONFLICT DO NOTHING;
    IF EXISTS (SELECT 1 FROM billing.generation_usage
        WHERE (period='day' AND starts_on=v_day_start AND requests >= policy.daily_requests)
           OR (period='month' AND starts_on=v_month_start AND
               (requests >= policy.monthly_requests OR accounted_nano_usd + maximum_cost > policy.monthly_nano_usd))) THEN
        RETURN false;
    END IF;
    INSERT INTO billing.generation_reservations VALUES (attempt,v_day_start,v_month_start,maximum_cost,NULL);
    UPDATE billing.generation_usage SET requests=requests+1, accounted_nano_usd=accounted_nano_usd+maximum_cost
        WHERE (period='day' AND starts_on=v_day_start) OR (period='month' AND starts_on=v_month_start);
    RETURN true;
END $$;
REVOKE ALL ON FUNCTION billing.reserve_generation_cost(uuid,bigint,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing.reserve_generation_cost(uuid,bigint,text) TO quizforge_generation;

CREATE FUNCTION billing.settle_generation_cost(attempt uuid, charged bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
    reservation billing.generation_reservations%ROWTYPE;
    refund bigint;
BEGIN
    IF attempt IS NULL OR charged IS NULL OR charged < 0 THEN RETURN false; END IF;
    PERFORM pg_advisory_xact_lock(721856411004::bigint);
    SELECT * INTO reservation FROM billing.generation_reservations WHERE attempt_id=attempt FOR UPDATE;
    IF NOT FOUND OR reservation.settled_nano_usd IS NOT NULL OR charged > reservation.maximum_nano_usd THEN
        RETURN false;
    END IF;
    refund := reservation.maximum_nano_usd - charged;
    UPDATE billing.generation_usage SET accounted_nano_usd=accounted_nano_usd-refund
        WHERE (period='day' AND starts_on=reservation.day_start)
           OR (period='month' AND starts_on=reservation.month_start);
    UPDATE billing.generation_reservations SET settled_nano_usd=charged WHERE attempt_id=attempt;
    RETURN true;
END $$;
REVOKE ALL ON FUNCTION billing.settle_generation_cost(uuid,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing.settle_generation_cost(uuid,bigint) TO quizforge_generation;

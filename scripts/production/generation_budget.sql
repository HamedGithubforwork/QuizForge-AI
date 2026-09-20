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
    CHECK (daily_requests <= monthly_requests)
);
INSERT INTO billing.generation_policy VALUES (true, false, 0, 0);
CREATE TABLE billing.generation_usage (
    period text NOT NULL CHECK (period IN ('day','month')),
    starts_on date NOT NULL,
    requests integer NOT NULL DEFAULT 0 CHECK (requests >= 0),
    PRIMARY KEY (period, starts_on)
);
-- No table grants: the guard may only reserve one bounded request atomically.
-- Fixed search_path and qualified relations prevent object substitution.
CREATE FUNCTION billing.reserve_generation() RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
    policy billing.generation_policy%ROWTYPE;
    reserved_at timestamp := clock_timestamp() AT TIME ZONE 'UTC';
    day_start date := reserved_at::date;
    month_start date := date_trunc('month', reserved_at)::date;
BEGIN
    SELECT * INTO policy FROM billing.generation_policy WHERE singleton FOR SHARE;
    IF NOT FOUND OR NOT policy.enabled OR policy.daily_requests <= 0 OR policy.monthly_requests <= 0 THEN
        RETURN false;
    END IF;
    PERFORM pg_advisory_xact_lock(721856411004::bigint);
    INSERT INTO billing.generation_usage(period,starts_on) VALUES ('day',day_start),('month',month_start)
        ON CONFLICT DO NOTHING;
    IF EXISTS (SELECT 1 FROM billing.generation_usage
        WHERE (period='day' AND starts_on=day_start AND requests >= policy.daily_requests)
           OR (period='month' AND starts_on=month_start AND requests >= policy.monthly_requests)) THEN
        RETURN false;
    END IF;
    UPDATE billing.generation_usage SET requests=requests+1
        WHERE (period='day' AND starts_on=day_start) OR (period='month' AND starts_on=month_start);
    RETURN true;
END $$;
REVOKE ALL ON FUNCTION billing.reserve_generation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing.reserve_generation() TO quizforge_generation;

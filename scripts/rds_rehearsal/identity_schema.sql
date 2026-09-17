-- OPT-IN disposable staging enrollment only. Apply after schema.sql as owner.
-- This role is given only to the separate identity_app process, never the API.
CREATE ROLE quizforge_identity LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
GRANT CONNECT ON DATABASE quizforge_rehearsal TO quizforge_identity;
GRANT USAGE ON SCHEMA app TO quizforge_identity;
GRANT INSERT ON app.users TO quizforge_identity;
GRANT SELECT, INSERT ON app.user_identities TO quizforge_identity;
ALTER TABLE app.users ENABLE ROW LEVEL SECURITY;
CREATE POLICY enroll_user ON app.users FOR INSERT TO quizforge_identity
WITH CHECK (id = nullif(current_setting('quizforge.new_owner',true),'')::uuid);
CREATE POLICY enrollment_lookup ON app.user_identities FOR SELECT TO quizforge_identity
USING ((issuer = current_setting('quizforge.cognito_issuer',true) AND subject = current_setting('quizforge.cognito_subject',true))
    OR (issuer = current_setting('quizforge.legacy_issuer',true) AND subject = current_setting('quizforge.legacy_subject',true)));
CREATE POLICY enrollment_insert ON app.user_identities FOR INSERT TO quizforge_identity
WITH CHECK (issuer = current_setting('quizforge.cognito_issuer',true)
    AND subject = current_setting('quizforge.cognito_subject',true)
    AND user_id = nullif(current_setting('quizforge.new_owner',true),'')::uuid);
CREATE TABLE app.identity_challenges (
    nonce_hash text PRIMARY KEY CHECK (nonce_hash ~ '^[a-f0-9]{64}$'),
    issuer text NOT NULL,
    subject text NOT NULL,
    legacy_issuer text NOT NULL,
    legacy_subject text NOT NULL,
    mode text NOT NULL CHECK (mode IN ('enroll','link')),
    created_at timestamptz NOT NULL DEFAULT now(),
    used_at timestamptz,
    CHECK ((mode='enroll' AND legacy_issuer='' AND legacy_subject='') OR
           (mode='link' AND legacy_issuer<>'' AND legacy_subject<>''))
);
CREATE INDEX identity_challenge_rate_idx ON app.identity_challenges(issuer,subject,created_at);
ALTER TABLE app.identity_challenges ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON app.identity_challenges TO quizforge_identity;
GRANT UPDATE(used_at) ON app.identity_challenges TO quizforge_identity;
CREATE POLICY challenge_owner ON app.identity_challenges TO quizforge_identity
USING (issuer = current_setting('quizforge.cognito_issuer',true) AND subject = current_setting('quizforge.cognito_subject',true))
WITH CHECK (issuer = current_setting('quizforge.cognito_issuer',true) AND subject = current_setting('quizforge.cognito_subject',true));

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
GRANT SELECT ON app.user_identities TO quizforge_app;
GRANT SELECT, INSERT, DELETE ON app.quiz_history TO quizforge_app;
ALTER TABLE app.user_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.quiz_history ENABLE ROW LEVEL SECURITY;
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

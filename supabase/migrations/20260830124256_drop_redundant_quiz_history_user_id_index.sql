-- Remove the standalone user_id index after production usage confirmed it
-- was unused. Both remaining history-order indexes begin with user_id and
-- cover the application's user-scoped access paths.
--
-- Keep quiz_history_user_created_at_idx: live pg_stat_user_indexes still
-- shows active scans for that index. Keep the document_sha256 index for the
-- document-history feature even while current production traffic is small.

drop index if exists public.quiz_history_user_id_idx;

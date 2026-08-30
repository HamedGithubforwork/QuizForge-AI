-- Support stable cursor pagination for quiz history ordered by newest first.
-- RLS remains unchanged; the leading user_id column matches the per-user
-- access pattern enforced by the existing policies.

create index if not exists quiz_history_user_created_at_id_idx
on public.quiz_history (
    user_id,
    created_at desc,
    id desc
);

-- Keep the browser-facing authenticated role limited to the operations used
-- by QuizForge. TRUNCATE is table-wide and does not respect row-level security.

revoke all privileges
on table public.quiz_history
from authenticated;

revoke all privileges
on table public.quiz_history
from anon;

grant select, insert, delete
on table public.quiz_history
to authenticated;

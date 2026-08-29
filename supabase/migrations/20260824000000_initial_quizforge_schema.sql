-- QuizForge AI baseline database schema.
-- Represents the durable project database state before the later
-- document_sha256 migration.
--
-- This migration is intended for recreating the QuizForge schema from
-- an empty Supabase project. Do not manually run it against an existing
-- database where these objects already exist.

-- ============================================================
-- QUIZ HISTORY
-- ============================================================

create table public.quiz_history (
    id uuid not null default gen_random_uuid(),
    user_id uuid not null,
    quiz_title text not null,
    source_filename text not null,
    difficulty text not null,
    question_type text not null,
    question_count integer not null,
    score integer not null,
    percentage integer not null,
    quiz_data jsonb not null,
    selected_answers jsonb not null,
    created_at timestamp with time zone not null default now(),

    constraint quiz_history_pkey
        primary key (id),

    constraint quiz_history_user_id_fkey
        foreign key (user_id)
        references auth.users(id)
        on delete cascade,

    constraint quiz_history_question_count_check
        check (question_count > 0),

    constraint quiz_history_score_check
        check (
            score >= 0
            and score <= question_count
        ),

    constraint quiz_history_percentage_check
        check (
            percentage >= 0
            and percentage <= 100
        )
);

-- ============================================================
-- INDEXES
-- ============================================================

create index quiz_history_user_id_idx
on public.quiz_history (user_id);

create index quiz_history_user_created_at_idx
on public.quiz_history (
    user_id,
    created_at desc
);

-- ============================================================
-- TABLE ACCESS
-- ============================================================

revoke all
on table public.quiz_history
from anon;

grant select, insert, delete
on table public.quiz_history
to authenticated;

revoke update
on table public.quiz_history
from authenticated;

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

alter table public.quiz_history
enable row level security;

create policy "Users can view their own quiz history"
on public.quiz_history
for select
to authenticated
using (
    (select auth.uid()) = user_id
);

create policy "Users can create their own quiz history"
on public.quiz_history
for insert
to authenticated
with check (
    (select auth.uid()) = user_id
);

create policy "Users can delete their own quiz history"
on public.quiz_history
for delete
to authenticated
using (
    (select auth.uid()) = user_id
);

-- ============================================================
-- AUTOMATIC RLS SAFETY MECHANISM
-- ============================================================

create or replace function public.rls_auto_enable()
returns event_trigger
language plpgsql
security definer
set search_path to 'pg_catalog'
as $function$
declare
    cmd record;
begin
    for cmd in
        select *
        from pg_event_trigger_ddl_commands()
        where command_tag in (
            'CREATE TABLE',
            'CREATE TABLE AS',
            'SELECT INTO'
        )
        and object_type in (
            'table',
            'partitioned table'
        )
    loop
        if
            cmd.schema_name is not null
            and cmd.schema_name in ('public')
            and cmd.schema_name not in (
                'pg_catalog',
                'information_schema'
            )
            and cmd.schema_name not like 'pg_toast%'
            and cmd.schema_name not like 'pg_temp%'
        then
            begin
                execute format(
                    'alter table if exists %s enable row level security',
                    cmd.object_identity
                );

                raise log
                    'rls_auto_enable: enabled RLS on %',
                    cmd.object_identity;
            exception
                when others then
                    raise log
                        'rls_auto_enable: failed to enable RLS on %',
                        cmd.object_identity;
            end;
        else
            raise log
                'rls_auto_enable: skip % (either system schema or not in enforced list: %.)',
                cmd.object_identity,
                cmd.schema_name;
        end if;
    end loop;
end;
$function$;

create event trigger ensure_rls
on ddl_command_end
when tag in (
    'CREATE TABLE',
    'CREATE TABLE AS',
    'SELECT INTO'
)
execute function public.rls_auto_enable();

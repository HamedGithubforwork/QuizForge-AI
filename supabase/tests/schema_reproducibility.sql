\set ON_ERROR_STOP on

do $$
declare
    actual_columns text[];
    actual_constraints text[];
    actual_indexes text[];
    actual_policies text[];
    rls_enabled boolean;
    rls_forced boolean;
    function_security_definer boolean;
    function_config text[];
    event_trigger_count integer;
    migration_count integer;
    foreign_key_definition text;
    document_hash_comment text;
begin
    if to_regclass('public.quiz_history') is null then
        raise exception 'public.quiz_history was not created';
    end if;

    select array_agg(column_name order by ordinal_position)
    into actual_columns
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'quiz_history';

    if actual_columns is distinct from array[
        'id',
        'user_id',
        'quiz_title',
        'source_filename',
        'difficulty',
        'question_type',
        'question_count',
        'score',
        'percentage',
        'quiz_data',
        'selected_answers',
        'created_at',
        'document_sha256'
    ]::text[] then
        raise exception 'quiz_history columns do not match the expected schema: %', actual_columns;
    end if;

    select array_agg(conname order by conname)
    into actual_constraints
    from pg_constraint
    where conrelid = 'public.quiz_history'::regclass;

    if actual_constraints is distinct from array[
        'quiz_history_percentage_check',
        'quiz_history_pkey',
        'quiz_history_question_count_check',
        'quiz_history_score_check',
        'quiz_history_user_id_fkey'
    ]::text[] then
        raise exception 'quiz_history constraints do not match: %', actual_constraints;
    end if;

    select pg_get_constraintdef(oid)
    into foreign_key_definition
    from pg_constraint
    where conrelid = 'public.quiz_history'::regclass
      and conname = 'quiz_history_user_id_fkey';

    if foreign_key_definition not like '%REFERENCES auth.users(id) ON DELETE CASCADE%' then
        raise exception 'quiz_history user foreign key does not match production behavior: %', foreign_key_definition;
    end if;

    select array_agg(indexname order by indexname)
    into actual_indexes
    from pg_indexes
    where schemaname = 'public'
      and tablename = 'quiz_history';

    if actual_indexes is distinct from array[
        'quiz_history_pkey',
        'quiz_history_user_created_at_id_idx',
        'quiz_history_user_created_at_idx',
        'quiz_history_user_document_sha256_idx',
        'quiz_history_user_id_idx'
    ]::text[] then
        raise exception 'quiz_history indexes do not match: %', actual_indexes;
    end if;

    select c.relrowsecurity, c.relforcerowsecurity
    into rls_enabled, rls_forced
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'quiz_history';

    if rls_enabled is not true or rls_forced is not false then
        raise exception 'quiz_history RLS state is incorrect: enabled=%, forced=%', rls_enabled, rls_forced;
    end if;

    select array_agg(policyname order by policyname)
    into actual_policies
    from pg_policies
    where schemaname = 'public'
      and tablename = 'quiz_history';

    if actual_policies is distinct from array[
        'Users can create their own quiz history',
        'Users can delete their own quiz history',
        'Users can view their own quiz history'
    ]::text[] then
        raise exception 'quiz_history RLS policies do not match: %', actual_policies;
    end if;

    if exists (
        select 1
        from pg_policies
        where schemaname = 'public'
          and tablename = 'quiz_history'
          and cmd = 'UPDATE'
    ) then
        raise exception 'quiz_history must not have an UPDATE policy';
    end if;

    if exists (
        select 1
        from pg_policies
        where schemaname = 'public'
          and tablename = 'quiz_history'
          and roles <> array['authenticated']::name[]
    ) then
        raise exception 'quiz_history policies must apply only to authenticated';
    end if;

    if not has_table_privilege('authenticated', 'public.quiz_history', 'SELECT')
       or not has_table_privilege('authenticated', 'public.quiz_history', 'INSERT')
       or not has_table_privilege('authenticated', 'public.quiz_history', 'DELETE')
       or has_table_privilege('authenticated', 'public.quiz_history', 'UPDATE')
       or has_table_privilege('authenticated', 'public.quiz_history', 'TRUNCATE')
       or has_table_privilege('authenticated', 'public.quiz_history', 'REFERENCES')
       or has_table_privilege('authenticated', 'public.quiz_history', 'TRIGGER')
       or has_table_privilege('authenticated', 'public.quiz_history', 'MAINTAIN') then
        raise exception 'authenticated table privileges do not match the application contract';
    end if;

    if has_table_privilege('anon', 'public.quiz_history', 'SELECT')
       or has_table_privilege('anon', 'public.quiz_history', 'INSERT')
       or has_table_privilege('anon', 'public.quiz_history', 'DELETE')
       or has_table_privilege('anon', 'public.quiz_history', 'UPDATE')
       or has_table_privilege('anon', 'public.quiz_history', 'TRUNCATE')
       or has_table_privilege('anon', 'public.quiz_history', 'REFERENCES')
       or has_table_privilege('anon', 'public.quiz_history', 'TRIGGER')
       or has_table_privilege('anon', 'public.quiz_history', 'MAINTAIN') then
        raise exception 'anon must not have direct quiz_history privileges';
    end if;

    select p.prosecdef, p.proconfig
    into function_security_definer, function_config
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'rls_auto_enable'
      and p.pronargs = 0;

    if function_security_definer is not true then
        raise exception 'public.rls_auto_enable() must be SECURITY DEFINER';
    end if;

    if function_config is null
       or not ('search_path=pg_catalog' = any(function_config)) then
        raise exception 'public.rls_auto_enable() must pin search_path to pg_catalog: %', function_config;
    end if;

    if has_function_privilege('authenticated', 'public.rls_auto_enable()', 'EXECUTE')
       or has_function_privilege('anon', 'public.rls_auto_enable()', 'EXECUTE') then
        raise exception 'rls_auto_enable execute privilege is too broad';
    end if;

    select count(*)
    into event_trigger_count
    from pg_event_trigger e
    join pg_proc p on p.oid = e.evtfoid
    join pg_namespace n on n.oid = p.pronamespace
    where e.evtname = 'ensure_rls'
      and e.evtevent = 'ddl_command_end'
      and e.evenabled = 'O'
      and n.nspname = 'public'
      and p.proname = 'rls_auto_enable'
      and e.evttags @> array['CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO']::text[];

    if event_trigger_count <> 1 then
        raise exception 'ensure_rls event trigger is missing or misconfigured';
    end if;

    select count(*)
    into migration_count
    from supabase_migrations.schema_migrations
    where version = any(array[
        '20260824000000',
        '20260825064129',
        '20260827090238',
        '20260830090413',
        '20260830090750'
    ]::text[]);

    if migration_count <> 5 then
        raise exception 'expected migration chain was not fully applied; found % of 5 versions', migration_count;
    end if;

    select col_description(
        'public.quiz_history'::regclass,
        a.attnum
    )
    into document_hash_comment
    from pg_attribute a
    where a.attrelid = 'public.quiz_history'::regclass
      and a.attname = 'document_sha256';

    if document_hash_comment is distinct from
       'SHA-256 of the original PDF bytes used as the stable document identity.' then
        raise exception 'document_sha256 comment does not match: %', document_hash_comment;
    end if;
end
$$;

select 'QuizForge Supabase migration rebuild verified' as result;

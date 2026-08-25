alter table public.quiz_history
add column if not exists document_sha256 text;

create index if not exists quiz_history_user_document_sha256_idx
on public.quiz_history (user_id, document_sha256)
where document_sha256 is not null;

comment on column public.quiz_history.document_sha256 is
  'SHA-256 of the original PDF bytes used as the stable document identity.';

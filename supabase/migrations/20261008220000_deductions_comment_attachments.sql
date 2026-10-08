-- Deduction dispute replies can carry pictures (owner, 2026-10-08: "make me able to upload a picture
-- or more in the dispute reply and it appears to the person I'm replying to").
--
-- ADDITIVE ONLY: one new private bucket, one new table, one storage policy. It touches no existing row.
--
-- WHY A TABLE, NOT A COLUMN: a comment holds zero to four pictures, each with its own name, type and
-- size, and the reader needs to open ONE picture by id through a permission-checked route. A row per
-- picture keeps that a primary-key lookup and lets the comment's own delete cascade clean the index.
--
-- ROLLBACK:
--   drop table public.deductions_comment_attachments;   -- SAFE only while no reply's pictures matter
--   drop policy deductions_comment_attachments_service_role on storage.objects;
--   delete from storage.buckets where id = 'deductions-dispute-attachments';   -- after emptying it
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.

begin;

-- ── 1. The bucket ────────────────────────────────────────────────────────────────────────────────
-- PRIVATE. A dispute picture is evidence about one employee's pay: it is reachable only through
-- /api/deductions/comments/attachments/:id, which checks that the viewer is the employee the
-- deduction belongs to or an admin reader. No caller ever names an object.
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values (
      'deductions-dispute-attachments',
      'deductions-dispute-attachments',
      false,
      5242880,
      array['image/jpeg', 'image/png', 'image/webp']
    )
    on conflict (id) do update
    set public = false,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;
  end if;

  if to_regclass('storage.objects') is not null then
    execute 'drop policy if exists deductions_comment_attachments_service_role on storage.objects';
    execute $policy$
      create policy deductions_comment_attachments_service_role
      on storage.objects
      for all
      to service_role
      using (bucket_id = 'deductions-dispute-attachments')
      with check (bucket_id = 'deductions-dispute-attachments')
    $policy$;
  end if;
end $$;

-- ── 2. The index of pictures ─────────────────────────────────────────────────────────────────────
create table if not exists public.deductions_comment_attachments (
  id            uuid primary key default gen_random_uuid(),
  comment_id    uuid not null references public.deductions_comments (id) on delete cascade,
  candidate_id  uuid not null references public.deductions_candidates (id) on delete cascade,
  storage_path  text not null,
  file_name     text not null,
  content_type  text not null,
  size_bytes    bigint not null,
  created_at    timestamptz not null default now(),
  constraint deductions_comment_attachments_path_key unique (storage_path),
  constraint deductions_comment_attachments_type_check
    check (content_type = any (array['image/jpeg'::text, 'image/png'::text, 'image/webp'::text])),
  constraint deductions_comment_attachments_size_check check (size_bytes > 0 and size_bytes <= 5242880),
  constraint deductions_comment_attachments_name_check check (btrim(file_name) <> '')
);

comment on table public.deductions_comment_attachments is
  'Pictures attached to a deduction dispute reply. Bytes live in the private deductions-dispute-attachments bucket; read only through a permission-checked route, never by a stored URL.';

create index if not exists deductions_comment_attachments_comment_idx
  on public.deductions_comment_attachments (comment_id);
create index if not exists deductions_comment_attachments_candidate_idx
  on public.deductions_comment_attachments (candidate_id);

alter table public.deductions_comment_attachments enable row level security;
drop policy if exists deductions_comment_attachments_service_role_all on public.deductions_comment_attachments;
create policy deductions_comment_attachments_service_role_all
  on public.deductions_comment_attachments for all to service_role
  using (true) with check (true);
revoke all on table public.deductions_comment_attachments from public, anon, authenticated;
grant all on table public.deductions_comment_attachments to service_role;

commit;

-- Verify (catalog, not the ledger):
--   select relname, relrowsecurity from pg_class where relname = 'deductions_comment_attachments';
--   select id, public, file_size_limit, allowed_mime_types from storage.buckets where id = 'deductions-dispute-attachments';

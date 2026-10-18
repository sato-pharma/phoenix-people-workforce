-- ats_whatsapp_cv_archive
--
-- WHAT THIS CHANGES: two NEW tables and one NEW private storage bucket. Nothing existing is read,
-- rewritten or deleted.
--
--   ats_whatsapp_cv_archive        — one row per archived WhatsApp applicant: who they are, what they
--                                    answered on WhatsApp, when the CV came in, and the cabinet folder
--                                    it sat in (WhatsApp line › job title › area). `id` is the id the
--                                    candidate had before the 2026-10-18 clean-up, and `original_row`
--                                    is that candidate row exactly as it was, so a restore loses nothing.
--                                    `extra_answers` is the other screening answers as asked, a list of
--                                    {question, answer} in the order they were asked.
--   ats_whatsapp_cv_archive_files  — the CV files of each archived applicant.
--   storage bucket recruitment-cv-archive — where those files live. A bucket of its own, NOT a folder
--                                    inside `recruitment-files`, so nothing that lists, counts, sweeps
--                                    or cleans the candidates' files can ever reach the Archive.
--
-- WHY (owner, 2026-10-18): the recruitment clean-up deleted every candidate received before Sunday
--   11 October 2026. Of the old WhatsApp CVs, the ones "perfectly sitting in a folder in their place"
--   that "answered most of the questions we need" are kept — "make a folder in each folder called
--   archive … at the end of the day, I want the recruitment module and screening to be clear and
--   clean" — and, asked where that Archive lives, "in Phoenix as well". So they are NOT candidates:
--   no recruitment list, screening page, folder, manager shelf, tile or alert reads these tables.
--   Only the Archive on the WhatsApp Applicants page does.
--
--   No foreign key to ats_candidates on purpose: the candidates these rows came from are deleted.
--
--   Access is decided in TypeScript (the WhatsApp Applicants page's own gate plus candidates:read),
--   never by RLS — the app reads through the service role. RLS is on with a service-role policy only,
--   so the browser roles cannot read a CV list through PostgREST.
--
-- ROLLBACK:
--   -- SAFE: both tables are new in this migration and nothing else depends on them. Dropping them
--   -- loses the Archive rows; the CVs themselves are also in the 2026-10-18 backup zip.
--   drop table if exists public.ats_whatsapp_cv_archive_files;
--   drop table if exists public.ats_whatsapp_cv_archive;
--   (empty the bucket through the Storage API first, then delete it from the dashboard)
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story. This
-- migration reads and rewrites no existing row.

begin;
set local lock_timeout = '5s';

create table if not exists public.ats_whatsapp_cv_archive (
  id uuid primary key,
  full_name text,
  phone text,
  whatsapp text,
  email text,
  job_title text,
  region text,
  area text,
  background text,
  experience text,
  expected_salary text,
  extra_answers jsonb not null default '[]'::jsonb,
  received_at timestamptz not null,
  folder_path text[] not null,
  original_row jsonb not null,
  archived_at timestamptz not null default now(),
  constraint ats_whatsapp_cv_archive_folder_chk check (cardinality(folder_path) between 1 and 6),
  constraint ats_whatsapp_cv_archive_extra_answers_chk check (jsonb_typeof(extra_answers) = 'array')
);

create index if not exists ats_whatsapp_cv_archive_received_idx
  on public.ats_whatsapp_cv_archive (received_at desc);

create table if not exists public.ats_whatsapp_cv_archive_files (
  id uuid primary key,
  archive_id uuid not null references public.ats_whatsapp_cv_archive (id) on delete cascade,
  file_name text not null,
  mime_type text,
  size_bytes bigint,
  content_md5 text,
  storage_path text not null unique,
  received_at timestamptz
);

create index if not exists ats_whatsapp_cv_archive_files_archive_idx
  on public.ats_whatsapp_cv_archive_files (archive_id);

alter table public.ats_whatsapp_cv_archive enable row level security;
drop policy if exists ats_whatsapp_cv_archive_service_role on public.ats_whatsapp_cv_archive;
create policy ats_whatsapp_cv_archive_service_role
  on public.ats_whatsapp_cv_archive for all to service_role using (true) with check (true);
revoke all on table public.ats_whatsapp_cv_archive from public, anon, authenticated;
grant all on table public.ats_whatsapp_cv_archive to service_role;

alter table public.ats_whatsapp_cv_archive_files enable row level security;
drop policy if exists ats_whatsapp_cv_archive_files_service_role on public.ats_whatsapp_cv_archive_files;
create policy ats_whatsapp_cv_archive_files_service_role
  on public.ats_whatsapp_cv_archive_files for all to service_role using (true) with check (true);
revoke all on table public.ats_whatsapp_cv_archive_files from public, anon, authenticated;
grant all on table public.ats_whatsapp_cv_archive_files to service_role;

comment on table public.ats_whatsapp_cv_archive is
  'Old WhatsApp applicants the owner kept when the CVs received before 11 Oct 2026 were cleaned out (2026-10-18). Not candidates: only the Archive on the WhatsApp Applicants page reads it. id = the deleted candidate''s id; original_row = that row as it was.';
comment on table public.ats_whatsapp_cv_archive_files is
  'CV files of ats_whatsapp_cv_archive rows, stored in the private recruitment-cv-archive bucket.';

-- The bucket: private, the same size limit and file types as recruitment-files, service role only.
do $bucket$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values (
      'recruitment-cv-archive',
      'recruitment-cv-archive',
      false,
      10485760,
      array[
        'application/pdf',
        'image/jpeg',
        'image/png',
        'image/webp',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      ]
    )
    on conflict (id) do update
    set public = false,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;
  end if;

  if to_regclass('storage.objects') is not null then
    execute 'drop policy if exists recruitment_cv_archive_service_role on storage.objects';
    execute $policy$
      create policy recruitment_cv_archive_service_role
      on storage.objects
      for all
      to service_role
      using (bucket_id = 'recruitment-cv-archive')
      with check (bucket_id = 'recruitment-cv-archive')
    $policy$;
  end if;
end
$bucket$;

commit;

notify pgrst, 'reload schema';

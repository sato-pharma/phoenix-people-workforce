-- user_error_screens
--
-- WHAT THIS CHANGES:
--   1. A new table public.user_error_screens — one row per screenshot of an error or a block a person
--      met: who (HR id, or the login for a test account), what kind (an error screen was shown, a
--      request was refused, a request failed), the HTTP status, the API call and the page, the words
--      the response carried (≤ 1,000 characters), where the picture sits in storage, its size, the
--      build, and whether it came from a test account.
--   2. A new PRIVATE bucket 'user-error-screens', 1.5 MB per object, image/jpeg and image/webp only.
--   3. system_audit_issues.family may now be 'user_screen' — the family the nightly System Audit
--      detector `user_screens` folds these rows into. Nothing else about the ledger changes.
--
-- WHY:
--   Owner, 23 Oct 2026: "every single type of error or block" a person meets must leave a SCREENSHOT
--   of exactly what they saw, shown AS-IS (no blurring) to the Super Admin only, on the System Audit
--   page, kept 90 days. A block is the person trying to do something and being refused (a visit save,
--   a validation); an error is a request that failed or an error screen that was shown. The browser
--   takes the picture (src/lib/error-monitor/screen-capture.ts) and posts it to /api/errors/screen,
--   which stores the file here and the row in this table. docs/system-audit.md, "What the person saw".
--
-- ACCESS:
--   RLS on, one service_role policy, revoked from public, anon and authenticated — the same shape as
--   the system_audit ledger tables. The bucket is private and only service_role may touch its
--   objects; the Super Admin sees a picture only through /api/admin/system-audit/screens/[id], which
--   runs assertSystemAdministratorWorkspaceAccess before it reads anything.
--
-- RETENTION:
--   90 days, the owner's own decision (23 Oct 2026). The nightly System Audit sweep (04:57 Cairo, no
--   new cron) deletes at most 500 rows a night older than that, each file through the Storage API
--   first and its row after. Not added to phx_prune_retention(): that function holds the three
--   tables he set on 2026-10-04 and a file in storage cannot be removed from SQL
--   (storage.protect_delete refuses a delete on storage.objects).
--
-- SAFE: the only DROP TABLE in this file is the commented-out rollback step below; it drops nothing.
--
-- ROLLBACK:
--   drop table if exists public.user_error_screens;
--   alter table public.system_audit_issues drop constraint if exists system_audit_issues_family_check;
--   alter table public.system_audit_issues add constraint system_audit_issues_family_check check (family in
--     ('app_error', 'reconciliation', 'visit_lifecycle', 'sync_run', 'job_failure', 'data_linkage'));
--   (the second step fails while any 'user_screen' issue exists — those rows are the ledger's history
--   and are never deleted). The bucket and its objects survive a rollback and are removed through the
--   Storage API, never by a delete on storage.objects.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This is neither destructive nor bulk: one new table, one new bucket, one widened CHECK. No existing
-- row is changed.
--
-- READBACK (reads only):
--   select
--     (select relrowsecurity from pg_class where oid = 'public.user_error_screens'::regclass) as locked_table,
--     (select public from storage.buckets where id = 'user-error-screens') as bucket_public,
--     (select file_size_limit from storage.buckets where id = 'user-error-screens') as bucket_limit,
--     (select pg_get_constraintdef(oid) like '%user_screen%' from pg_constraint
--       where conname = 'system_audit_issues_family_check') as family_allowed;
--   locked_table true, bucket_public false, bucket_limit 1572864, family_allowed true.

begin;
set local lock_timeout = '5s';

-- === The screens ================================================================================

create table if not exists public.user_error_screens (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  hr_id text,
  user_id uuid,
  -- The login the picture came from. A test account's session carries the MIRRORED employee's HR id,
  -- so its row is attributed to its own login here and never to that person.
  login_id text,
  role text,
  kind text not null,
  http_status integer,
  method text,
  api_path text,
  page_path text,
  message text,
  storage_path text not null,
  width integer,
  height integer,
  bytes integer,
  release text,
  is_test boolean not null default false,
  constraint user_error_screens_kind_check check (kind in ('error_screen', 'refused_request', 'failed_request')),
  constraint user_error_screens_status_check check (http_status is null or http_status between 100 and 599),
  constraint user_error_screens_method_check check (method is null or char_length(method) <= 10),
  constraint user_error_screens_api_path_check check (api_path is null or char_length(api_path) <= 512),
  constraint user_error_screens_page_path_check check (page_path is null or char_length(page_path) <= 512),
  constraint user_error_screens_message_check check (message is null or char_length(message) <= 1000),
  constraint user_error_screens_storage_path_check check (char_length(storage_path) between 10 and 300),
  constraint user_error_screens_size_check check (
    (width is null or width between 1 and 20000)
    and (height is null or height between 1 and 20000)
    and (bytes is null or bytes between 1 and 1572864))
);

create index if not exists user_error_screens_created_idx
  on public.user_error_screens (created_at desc);
create index if not exists user_error_screens_person_idx
  on public.user_error_screens (hr_id, created_at desc);

alter table public.user_error_screens enable row level security;
drop policy if exists user_error_screens_service_role on public.user_error_screens;
create policy user_error_screens_service_role
  on public.user_error_screens for all to service_role using (true) with check (true);
revoke all on table public.user_error_screens from public, anon, authenticated;
grant select, insert, update, delete on table public.user_error_screens to service_role;

comment on table public.user_error_screens is
  'One screenshot per error or block a person met (owner, 23 Oct 2026). Shown as-is to the Super Admin only, on /admin/system-audit; kept 90 days by the nightly System Audit sweep. Files in the private bucket user-error-screens.';

-- === The ledger family ===========================================================================
-- The nightly detector `user_screens` writes issues of family 'user_screen'. The occurrence table's
-- family column carries no CHECK of its own (it is copied from the issue), so the issue's is the one.

alter table public.system_audit_issues drop constraint if exists system_audit_issues_family_check;
alter table public.system_audit_issues add constraint system_audit_issues_family_check check (family in
  ('app_error', 'reconciliation', 'visit_lifecycle', 'sync_run', 'job_failure', 'data_linkage', 'user_screen'));

-- === The bucket (private, images only, 1.5 MB) ==================================================
-- The browser sends a JPEG of the visible viewport at most 1.2 MB decoded; 1.5 MB leaves room and
-- refuses anything that is not that picture.

do $bucket$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values (
      'user-error-screens',
      'user-error-screens',
      false,
      1572864,
      array['image/jpeg', 'image/webp']
    )
    on conflict (id) do update
    set public = false,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;
  end if;

  if to_regclass('storage.objects') is not null then
    execute 'drop policy if exists user_error_screens_service_role on storage.objects';
    execute $policy$
      create policy user_error_screens_service_role
      on storage.objects
      for all
      to service_role
      using (bucket_id = 'user-error-screens')
      with check (bucket_id = 'user-error-screens')
    $policy$;
  end if;
end
$bucket$;

notify pgrst, 'reload schema';

commit;

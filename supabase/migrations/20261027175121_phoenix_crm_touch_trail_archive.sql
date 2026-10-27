-- ════════════════════════════════════════════════════════════════════════════════════════════════
--  Phoenix CRM — THE TOUCH TRAIL ARCHIVE BUCKET
--
--  Owner, 2026-10-27, after the afternoon database stalls: touches older than 30 days go to gzipped
--  files in private storage, one or more per visit day, and are then deleted from the database. The
--  trail was the biggest table on a 2 GB box (985 MB after 24 days) and nothing ever left it.
--
--  This migration adds ONE private bucket and the service-role policy on it, nothing else: no table,
--  no column, no function, and nothing is deleted here. The nightly job
--  (`app/api/cron/phoenix-crm-touch-trail-archive`, `src/lib/phoenix-crm/server/touch-trail-archive.ts`)
--  writes each file, reads it BACK and checks it, and only then deletes exactly the ids it holds.
--
--  🔴 GOLDEN RULE #1. The bucket is private and only the service role reaches it, the same tier as the
--  table: no signed URL is minted for it and nothing serves from it, so a rep never learns it exists.
--
--  50 MB per object: a file is 20,000 rows, about 1 MB gzipped, so the cap only refuses a runaway.
--
--  ROLLBACK  delete from storage.objects where bucket_id = 'phoenix-crm-touch-trail-archive';  -- only if empty by choice
--            drop policy if exists phoenix_crm_touch_trail_archive_service_role on storage.objects;
--            delete from storage.buckets where id = 'phoenix-crm-touch-trail-archive';
--            (Once a night has run, the files ARE the only copy of those days — never drop them.)
-- ════════════════════════════════════════════════════════════════════════════════════════════════

begin;
set local lock_timeout = '5s';

do $bucket$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values (
      'phoenix-crm-touch-trail-archive',
      'phoenix-crm-touch-trail-archive',
      false,
      52428800,
      array['application/gzip']
    )
    on conflict (id) do update
    set public = false,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;
  end if;

  if to_regclass('storage.objects') is not null then
    execute 'drop policy if exists phoenix_crm_touch_trail_archive_service_role on storage.objects';
    execute $policy$
      create policy phoenix_crm_touch_trail_archive_service_role
      on storage.objects
      for all
      to service_role
      using (bucket_id = 'phoenix-crm-touch-trail-archive')
      with check (bucket_id = 'phoenix-crm-touch-trail-archive')
    $policy$;
  end if;
end
$bucket$;

notify pgrst, 'reload schema';

commit;

-- SAFE: drops public.phoenix_crm_touch_trail on the owner's word (2026-11-01: "retire and delete all its traces").
-- ════════════════════════════════════════════════════════════════════════════════════════════════
--  Phoenix CRM — THE TOUCH TRAIL IS RETIRED
--
--  Owner, 1 November 2026, during the speed root-cause work: "retire and delete all its traces". The
--  trail (owner, 2026-10-03) saved every tap in Phoenix CRM. On 1 November it held 2,834,233 rows and
--  1,229 MB — 26 % of the 4,926 MB production database — had been written 69,207 times since the 14:03
--  restart that day and read never, and every screen change and every 30 s of an open tab cost one
--  more request on a saturated database host.
--
--  THIS DROPS THE TABLE AND THE ARCHIVE POLICY. Nothing depends on the table: no function, view,
--  trigger, foreign key or pg_cron job (checked on production, 2026-11-01 22:20 Cairo); its RLS policy
--  and six indexes go with it. The archive bucket (20261027175121) never held a file: its first night
--  was due on 2 November, and its cron-job.org job is already deleted.
--
--  THE BUCKET IS NOT DELETED HERE. Supabase guards `storage.buckets` with a STATEMENT-level trigger
--  (`protect_buckets_delete` → `storage.protect_delete()`) that raises 42501 "Direct deletion from
--  storage tables is not allowed. Use the Storage API instead." on every `delete`, even one matching
--  no row — this file's first version carried that delete and was refused on staging (staging-migrate
--  run 41345379965) and on production (22:23 Cairo, rolled back whole). The empty bucket was deleted
--  through the Storage API (`DELETE /storage/v1/bucket/phoenix-crm-touch-trail-archive`, HTTP 200
--  "Successfully deleted") on production and on staging at 22:25 Cairo, 1 November 2026, and this
--  file drops only what SQL may drop.
--
--  ORDER OF OPERATIONS, deliberately: the CODE that wrote the table shipped first (#6760, live on
--  production at 22:19 Cairo; the last row was written 22:18:56), and this ran on production by hand
--  once that code was live, off-hours, with the day's backup confirmed — production has no
--  point-in-time recovery, so the 05:35 Cairo backup of 1 November is the one copy of the trail left.
--
--  ROLLBACK  Restore the table from that backup (there is no other copy); 20261003221224 recreates
--            an empty one, and 20261027175121 recreates the bucket and its policy.
-- ════════════════════════════════════════════════════════════════════════════════════════════════

begin;
set local lock_timeout = '5s';

drop table if exists public.phoenix_crm_touch_trail;

do $retire$
begin
  if to_regclass('storage.objects') is not null then
    execute 'drop policy if exists phoenix_crm_touch_trail_archive_service_role on storage.objects';
  end if;
end
$retire$;

notify pgrst, 'reload schema';

commit;

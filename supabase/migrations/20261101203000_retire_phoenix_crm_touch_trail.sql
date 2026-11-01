-- SAFE: drops public.phoenix_crm_touch_trail on the owner's word (2026-11-01: "retire and delete all its traces").
-- ════════════════════════════════════════════════════════════════════════════════════════════════
--  Phoenix CRM — THE TOUCH TRAIL IS RETIRED
--
--  Owner, 1 November 2026, during the speed root-cause work: "retire and delete all its traces". The
--  trail (owner, 2026-10-03) saved every tap in Phoenix CRM. On 1 November it held 2,834,233 rows and
--  1,224 MB — 26 % of the 4,690 MB production database — had been written 4,557 times since 14:03 that
--  day and read never, and every screen change and every 30 s of an open tab cost one more request on
--  a saturated database host.
--
--  THIS DROPS THE TABLE AND REMOVES THE ARCHIVE BUCKET. Nothing depends on the table: no function, view,
--  trigger, foreign key or pg_cron job (checked on production, 2026-11-01); its RLS policy and six
--  indexes go with it. The archive bucket (20261027175121) has never held a file: its first night was
--  due on 2 November, and its cron-job.org job is already deleted.
--
--  ORDER OF OPERATIONS, deliberately: the CODE that wrote the table ships first (route, collector,
--  reader, archive job, all in the same PR), and this runs on production by hand only once that code is
--  LIVE (/api/healthz revision), off-hours, with the day's backup confirmed — production has no
--  point-in-time recovery, so the daily backup is the one copy of the trail left.
--
--  FAIL-CLOSED ON THE BUCKET: `delete from storage.buckets` is refused by the objects foreign key while
--  any file exists, and that failure rolls back the whole transaction — the table drop included.
--
--  ROLLBACK  Restore the table from the day's backup (there is no other copy); 20261003221224 recreates
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
  if to_regclass('storage.buckets') is not null then
    delete from storage.buckets where id = 'phoenix-crm-touch-trail-archive';
  end if;
end
$retire$;

notify pgrst, 'reload schema';

commit;

-- 20261009200001_schedule_marketing_roi_refresh_cron.sql
--
-- WHAT:
--   Schedules the Marketing ROI fact rebuild: pg_cron job `phoenix-marketing-roi-refresh`,
--   `20 * * * *`, `select public.phx_refresh_marketing_roi_facts();`.
--
--   Minute 20 keeps it clear of `phoenix-recovery-snapshot` at minute 5
--   (20261008140000_schedule_recovery_snapshot_cron.sql), so the two hourly jobs never start in
--   the same minute.
--
-- WHY:
--   Owner's decision, 2026-10-09, after the ROI dashboard was switched onto the fact tables
--   (`NEXT_PUBLIC_SMI_USE_FACT_TABLES=true` on the production service that evening). Until then the
--   Sales & Marketing Intelligence dashboard computed live, so staleness was impossible. It now
--   serves `marketing_roi_*_facts`, and `phx_refresh_marketing_roi_facts` was called by nothing on
--   a clock: only a Source-of-Sales import, the normalizer, direct-order tracking and the manual
--   `/api/marketing/roi-refresh` route. Between imports a newly approved campaign, a changed cost
--   or a corrected price would not reach the dashboard at all — the numbers would simply be old,
--   with the payload's own freshness still reading `fresh` because it compares against the last
--   validated batch, not against the clock.
--
-- NOT DOUBLE-RUN:
--   `cron.schedule(name, schedule, command)` UPDATES the job of that name for the same user rather
--   than stacking a second one, so re-applying this migration re-points the same jobid and
--   `cron.job_run_details` keeps its history (that table is keyed by jobid). The block refuses
--   rather than guesses if it ever finds more than one job of that name — two rows under different
--   owners would mean two hourly callers — and re-reads `cron.job` afterwards, so a schedule that
--   did not take fails the migration instead of passing quietly.
--
-- OVERLAP IS ALREADY HANDLED, NOT BY THIS FILE:
--   `phx_refresh_marketing_roi_facts` takes a transaction-level advisory lock on
--   `hashtext('marketing_roi_refresh')` and returns `{"status":"skipped"}` when another run holds
--   it, so an hourly tick that lands while an import-triggered rebuild is running does nothing.
--   Never add a second scheduled caller believing the lock makes it free: each tick still writes a
--   `marketing_roi_refresh_runs` row.
--
--   🔴 A TICK IS RECORDED AS `triggered_by = 'admin_manual'`, because that column is derived from
--   `p_batch_id is null` inside the function and knows nothing about who called. So from tonight
--   the runs table carries hourly `admin_manual` rows that NOBODY ran by hand — do not read one as
--   a person forcing a refresh, and do not "fix" it by giving the cron its own batch id, which
--   would make it rebuild one import's periods instead of all of them.
--
-- WHERE pg_cron IS ABSENT:
--   Guarded on `pg_extension`, so this raises a warning instead of failing. Production and staging
--   both carry pg_cron (staging since 2026-10-08), so both take the live branch today; the guard is
--   for a branch database or a restored clone where the extension is not installed.
--
-- LOCKS: none on application data. `cron.schedule` writes one row in `cron.job`.
--
-- WHAT IT WILL DO ONCE AN HOUR:
--   Rebuild the ROI fact tables for the affected periods — delete and re-insert
--   `marketing_roi_{request,request_geo,trend,line,product,region,distributor,customer}_facts` and
--   append one `marketing_roi_refresh_runs` row. That is exactly what a Source-of-Sales import
--   already triggers; this file changes when it happens, not what it does. No other application
--   table is touched, and the last full run rebuilt 52 request rows across 2026-01..2026-09.
--
-- ROLLBACK:
--   select cron.unschedule('phoenix-marketing-roi-refresh');
--   The fact tables keep whatever the last run wrote; the dashboard then goes back to being as
--   fresh as the last Source-of-Sales import, which is the state this migration exists to end.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This migration reads and writes no application data.

begin;
set local lock_timeout = '5s';

do $do$
declare
  v_named integer;
  v_live  record;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise warning 'pg_cron is not installed here — phx_refresh_marketing_roi_facts() is NOT scheduled on this database, so the ROI fact tables stay as fresh as the last Source-of-Sales import';
    return;
  end if;

  select count(*) into v_named from cron.job where jobname = 'phoenix-marketing-roi-refresh';
  if v_named > 1 then
    raise exception 'found % jobs named phoenix-marketing-roi-refresh — refusing to schedule a third hourly caller; reconcile cron.job by hand first', v_named;
  end if;

  perform cron.schedule(
    'phoenix-marketing-roi-refresh',
    '20 * * * *',
    'select public.phx_refresh_marketing_roi_facts();'
  );

  select jobid, schedule, command, active
    into v_live
    from cron.job
   where jobname = 'phoenix-marketing-roi-refresh';

  if v_live is null then
    raise exception 'cron.schedule(phoenix-marketing-roi-refresh) reported success but cron.job holds no such job';
  end if;

  if v_live.schedule is distinct from '20 * * * *'
     or v_live.command is distinct from 'select public.phx_refresh_marketing_roi_facts();'
     or not v_live.active then
    raise exception 'phoenix-marketing-roi-refresh did not take: jobid=% schedule=% active=% command=%',
      v_live.jobid, v_live.schedule, v_live.active, v_live.command;
  end if;

  raise notice 'phoenix-marketing-roi-refresh is scheduled: jobid=% schedule=%', v_live.jobid, v_live.schedule;
end;
$do$;

commit;

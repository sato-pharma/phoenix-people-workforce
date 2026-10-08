-- 20261008140000_schedule_recovery_snapshot_cron.sql
--
-- WHAT:
--   Puts production's hourly recovery-snapshot schedule into a migration:
--   pg_cron job `phoenix-recovery-snapshot`, `5 * * * *`, `select recovery.take_snapshots();`.
--
--   On production today this is a NO-OP by design — that job already exists with exactly this
--   name, schedule and command (jobid 1, username postgres, active, 206 runs all succeeded as of
--   2026-10-08). The point is not to change anything now; it is that the schedule stops being
--   hand-made state.
--
-- WHY:
--   Audit 2026-10-08. The recovery undo log is what stands in for point-in-time recovery, which
--   production does not have — 7 daily backups are the whole recovery story. Everything about that
--   store was in a migration (`20260929200500_recovery_snapshot_store.sql` and the two after it)
--   EXCEPT the one thing that makes it run. The schedule had been created by hand, so a restored,
--   recreated or region-moved database came back with the store fully deployed and never running:
--   7 protected tables registered, `recovery.take_snapshots()` present and correct, and nothing
--   ever calling it. That is the "looks like protection" state the gate in
--   `scripts/check-schema-shape.ts` exists to catch, and it is exactly what staging reads today.
--
-- NOT DOUBLE-RUN:
--   `cron.schedule(name, schedule, command)` UPDATES the existing job when one of that name
--   already exists for the same user — it does not stack a second one. Production's job is owned by
--   `postgres`, which is also the role that applies migrations here, so re-running this migration
--   re-points the same jobid rather than creating a twin. Verified live after applying: still ONE
--   row named `phoenix-recovery-snapshot`, still jobid 1, and `cron.job_run_details` keeps its
--   history because that table is keyed by jobid.
--
--   The block below refuses rather than guesses if it ever finds more than one job of that name
--   (two rows under different owners would mean two hourly callers), and re-asks `cron.job`
--   afterwards so a schedule that did not take fails the migration instead of passing quietly.
--
-- WHERE pg_cron IS ABSENT (staging):
--   Guarded on `pg_extension`, so this is a warning and not a failure where the extension is not
--   installed — staging has no pg_cron, holds no real payroll, and whether it should run the store
--   at all is a separate decision the owner has not made. The skip is NOT silent: it raises a
--   warning here, and `check-schema-shape.ts` reports `recovery_never_ran` naming pg_cron on any
--   database where every protected table is uncaptured. Migration plus gate is the whole loop —
--   the schedule comes back wherever pg_cron exists, and where it does not, something says so.
--
-- LOCKS: none on application data. `cron.schedule` writes one row in `cron.job`.
--
-- ROLLBACK:
--   select cron.unschedule('phoenix-recovery-snapshot');
--   That stops the hourly capture and leaves every snapshot already taken in place. Do not roll
--   this back on production without replacing the schedule — unscheduled, the undo log silently
--   stops being a recovery path while still looking like one.
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
    raise warning 'pg_cron is not installed here — recovery.take_snapshots() is NOT scheduled on this database, so the undo log is deployed but idle (check-schema-shape.ts reports recovery_never_ran)';
    return;
  end if;

  select count(*) into v_named from cron.job where jobname = 'phoenix-recovery-snapshot';
  if v_named > 1 then
    raise exception 'found % jobs named phoenix-recovery-snapshot — refusing to schedule a third hourly caller; reconcile cron.job by hand first', v_named;
  end if;

  perform cron.schedule(
    'phoenix-recovery-snapshot',
    '5 * * * *',
    'select recovery.take_snapshots();'
  );

  select jobid, schedule, command, active
    into v_live
    from cron.job
   where jobname = 'phoenix-recovery-snapshot';

  if v_live is null then
    raise exception 'cron.schedule(phoenix-recovery-snapshot) reported success but cron.job holds no such job';
  end if;

  if v_live.schedule is distinct from '5 * * * *'
     or v_live.command is distinct from 'select recovery.take_snapshots();'
     or not v_live.active then
    raise exception 'phoenix-recovery-snapshot did not take: jobid=% schedule=% active=% command=%',
      v_live.jobid, v_live.schedule, v_live.active, v_live.command;
  end if;

  raise notice 'phoenix-recovery-snapshot is scheduled: jobid=% schedule=%', v_live.jobid, v_live.schedule;
end;
$do$;

commit;

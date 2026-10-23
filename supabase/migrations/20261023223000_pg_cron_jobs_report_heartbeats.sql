-- The other six pg_cron jobs report to the job heartbeat register too.
--
-- WHY. Read on production 2026-10-23: seven pg_cron jobs, none declared in `JOB_SCHEDULES`, none
-- writing a heartbeat — so any of them could stop and nothing would say so. The first,
-- `crm-agent-crm-ids-reconcile`, was wired in `20261023220000_crm_agent_crm_ids_reconcile_heartbeat.sql`;
-- the owner then chose "Watch all six" in chat the same evening. This does the same for the rest:
--
--   job                                     runs                                    reports as
--   crm-person-by-hr-key-reconcile          crm_person_by_hr_key_reconcile()        phoenix-crm-person-by-hr-key-reconcile
--   phoenix-crm-contact-truth-reconcile     phoenix_crm_contact_truth_reconcile()   phoenix-crm-contact-truth-reconcile
--   phoenix-crm-rep-entry-days-reconcile    phoenix_crm_rep_entry_days_reconcile()  phoenix-crm-rep-entry-days-reconcile
--   phoenix-data-retention                  phx_prune_retention()                   phoenix-data-retention
--   phoenix-marketing-roi-refresh           phx_refresh_marketing_roi_facts()       phoenix-marketing-roi-refresh
--   phoenix-recovery-snapshot               recovery.take_snapshots()               phoenix-recovery-snapshot
--
-- Each job keeps its name, schedule, owner and jobid (so `cron.job_run_details` keeps its history);
-- only its command changes, to a `_run()` wrapper that calls the UNCHANGED function and then records
-- the outcome through `phx_record_job_heartbeat()` (defined in 20261023220000).
--
-- 🔴 THE WRAPPERS DO NOT CATCH. pg_cron runs the command in one transaction, so a heartbeat written
-- there cannot survive a re-raise, and catching to record 'fail' would make `cron.job_run_details`
-- read `succeeded` for a run that failed. Uncaught, a failing run is FAILED there and stranded in the
-- register — both true. `phx_refresh_marketing_roi_facts()` already re-raises after marking its own
-- run row failed, so it fits as is.
--
-- 🔴 THE ONE THAT RECORDS 'fail': `recovery.take_snapshots()` catches per table by design ("one bad
-- table must not lose the run for the other six") and returns the collected message in `error`, so
-- pg_cron reads `succeeded` whatever happened. Recording success there would be a false success, so
-- its wrapper records 'fail' with that message whenever `error` is set. Nothing is caught to do it —
-- the run commits exactly as it always has.
--
-- 🔴 IT NEVER CREATES A JOB. `cron.alter_job` changes the command of a job that exists and does
-- nothing else; a job absent here is left absent with a notice. That matters on staging, which
-- carries no `phoenix-data-retention` by the owner's decision — `cron.schedule` would have created it
-- and started pruning staging's rows. A job running anything other than its known bare command or
-- its wrapper is refused, not overwritten.
--
-- TIMEZONE. pg_cron fires in UTC; `JOB_SCHEDULES` is Africa/Cairo. Five of these are minute-only
-- schedules, the same instants in both. `phoenix-data-retention` is 01:40 UTC — 03:40 Cairo in
-- winter, 04:40 in summer — and is declared `40 3 * * *` with a 2-hour grace: the EARLIER of the two,
-- so the summer run lands an hour inside the grace instead of an hour before the expected fire.

begin;

-- -- The three cache reconciles: each returns how many rows were out of step, and repairs them ------
create or replace function public.crm_person_by_hr_key_reconcile_run()
 returns integer
 language plpgsql volatile security definer set search_path to 'public'
as $function$
declare
  v_diff integer;
begin
  v_diff := public.crm_person_by_hr_key_reconcile();

  perform public.phx_record_job_heartbeat(
    'phoenix-crm-person-by-hr-key-reconcile',
    'success',
    case
      when v_diff > 0 then format('rebuilt: %s row(s) were out of step with _calc()', v_diff)
      else 'in step: 0 differences against _calc()'
    end
  );

  return v_diff;
end
$function$;

create or replace function public.phoenix_crm_contact_truth_reconcile_run()
 returns bigint
 language plpgsql volatile security definer set search_path to 'public'
as $function$
declare
  v_diff bigint;
begin
  v_diff := public.phoenix_crm_contact_truth_reconcile();

  perform public.phx_record_job_heartbeat(
    'phoenix-crm-contact-truth-reconcile',
    'success',
    case
      when v_diff > 0 then format('rebuilt: %s row(s) were out of step with _calc()', v_diff)
      else 'in step: 0 differences against _calc()'
    end
  );

  return v_diff;
end
$function$;

create or replace function public.phoenix_crm_rep_entry_days_reconcile_run()
 returns integer
 language plpgsql volatile security definer set search_path to 'public'
as $function$
declare
  v_diff integer;
begin
  v_diff := public.phoenix_crm_rep_entry_days_reconcile();

  perform public.phx_record_job_heartbeat(
    'phoenix-crm-rep-entry-days-reconcile',
    'success',
    case
      when v_diff > 0 then format('rebuilt: %s row(s) were out of step with _calc()', v_diff)
      else 'in step: 0 differences against _calc()'
    end
  );

  return v_diff;
end
$function$;

-- -- The nightly retention prune -------------------------------------------------------------------
create or replace function public.phx_prune_retention_run()
 returns jsonb
 language plpgsql volatile security definer set search_path to 'public'
as $function$
declare
  v_out jsonb;
begin
  v_out := public.phx_prune_retention();

  perform public.phx_record_job_heartbeat('phoenix-data-retention', 'success', 'pruned: ' || v_out::text);

  return v_out;
end
$function$;

-- -- The hourly Marketing ROI rebuild ---------------------------------------------------------------
-- A 'skipped' result means another rebuild held the advisory lock at that moment: the job ran and
-- did what it is designed to do, so it is a success.
create or replace function public.phx_refresh_marketing_roi_facts_run()
 returns jsonb
 language plpgsql volatile security definer set search_path to 'public'
as $function$
declare
  v_out jsonb;
begin
  v_out := public.phx_refresh_marketing_roi_facts();

  perform public.phx_record_job_heartbeat('phoenix-marketing-roi-refresh', 'success', v_out::text);

  return v_out;
end
$function$;

-- -- The hourly recovery snapshot -------------------------------------------------------------------
create or replace function public.phx_recovery_take_snapshots_run()
 returns jsonb
 language plpgsql volatile security definer set search_path to 'public'
as $function$
declare
  v_out jsonb;
begin
  v_out := recovery.take_snapshots();

  -- take_snapshots() catches per table and reports in `error`; see the header.
  if v_out ->> 'error' is not null then
    perform public.phx_record_job_heartbeat(
      'phoenix-recovery-snapshot', 'fail', 'take_snapshots() reported: ' || (v_out ->> 'error'));
  else
    perform public.phx_record_job_heartbeat('phoenix-recovery-snapshot', 'success', v_out::text);
  end if;

  return v_out;
end
$function$;

revoke execute on function public.crm_person_by_hr_key_reconcile_run() from public, anon, authenticated;
grant execute on function public.crm_person_by_hr_key_reconcile_run() to service_role;
revoke execute on function public.phoenix_crm_contact_truth_reconcile_run() from public, anon, authenticated;
grant execute on function public.phoenix_crm_contact_truth_reconcile_run() to service_role;
revoke execute on function public.phoenix_crm_rep_entry_days_reconcile_run() from public, anon, authenticated;
grant execute on function public.phoenix_crm_rep_entry_days_reconcile_run() to service_role;
revoke execute on function public.phx_prune_retention_run() from public, anon, authenticated;
grant execute on function public.phx_prune_retention_run() to service_role;
revoke execute on function public.phx_refresh_marketing_roi_facts_run() from public, anon, authenticated;
grant execute on function public.phx_refresh_marketing_roi_facts_run() to service_role;
revoke execute on function public.phx_recovery_take_snapshots_run() from public, anon, authenticated;
grant execute on function public.phx_recovery_take_snapshots_run() to service_role;

-- -- Re-point each job that exists here, and only those --------------------------------------------
do $do$
declare
  v_job record;
  v_named integer;
  v_jobid bigint;
  v_command text;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise warning 'pg_cron is not installed here - no job was re-pointed to report a heartbeat';
    return;
  end if;

  for v_job in
    select * from (values
      ('crm-person-by-hr-key-reconcile',
       'select public.crm_person_by_hr_key_reconcile();',
       'select public.crm_person_by_hr_key_reconcile_run();'),
      ('phoenix-crm-contact-truth-reconcile',
       'select public.phoenix_crm_contact_truth_reconcile();',
       'select public.phoenix_crm_contact_truth_reconcile_run();'),
      ('phoenix-crm-rep-entry-days-reconcile',
       'select public.phoenix_crm_rep_entry_days_reconcile();',
       'select public.phoenix_crm_rep_entry_days_reconcile_run();'),
      ('phoenix-data-retention',
       'select public.phx_prune_retention();',
       'select public.phx_prune_retention_run();'),
      ('phoenix-marketing-roi-refresh',
       'select public.phx_refresh_marketing_roi_facts();',
       'select public.phx_refresh_marketing_roi_facts_run();'),
      ('phoenix-recovery-snapshot',
       'select recovery.take_snapshots();',
       'select public.phx_recovery_take_snapshots_run();')
    ) as t(jobname, bare_command, wrapper_command)
  loop
    select count(*), max(jobid) into v_named, v_jobid from cron.job where jobname = v_job.jobname;

    if v_named = 0 then
      raise notice '% is not scheduled here - left alone, never created', v_job.jobname;
      continue;
    end if;
    if v_named > 1 then
      raise exception 'found % jobs named % - refusing to re-point either', v_named, v_job.jobname;
    end if;

    select command into v_command from cron.job where jobid = v_jobid;
    if v_command not in (v_job.bare_command, v_job.wrapper_command) then
      raise exception '% runs %, not the command this migration expects - refusing to replace it', v_job.jobname, v_command;
    end if;

    perform cron.alter_job(job_id := v_jobid, command := v_job.wrapper_command);

    select command into v_command from cron.job where jobid = v_jobid;
    if v_command <> v_job.wrapper_command then
      raise exception '% still runs %, not the reporting wrapper', v_job.jobname, v_command;
    end if;

    raise notice '% now reports to job_heartbeats', v_job.jobname;
  end loop;
end
$do$;

commit;

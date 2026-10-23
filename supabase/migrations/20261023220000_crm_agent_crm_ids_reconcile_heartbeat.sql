-- The departed-agent CRM id cache's 15-minute reconcile now reports to the job heartbeat register.
--
-- WHY. `20261023190000_crm_agent_crm_ids_cache.sql` made `crm_agent_crm_ids_cache` the read behind
-- `phx_crm_agent_crm_ids_for_hr_ids`, and the pg_cron job `crm-agent-crm-ids-reconcile` is the ONLY
-- thing that keeps it current — the cache has no trigger and cannot have one (`crm_visits_unified`
-- has ~10 inputs). The door deliberately never falls back to the live read on an empty or stale
-- cache. So if that job stopped — unscheduled, deactivated, its worker gone, every run raising — the
-- cache would freeze with nothing anywhere saying so: no heartbeat row, no declaration, no alarm.
-- Read on production 2026-10-23: 7 pg_cron jobs, none of them in `JOB_SCHEDULES`.
--
-- WHAT CHANGES.
--   1. `phx_record_job_heartbeat(slug, outcome, detail)` — the SQL twin of `recordJobHeartbeat` in
--      `src/lib/observability/job-heartbeat.ts`: it upserts `public.job_heartbeats` and writes ONLY
--      the timestamp for this outcome, so a failure never erases the last success. Best-effort by
--      the same contract: a failed register write raises a WARNING and never fails the job.
--   2. `crm_agent_crm_ids_reconcile_run()` — runs the UNCHANGED reconcile, then records success with
--      what it found. The reconcile's body is not touched.
--   3. The job is re-pointed at the wrapper. Same name, same `*/15 * * * *`.
--   The slug `phoenix-crm-agent-crm-ids-reconcile` is declared in `JOB_SCHEDULES` and in the
--   docs/observability.md table (in-house only), so the 15-minute sweep judges it like any other job.
--
-- 🔴 WHY THE WRAPPER DOES NOT CATCH A FAILED RUN. pg_cron runs the command in ONE transaction, so a
-- heartbeat written there cannot survive a re-raise, and catching the error to record 'fail' would
-- leave `cron.job_run_details` reading `succeeded` for a run that failed — a false success in the one
-- place a person probes first. Uncaught, a failing run is FAILED in pg_cron (with its message) and
-- STRANDED in the register once its grace passes — both true. Do not "improve" this into a catch.
--
-- TIMEZONE. pg_cron fires in UTC and `JOB_SCHEDULES` is judged in Africa/Cairo. Cairo's offset is a
-- whole number of hours, so `*/15 * * * *` names the same instants in both.

begin;

-- -- 1. The register write, in SQL ------------------------------------------------------------------
create or replace function public.phx_record_job_heartbeat(
  p_slug text,
  p_outcome text,
  p_detail text default null
)
 returns void
 language plpgsql volatile security definer set search_path to 'public'
as $function$
declare
  v_now timestamptz := clock_timestamp();
begin
  begin
    insert into public.job_heartbeats as h
      (slug, last_outcome, last_success_at, last_fail_at, last_detail, updated_at)
    values (
      p_slug,
      p_outcome,
      case when p_outcome = 'success' then v_now end,
      case when p_outcome = 'fail' then v_now end,
      left(p_detail, 2000),
      v_now
    )
    on conflict (slug) do update set
      last_outcome = excluded.last_outcome,
      -- Only the timestamp for THIS outcome moves. The gap between the two is the most useful thing
      -- the table records, and writing both would erase the last success on the first failure.
      last_success_at = case when excluded.last_outcome = 'success' then excluded.last_success_at else h.last_success_at end,
      last_fail_at = case when excluded.last_outcome = 'fail' then excluded.last_fail_at else h.last_fail_at end,
      last_detail = excluded.last_detail,
      updated_at = excluded.updated_at;
  exception when others then
    -- A register write that fails must not turn a working job into a failing one.
    raise warning 'job heartbeat write for % failed (non-fatal - the job''s own result is unaffected): % %',
      p_slug, sqlstate, sqlerrm;
  end;
end
$function$;

revoke execute on function public.phx_record_job_heartbeat(text, text, text) from public, anon, authenticated;
grant execute on function public.phx_record_job_heartbeat(text, text, text) to service_role;

-- -- 2. The reconcile, reporting --------------------------------------------------------------------
create or replace function public.crm_agent_crm_ids_reconcile_run()
 returns integer
 language plpgsql volatile security definer set search_path to 'public'
as $function$
declare
  v_diff integer;
begin
  -- Uncaught on purpose: see the header. A raise here fails the run, and no success is recorded.
  v_diff := public.crm_agent_crm_ids_reconcile();

  perform public.phx_record_job_heartbeat(
    'phoenix-crm-agent-crm-ids-reconcile',
    'success',
    case
      when v_diff > 0 then format('rebuilt: %s row(s) were out of step with _calc()', v_diff)
      else 'in step: 0 differences against _calc()'
    end
  );

  return v_diff;
end
$function$;

revoke execute on function public.crm_agent_crm_ids_reconcile_run() from public, anon, authenticated;
grant execute on function public.crm_agent_crm_ids_reconcile_run() to service_role;

-- -- 3. Re-point the job at the wrapper ---------------------------------------------------------------
-- cron.schedule(name, schedule, command) UPDATES the job of that name for the same owner, so this
-- re-points the one existing job rather than stacking a second caller. Guarded on pg_extension the
-- same way the cache migration is.
do $do$
declare
  v_named integer;
  v_command text;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise warning 'pg_cron is not installed here - crm-agent-crm-ids-reconcile was NOT re-pointed, and nothing refreshes the cache';
    return;
  end if;

  perform cron.schedule(
    'crm-agent-crm-ids-reconcile',
    '*/15 * * * *',
    'select public.crm_agent_crm_ids_reconcile_run();'
  );

  select count(*), max(command) into v_named, v_command
    from cron.job where jobname = 'crm-agent-crm-ids-reconcile';
  if v_named <> 1 then
    raise exception 'expected exactly one cron job named crm-agent-crm-ids-reconcile, found %', v_named;
  end if;
  if v_command <> 'select public.crm_agent_crm_ids_reconcile_run();' then
    raise exception 'crm-agent-crm-ids-reconcile still runs %, not the reporting wrapper', v_command;
  end if;

  raise notice 'crm-agent-crm-ids-reconcile now reports to job_heartbeats every 15 minutes';
end
$do$;

commit;

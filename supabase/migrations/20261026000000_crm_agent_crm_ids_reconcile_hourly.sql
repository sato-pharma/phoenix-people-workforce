-- The departed-agent CRM id reconcile runs hourly, at minute 7, instead of every 15 minutes.
--
-- WHY (2026-10-25 production load audit, in the seven hours after the 16:14 Cairo restart).
-- `crm_agent_crm_ids_reconcile_run()` was the second-heaviest statement on the database: 30 runs,
-- 118 s, a 3.9 s mean and a 9.7 s peak. Each run recomputes `crm_agent_crm_ids_calc()`, a
-- `distinct` over all of crm_visits_unified, to find whether one pair changed. Running it a quarter as
-- often cuts that to about 30 s per seven hours on a 2 GB box that has restarted 11 times in 14 days.
--
-- WHY IT IS SAFE: the cache answers "which CRM ids did these DEPARTED people visit under". A departed
-- person records no new visits, so their pair set is frozen. The only pair a one-hour window can miss
-- belongs to someone whose FIRST EVER visit landed in the last hour, and that person is active, so they
-- are not in the question being asked. See docs/crm-agent-crm-ids-cache.md.
--
-- WHAT IT CHANGES: the schedule only. The command stays the reporting wrapper
-- `crm_agent_crm_ids_reconcile_run()` (20261023220000), and no function body is touched. Minute 7
-- keeps it off the top-of-hour pile-up. pg_cron fires in UTC, and Cairo's whole-hour offset leaves
-- minute 7 the same instant in both.
--
-- ROLLBACK:
--   select cron.schedule('crm-agent-crm-ids-reconcile', '*/15 * * * *',
--     'select public.crm_agent_crm_ids_reconcile_run();');
--   and put JOB_SCHEDULES back to `*/15 * * * *` with a one-hour grace.

-- cron.schedule(name, schedule, command) UPDATES the job of that name for the same owner, so this
-- changes the one existing job rather than stacking a second caller.
do $do$
declare
  v_named integer;
  v_command text;
  v_schedule text;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise warning 'pg_cron is not installed here - crm-agent-crm-ids-reconcile was NOT re-scheduled';
    return;
  end if;

  perform cron.schedule(
    'crm-agent-crm-ids-reconcile',
    '7 * * * *',
    'select public.crm_agent_crm_ids_reconcile_run();'
  );

  select count(*), max(command), max(schedule) into v_named, v_command, v_schedule
    from cron.job where jobname = 'crm-agent-crm-ids-reconcile';
  if v_named <> 1 then
    raise exception 'expected exactly one cron job named crm-agent-crm-ids-reconcile, found %', v_named;
  end if;
  if v_command <> 'select public.crm_agent_crm_ids_reconcile_run();' then
    raise exception 'crm-agent-crm-ids-reconcile runs %, not the reporting wrapper', v_command;
  end if;
  if v_schedule <> '7 * * * *' then
    raise exception 'crm-agent-crm-ids-reconcile is scheduled %, not hourly at minute 7', v_schedule;
  end if;

  raise notice 'crm-agent-crm-ids-reconcile now runs hourly at minute 7';
end
$do$;

-- WHAT: every night, analyze each ordinary `public` table that holds data and has no column
-- statistics, and report the run to the job heartbeat register.
--
-- WHY: `20261024200000_every_table_with_data_and_no_statistics_gets_them.sql` filled the hole once,
-- at apply time. A table created, restored or refilled after that day is planned from the same
-- hard-coded 10-page / 350-row guess until autovacuum reaches it, and a table that stays small never
-- reaches the cluster default of 50 modifications. So the sweep becomes a nightly pg_cron job, and
-- five things in its selection are corrected while it moves:
--
--   * It reads `pg_catalog.pg_statistic`, not the `pg_stats` view. The view hides a table's rows
--     from a role without SELECT on the column, and from one subject to row security on it, so a
--     table that HAS statistics can read as one that has none. Read on production 2026-10-25: the
--     migration role reads `pg_statistic` (9,014 rows), and it owns every `public` table.
--   * It keeps only a table the running role can analyze — `has_table_privilege(..., 'MAINTAIN')`
--     — so ANALYZE never fails on, or silently skips, a table it does not own, and the count it
--     reports is of analyzes that really ran. It also counts how many of those now HAVE statistics.
--   * A table with pages and no live rows is picked up again as soon as it is written to. The
--     sweep's `reltuples <> 0` kept out the nine emptied tables for good: an INSERT does not move
--     `reltuples`, so a refilled one read 0 until autovacuum's 50 modifications. Now
--     `pg_stat_all_tables.n_mod_since_analyze > 0` lets it back in. ANALYZE resets that counter, so
--     a table that is still empty afterwards is not picked up again the next night.
--   * Unlogged tables are swept as well as permanent ones (`relpersistence in ('p', 'u')`):
--     autovacuum treats them alike, so they fall into the same hole. Temporary tables never sit in
--     `public`.
--   * A table ANALYZE can never describe is left out: one with no columns, or with every column at
--     `statistics 0`. It keeps `reltuples <> 0` and no `pg_statistic` row after every ANALYZE, so it
--     would otherwise be analyzed, and counted, every night for ever.
--
-- Locks: every ANALYZE in a run is one transaction (pg_cron's, or this file's in step 4), so each
-- table's SHARE UPDATE EXCLUSIVE lock is held until the run ends. The sweep therefore waits at most
-- 5 seconds for any one lock (`set lock_timeout` on the function, so the setting ends with the
-- call), and a table it cannot lock in time — an autovacuum or CREATE INDEX CONCURRENTLY holding it —
-- is skipped, counted as busy in the heartbeat, and tried again the next night. Nothing else is
-- caught: any other error fails the run.
--
-- `reltuples` is never used as the "has no statistics" signal: ANALYZE is only half-transactional
-- (see 20261024190000), so a rolled-back one leaves a plausible `reltuples` and no statistics.
-- Read on production before this migration: 0 tables match, so tonight's first run analyzes none.
--
-- The job: `phoenix-analyze-tables-without-statistics`, 02:20 UTC (04:20 Cairo in winter, 05:20 in
-- summer — declared in JOB_SCHEDULES at the earlier reading), through a `_run()` wrapper that calls
-- the unchanged function and then records success. The wrapper does not catch: pg_cron runs it in
-- one transaction, so a caught failure would read `succeeded` in `cron.job_run_details`.
-- `cron.schedule` is used because the job is new; it is guarded on pg_extension, and a second apply
-- updates the job of that name rather than adding another.
--
-- ROLLBACK: `select cron.unschedule('phoenix-analyze-tables-without-statistics');`, then
-- `drop function public.phx_analyze_tables_without_statistics_run();` and
-- `drop function public.phx_analyze_tables_without_statistics();`. Statistics already gathered stay,
-- and that is harmless.

begin;

-- -- 1. The sweep -------------------------------------------------------------------------------------
create or replace function public.phx_analyze_tables_without_statistics()
 returns jsonb
 language plpgsql volatile security definer set search_path to 'public' set lock_timeout to '5s'
as $function$
declare
  v_target record;
  v_analyzed integer := 0;
  v_described integer := 0;
  v_busy integer := 0;
begin
  for v_target in
    select c.oid, c.oid::regclass as ident
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      left join pg_catalog.pg_stat_all_tables s on s.relid = c.oid
     where n.nspname = 'public'
       and c.relkind = 'r'
       and c.relpersistence in ('p', 'u')
       and c.relpages > 0
       and (c.reltuples <> 0 or coalesce(s.n_mod_since_analyze, 0) > 0)
       and has_table_privilege(c.oid, 'MAINTAIN')
       and exists (
             select 1
               from pg_catalog.pg_attribute a
              where a.attrelid = c.oid
                and a.attnum > 0
                and not a.attisdropped
                and coalesce(a.attstattarget, -1) <> 0
           )
       and not exists (select 1 from pg_catalog.pg_statistic st where st.starelid = c.oid)
     order by c.relname
  loop
    begin
      execute format('analyze %s', v_target.ident);
    exception when lock_not_available then
      v_busy := v_busy + 1;
      continue;
    end;
    v_analyzed := v_analyzed + 1;
    if exists (select 1 from pg_catalog.pg_statistic st where st.starelid = v_target.oid) then
      v_described := v_described + 1;
    end if;
  end loop;

  return jsonb_build_object('analyzed', v_analyzed, 'described', v_described, 'busy', v_busy);
end
$function$;

revoke execute on function public.phx_analyze_tables_without_statistics() from public, anon, authenticated;
grant execute on function public.phx_analyze_tables_without_statistics() to service_role;

-- -- 2. The sweep, reporting --------------------------------------------------------------------------
create or replace function public.phx_analyze_tables_without_statistics_run()
 returns jsonb
 language plpgsql volatile security definer set search_path to 'public'
as $function$
declare
  v_out jsonb;
begin
  -- Uncaught on purpose: see the header. A raise here fails the run, and no success is recorded.
  v_out := public.phx_analyze_tables_without_statistics();

  perform public.phx_record_job_heartbeat(
    'phoenix-analyze-tables-without-statistics',
    'success',
    format(
      'analyzed %s table(s) that held data with no column statistics; %s of them now carry statistics; %s busy, tried again tomorrow',
      v_out ->> 'analyzed',
      v_out ->> 'described',
      v_out ->> 'busy'
    )
  );

  return v_out;
end
$function$;

revoke execute on function public.phx_analyze_tables_without_statistics_run() from public, anon, authenticated;
grant execute on function public.phx_analyze_tables_without_statistics_run() to service_role;

-- -- 3. The nightly schedule --------------------------------------------------------------------------
do $do$
declare
  v_named integer;
  v_command text;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise warning 'pg_cron is not installed here - phoenix-analyze-tables-without-statistics was NOT scheduled';
    return;
  end if;

  perform cron.schedule(
    'phoenix-analyze-tables-without-statistics',
    '20 2 * * *',
    'select public.phx_analyze_tables_without_statistics_run();'
  );

  select count(*), max(command) into v_named, v_command
    from cron.job where jobname = 'phoenix-analyze-tables-without-statistics';
  if v_named <> 1 then
    raise exception 'expected exactly one cron job named phoenix-analyze-tables-without-statistics, found %', v_named;
  end if;
  if v_command <> 'select public.phx_analyze_tables_without_statistics_run();' then
    raise exception 'phoenix-analyze-tables-without-statistics runs %, not the reporting wrapper', v_command;
  end if;

  raise notice 'phoenix-analyze-tables-without-statistics scheduled nightly at 02:20 UTC';
end
$do$;

-- -- 4. One run now, so the register holds a row before the first night ------------------------------
select public.phx_analyze_tables_without_statistics_run();

commit;

-- Database load, the second pass: the attribution sweep stops reading the whole sales rollup, and
-- four small indexes answer four polled reads that each walked a whole table. NO figure changes.
--
-- WHY (2026-10-25 production load audit, ozucdzovmcqvepbozvqf, the seven hours after the 16:14 Cairo
-- restart; the baseline is docs/perf/2026-10-25-db-load-baseline.md). The box has 2 GB and swaps about
-- 530 MB, so what hurts is pages dragged through memory, not CPU. Each of these re-read a whole table
-- to answer a question about a handful of rows:
--
--   1. au.f_refresh_stale_attribution_periods, the attribution freshness sweep.
--        Its candidate list was `select distinct f.period` over the whole sales rollup joined to the
--        validated batches: 264 ms and 8,353 buffers per call, to find 11 months.
--      -> A skip-scan on the existing period index (source_of_sales_fact_rollup_period_idx): step
--         from one period to the next, one index probe each, then ask each period ONE question, "does
--         a validated batch hold a row of it?", with LIMIT 1. 16 ms and 1,479 buffers.
--         The probe is a LATERAL ... LIMIT 1 on purpose: written as a plain EXISTS, the planner
--         flattened it into a hash semi-join over the whole rollup and it took 264 ms again.
--
--   2. notification_events, withdrawInAppNotificationsByEventKeyPrefix (src/lib/notifications/in-app.ts)
--        `event_key like 'prefix%'`: 96 calls, 92 ms mean, 103,592 blocks read from disk. The one
--        event_key index is the UNIQUE btree under the database's en_US.UTF-8 collation, and a btree
--        under a non-C collation cannot answer a LIKE prefix, so every call read the 37 MB heap.
--      -> notification_events_event_key_pattern_idx (event_key text_pattern_ops).
--
--   3. source_of_sales_customer_map, the Master Map change probe (src/lib/sales/master-map/fingerprint.ts)
--        `active = true order by updated_at desc limit 1`, every five minutes: 92 calls, 54 ms mean.
--        No index has updated_at, so each call sorted all 52,614 rows to keep one.
--      -> sos_customer_map_active_updated_idx (active, updated_at desc). Plain columns, not a partial
--         index: PostgREST binds `true` as a parameter, so a generic plan cannot prove `where active`.
--
--   4. ireports360_visits_sync_runs, the CRM sync's own run log (48,182 rows, growing ~17 an hour)
--        The stale-run reaper (src/lib/crm/sync.ts) `status = 'running' and started_at < $t`:
--          94 calls, 36 ms mean, 22,226 blocks read — a whole-table read to find the 0 or 1 running row.
--        The live poller's deep-run read (readDeepRunMarkers, src/lib/crm/live-poller.ts)
--          `status = 'success' and date_from <= $d order by started_at desc limit 200`: 11.9 ms mean.
--        The only other index is started_at alone.
--      -> ireports360_visits_sync_runs_status_started_idx   (status, started_at)
--         ireports360_visits_sync_runs_status_completed_idx (status, completed_at desc)
--      Measured on production after the build: the reaper 0.1 ms and 2 buffers, the deep-run read
--      1.0 ms and 111 buffers. NOT moved, on purpose: the freshness read (getLatestSuccessfulSyncRunFor,
--      src/lib/crm/admin.ts, 38 calls, 21 ms mean, a fallback only) stays a 10.7 ms sequential scan,
--      because 48,139 of the 48,182 rows are 'success' and the planner rightly reads the heap.
--
-- EXACTNESS. The sweep returns the same months in the same order: on production the old and new
-- candidate queries both returned the 11 periods 2026-01 to 2026-11, with 0 in only one side
-- (2026-10-25). Everything after the candidate list is the 20260929200000 body unchanged: the
-- fingerprint comparison, the published-period exclusion on monthly_closing_publications (never
-- monthly_closing_locks), newest first, the limit, the refresh call and the grants. An index changes
-- no result, only how it is found.
--
-- HOW EACH INDEX REACHES PRODUCTION. CREATE INDEX CONCURRENTLY, run on its own before this file, so
-- no write lock lands on a table the app writes all day. CONCURRENTLY cannot run inside a transaction
-- and migrations do, so the statements below are the plain form guarded by IF NOT EXISTS: a no-op on
-- production once the index is there, and correct for staging and any rebuilt database. The four
-- tables are small (the largest is 37 MB), so even the plain form holds its lock for seconds.
--
-- ROLLBACK:
--   drop index concurrently if exists public.notification_events_event_key_pattern_idx;
--   drop index concurrently if exists public.sos_customer_map_active_updated_idx;
--   drop index concurrently if exists public.ireports360_visits_sync_runs_status_started_idx;
--   drop index concurrently if exists public.ireports360_visits_sync_runs_status_completed_idx;
--   and re-run the au.f_refresh_stale_attribution_periods definition in
--   20260929200000_serialize_attribution_refresh.sql (the `select distinct f.period` candidate list).

create or replace function au.f_refresh_stale_attribution_periods(p_limit integer default 6)
returns setof text
language plpgsql
security definer
set search_path to 'au', 'public'
as $function$
declare
  v_fp text := au.f_attribution_config_fingerprint();
  v_limit integer := greatest(1, least(24, coalesce(p_limit, 6)));
  r record;
begin
  for r in
    select p.period
    from (
      -- Every distinct period, one index probe per step, instead of a DISTINCT over the whole rollup.
      with recursive periods(period) as (
        (
          select f.period
          from public.source_of_sales_fact_rollup f
          where f.period is not null
          order by f.period
          limit 1
        )
        union all
        select (
          select f.period
          from public.source_of_sales_fact_rollup f
          where f.period > periods.period
          order by f.period
          limit 1
        )
        from periods
        where periods.period is not null
      )
      select periods.period
      from periods
      -- Kept only when a VALIDATED batch holds a row of it, which is what the old join asked. LIMIT 1
      -- stops at the first such row; a plain EXISTS is flattened into a semi-join over the whole table.
      cross join lateral (
        select 1
        from public.source_of_sales_fact_rollup f
        join public.source_of_sales_import_batches b on b.id = f.batch_id and b.status = 'validated'
        where f.period = periods.period
        limit 1
      ) validated
      where periods.period is not null
    ) p
    left join au.monthly_attribution_rollup_meta m on m.period = p.period
    where (m.config_fp is null or m.config_fp <> v_fp)
      -- A published period would be refused by f_refresh_monthly_attribution anyway. Excluding it
      -- here means it does not consume a slot and is not reported as refreshed.
      and not exists (
        select 1
        from public.monthly_closing_publications pub
        where pub.period = p.period and pub.unpublished_at is null
      )
    order by p.period desc
    limit v_limit
  loop
    perform au.f_refresh_monthly_attribution(r.period);
    return next r.period;
  end loop;
end;
$function$;

comment on function au.f_refresh_stale_attribution_periods(integer) is
  'Refreshes up to p_limit stale attribution periods, newest first. Published periods are excluded: their rollup is deliberately frozen and never stamped, so before 2026-09-29 they were re-attempted on every call, occupied slots, and were REPORTED as refreshed when nothing happened. Reads monthly_closing_publications, not monthly_closing_locks. Since 2026-10-26 the candidate months come from a skip-scan of the period index with one LIMIT 1 validated-batch probe each (16 ms against 264 ms for the old DISTINCT over the whole rollup).';

revoke execute on function au.f_refresh_stale_attribution_periods(integer) from public, anon, authenticated;
grant  execute on function au.f_refresh_stale_attribution_periods(integer) to service_role;

create index if not exists notification_events_event_key_pattern_idx
  on public.notification_events (event_key text_pattern_ops);

create index if not exists sos_customer_map_active_updated_idx
  on public.source_of_sales_customer_map (active, updated_at desc);

create index if not exists ireports360_visits_sync_runs_status_started_idx
  on public.ireports360_visits_sync_runs (status, started_at);

create index if not exists ireports360_visits_sync_runs_status_completed_idx
  on public.ireports360_visits_sync_runs (status, completed_at desc);

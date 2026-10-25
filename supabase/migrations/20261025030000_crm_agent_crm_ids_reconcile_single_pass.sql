-- crm_agent_crm_ids_reconcile_single_pass
--
-- WHAT THIS CHANGES:
--   public.crm_agent_crm_ids_reconcile() computes crm_agent_crm_ids_calc() ONCE per run instead of
--   two or three times. Same name, same signature, same `returns integer`, same security definer /
--   search_path / grants - so the `_run()` wrapper (20261023220000), the pg_cron job (hourly since 20261026000000) and
--   their heartbeat stay exactly as they are.
--
--   * The pair set _calc() returns (172 rows) is held in a local array, and both EXCEPT arms diff the
--     cache against that array.
--   * On a difference the cache is refilled from the same array, instead of calling
--     crm_agent_crm_ids_rebuild(), which would have run _calc() a third time. The rebuild stays for
--     the backfill and for hand use.
--   * _calc() is still the one body: nothing here reads crm_visits_unified.
--
-- WHY:
--   It was the second-heaviest statement on the production database on 25 Oct 2026, when the 2 GB
--   box had restarted 11 times in 14 days, every one in working hours: 30 runs, 3.9 s mean, 9.7 s
--   max, 164,327 blocks read. EXPLAIN of the old body shows two
--   "Function Scan on crm_agent_crm_ids_calc" nodes - one per EXCEPT arm, because a function with a
--   SET clause is never inlined - so every run paid the ~136,000-row DISTINCT over the union door
--   twice, and three times on a run that rebuilt. The owner chose this on 25 Oct 2026 ("Both": the
--   lighter database load and the manager geography fix).
--
-- SAFE: the only DELETE is `delete from public.crm_agent_crm_ids_cache where true` - the cache's own
-- rows, written by nothing but this reconcile and the rebuild. `where true` is load-bearing: see
-- 20261023154500_crm_cache_rebuilds_need_a_where_clause.sql. Nothing is caught: an error fails the
-- run and the wrapper records no success, the rule the wrapper was built on.

begin;
set local lock_timeout = '5s';

create or replace function public.crm_agent_crm_ids_reconcile()
 returns integer
 language plpgsql volatile security definer set search_path to 'public'
as $function$
declare
  v_truth public.crm_agent_crm_ids_cache[];
  v_diff integer;
begin
  -- The ONE read of the view per run.
  v_truth := array(
    select row(c.agent_hr_id, c.agent_crm_id)::public.crm_agent_crm_ids_cache
      from public.crm_agent_crm_ids_calc() c
  );

  select count(*) into v_diff
    from (
      (select k.agent_hr_id, k.agent_crm_id from public.crm_agent_crm_ids_cache k
        except
       select t.agent_hr_id, t.agent_crm_id from unnest(v_truth) t)
      union all
      (select t.agent_hr_id, t.agent_crm_id from unnest(v_truth) t
        except
       select k.agent_hr_id, k.agent_crm_id from public.crm_agent_crm_ids_cache k)
    ) d;

  if v_diff > 0 then
    delete from public.crm_agent_crm_ids_cache where true;
    insert into public.crm_agent_crm_ids_cache (agent_hr_id, agent_crm_id)
    select t.agent_hr_id, t.agent_crm_id from unnest(v_truth) t;
    raise warning 'crm_agent_crm_ids_cache was % row(s) out of step with _calc() and has been rebuilt', v_diff;
  end if;

  return v_diff;
end
$function$;

revoke execute on function public.crm_agent_crm_ids_reconcile() from public, anon, authenticated;
grant execute on function public.crm_agent_crm_ids_reconcile() to service_role;

commit;

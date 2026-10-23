-- crm_agent_crm_ids_cache
--
-- WHAT THIS CHANGES:
--   The departed-agent CRM exclusion stops scanning ~136,000 visit rows to return 76 numbers.
--
--   * public.crm_agent_crm_ids_calc(p_agent_hr_id) is NEW and holds the ONE body - the
--     `select distinct ... from public.crm_visits_unified v where v.agent_crm_id is not null`
--     that phx_crm_agent_crm_ids_for_hr_ids has carried since 20260914000000, widened by one
--     column (it now returns the PAIR, not just the crm id) and one optional narrowing argument.
--   * public.crm_agent_crm_ids_cache is a NEW table holding that pair set: 254 rows today, keyed
--     (agent_hr_id, agent_crm_id). That primary key IS the read index - the door below is an
--     index-only probe of a 254-row table.
--   * public.phx_crm_agent_crm_ids_for_hr_ids(text[]) now reads the cache. Same name, same
--     signature, same `returns table(agent_crm_id bigint)`, same security definer / search_path /
--     statement_timeout / grants - so src/lib/crm/reads.ts needs no change, and its PGRST202
--     page-walk fallback stays exactly as valid as it was.
--   * public.crm_agent_crm_ids_rebuild() empties and refills the cache THROUGH _calc(), so there
--     is no second copy of the rule, and public.crm_agent_crm_ids_reconcile() compares the two and
--     rebuilds when they differ.
--   * The migration backfills and then REFUSES TO COMMIT on 0 rows or on a single difference.
--
-- WHY:
--   The owner's instruction of 2026-10-23, chosen over leaving it alone: "Cache the 254 pairings".
--
--   Measured on production the same day, live-shaped input (the 108 non-active employees the live
--   tier actually passes, expanded to the real key list):
--
--     before   220 ms, 57,005 shared buffers - Index Scan over ireports360_visits, then a quicksort
--              of 140,616 rows, to return 76 distinct integers
--     after    a 254-row index-only probe
--
--   The row set is the whole cost and it is not the index's fault: the day before, dropping the
--   duplicate `ireports360_visits_agent_idx` (20261023181000) changed the plan to the surviving
--   index and the time did NOT move - 189 ms before the drop, 220 ms after, same shape. The read
--   scans six figures of visit rows because that is what `distinct` over the union door costs, and
--   the answer it produces is 254 pairs that barely change. So the fix is to stop computing it per
--   call, not to index it differently.
--
-- THE 15-MINUTE RECONCILE IS THE STALENESS BOUND HERE, NOT A SAFETY NET.
--   crm_visits_unified draws on ~10 input tables (the iReports360 mirror, Phoenix's own visits and
--   day activities, the team-start and entry-day tables, the person cache), so there is no one
--   table to hang an AFTER STATEMENT trigger on the way crm_person_by_hr_key_cache hangs on
--   `employees`. A pair can therefore be up to 15 minutes old.
--
--   That is safe for THIS read and only because of what it is for: it backs the DEPARTED-agent
--   exclusion (src/lib/crm/reads.ts, scanDepartedAgentCrmIds). A pair enters the set when a rep
--   first records a visit under a CRM id; a departed rep records no new visits, so a departed
--   person's pair set is historical and frozen. The only pair a 15-minute window can miss belongs
--   to someone whose FIRST EVER visit landed in the last 15 minutes - who is, by construction,
--   active and therefore not in the question being asked. Do NOT reuse this cache for a read where
--   a 15-minute-old pair would change the answer without checking that argument again.
--
--   The door does NOT fall back to _calc() when the cache is empty, and must not be "improved" to:
--   a silent fallback would hide the one failure mode that matters (a cache that stopped being
--   rebuilt) behind the slow path it was built to remove, and the same rule already holds for the
--   rep-entry-days cache.
--
-- SAFE: the only DELETE here is `delete from public.crm_agent_crm_ids_cache where true` inside
-- crm_agent_crm_ids_rebuild() - the cache's own rows, written by nothing but this rebuild. `where
-- true` is mandatory, not decoration: PostgREST connects as `authenticator`, which preloads
-- `safeupdate`, and an unqualified DELETE raises "DELETE requires a WHERE clause" there while
-- succeeding every time in a direct SQL session. That divergence cost this repository a candidate's
-- joining form at 13:11:46 Cairo on 2026-10-23 - see
-- 20261023154500_crm_cache_rebuilds_need_a_where_clause.sql.

begin;
set local lock_timeout = '5s';

-- -- 1. The one body ------------------------------------------------------------------------------
-- 20260914000000's scan body, keeping the PAIR. The `agent_hr_id is not null` filter is not a new
-- rule: the door's `v.agent_hr_id = any(p_agent_hr_ids)` already excluded NULL keys, and a NULL
-- agent_hr_id cannot be a primary-key column here.
create or replace function public.crm_agent_crm_ids_calc(p_agent_hr_id text default null)
 returns table(agent_hr_id text, agent_crm_id bigint)
 language sql stable security definer rows 300 set search_path to 'public'
as $function$
  select distinct v.agent_hr_id, v.agent_crm_id
    from public.crm_visits_unified v
   where v.agent_crm_id is not null
     and v.agent_hr_id is not null
     and (p_agent_hr_id is null or v.agent_hr_id = p_agent_hr_id)
$function$;

revoke execute on function public.crm_agent_crm_ids_calc(text) from public, anon, authenticated;
grant execute on function public.crm_agent_crm_ids_calc(text) to service_role;

comment on function public.crm_agent_crm_ids_calc(text) is
  'The one body behind crm_agent_crm_ids_cache: distinct (agent_hr_id, agent_crm_id) pairs in crm_visits_unified. Expensive by nature (~136k rows scanned); callers read the cache, not this.';

-- -- 2. The cache ---------------------------------------------------------------------------------
-- Granted exactly as the door is: service_role only. The primary key is the read path - the door
-- probes it with `agent_hr_id = any(...)` and never leaves the index.
create table if not exists public.crm_agent_crm_ids_cache (
  agent_hr_id  text   not null,
  agent_crm_id bigint not null,
  primary key (agent_hr_id, agent_crm_id)
);

alter table public.crm_agent_crm_ids_cache enable row level security;
revoke all on table public.crm_agent_crm_ids_cache from public, anon, authenticated;
grant select, insert, update, delete on table public.crm_agent_crm_ids_cache to service_role;

comment on table public.crm_agent_crm_ids_cache is
  'Distinct (agent_hr_id, agent_crm_id) pairs from crm_visits_unified - 254 rows. Read by phx_crm_agent_crm_ids_for_hr_ids. Rebuilt through crm_agent_crm_ids_calc() by the 15-minute crm-agent-crm-ids-reconcile job; no trigger is possible, the view has ~10 inputs.';

-- -- 3. The rebuild -------------------------------------------------------------------------------
-- 254 rows, so the whole table is rebuilt rather than one key touched. `where true` is load-bearing
-- (see the SAFE note in the header).
create or replace function public.crm_agent_crm_ids_rebuild()
 returns integer
 language plpgsql volatile security definer set search_path to 'public'
as $function$
declare
  v_rows integer;
begin
  delete from public.crm_agent_crm_ids_cache where true;
  insert into public.crm_agent_crm_ids_cache (agent_hr_id, agent_crm_id)
  select c.agent_hr_id, c.agent_crm_id
    from public.crm_agent_crm_ids_calc() c;
  get diagnostics v_rows = row_count;
  return v_rows;
end
$function$;

revoke execute on function public.crm_agent_crm_ids_rebuild() from public, anon, authenticated;
grant execute on function public.crm_agent_crm_ids_rebuild() to service_role;

-- -- 4. The reconcile -----------------------------------------------------------------------------
-- Compares both ways and repairs. Returns the number of rows that differed. This is the ONLY thing
-- keeping the cache current - read the staleness note in the header before changing its cadence.
create or replace function public.crm_agent_crm_ids_reconcile()
 returns integer
 language plpgsql volatile security definer set search_path to 'public'
as $function$
declare
  v_diff integer;
begin
  select count(*) into v_diff
    from (
      (select * from public.crm_agent_crm_ids_cache
        except
       select * from public.crm_agent_crm_ids_calc())
      union all
      (select * from public.crm_agent_crm_ids_calc()
        except
       select * from public.crm_agent_crm_ids_cache)
    ) d;

  if v_diff > 0 then
    perform public.crm_agent_crm_ids_rebuild();
    raise warning 'crm_agent_crm_ids_cache was % row(s) out of step with _calc() and has been rebuilt', v_diff;
  end if;

  return v_diff;
end
$function$;

revoke execute on function public.crm_agent_crm_ids_reconcile() from public, anon, authenticated;
grant execute on function public.crm_agent_crm_ids_reconcile() to service_role;

-- -- 5. The backfill, and the check that refuses to commit ----------------------------------------
do $do$
declare
  v_rows integer;
  v_diff integer;
begin
  v_rows := public.crm_agent_crm_ids_rebuild();

  select count(*) into v_diff
    from (
      (select * from public.crm_agent_crm_ids_cache
        except
       select * from public.crm_agent_crm_ids_calc())
      union all
      (select * from public.crm_agent_crm_ids_calc()
        except
       select * from public.crm_agent_crm_ids_cache)
    ) d;

  if v_diff <> 0 then
    raise exception 'crm_agent_crm_ids_cache disagrees with _calc() on % row(s) - refusing to commit', v_diff;
  end if;

  if v_rows = 0 then
    raise exception 'crm_agent_crm_ids_cache backfilled 0 rows - refusing to commit';
  end if;

  raise notice 'crm_agent_crm_ids cache backfilled: % row(s), 0 differences against _calc()', v_rows;
end
$do$;

-- -- 6. The 15-minute reconcile schedule -----------------------------------------------------------
-- cron.schedule(name, schedule, command) UPDATES the job of that name for the same owner rather
-- than stacking a second caller, so re-applying this migration re-points one job. Guarded on
-- pg_extension: where pg_cron is absent this raises a warning rather than failing, and the cache is
-- then only as current as the backfill above left it - which is why the warning says so.
do $do$
declare
  v_named integer;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise warning 'pg_cron is not installed here - crm-agent-crm-ids-reconcile was NOT scheduled, so the cache will NOT refresh after this backfill';
    return;
  end if;

  perform cron.schedule(
    'crm-agent-crm-ids-reconcile',
    '*/15 * * * *',
    'select public.crm_agent_crm_ids_reconcile();'
  );

  select count(*) into v_named from cron.job where jobname = 'crm-agent-crm-ids-reconcile';
  if v_named <> 1 then
    raise exception 'expected exactly one cron job named crm-agent-crm-ids-reconcile, found %', v_named;
  end if;

  raise notice 'crm-agent-crm-ids-reconcile scheduled every 15 minutes';
end
$do$;

-- -- 7. The door, reading the cache -----------------------------------------------------------------
-- 20260914000000's function with its FROM swapped for the cache. `distinct` stays: the pair table
-- can hold the same agent_crm_id under two agent_hr_ids (a handed-over CRM slot), and the caller
-- expects a distinct set. Signature, volatility, security, search_path, statement_timeout and the
-- grant pair are unchanged, so reads.ts and its fallback ordering are untouched.
create or replace function public.phx_crm_agent_crm_ids_for_hr_ids(p_agent_hr_ids text[])
returns table(agent_crm_id bigint)
language sql
stable
security definer
set search_path to 'public'
set statement_timeout to '30s'
as $function$
  select distinct c.agent_crm_id
  from public.crm_agent_crm_ids_cache c
  where c.agent_hr_id = any(p_agent_hr_ids)
$function$;

revoke execute on function public.phx_crm_agent_crm_ids_for_hr_ids(text[]) from public, anon, authenticated;
grant execute on function public.phx_crm_agent_crm_ids_for_hr_ids(text[]) to service_role;

comment on function public.phx_crm_agent_crm_ids_for_hr_ids(text[]) is
  'Distinct crm_visits_unified.agent_crm_id values for the given resolved agent_hr_ids, read from crm_agent_crm_ids_cache (rebuilt every 15 minutes). Backs the live departed-agent CRM exclusion in src/lib/crm/reads.ts. Raw scan: applies no exclusion of its own. Does NOT fall back to the live computation - an empty cache must surface, not hide.';

commit;

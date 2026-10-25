-- CRM contact sync: find every rep's CRM account by HR id in ONE statement, on an index.
--
-- WHY (2026-10-25 production load audit, in the seven hours after the 16:14 Cairo restart).
-- `loadCrmContactSyncTargets` (src/lib/crm/contacts-sync.ts), run by the live poller and the
-- crm-contact-lists cron, resolved each active rep's CRM agent id by asking the visits and the
-- plan-entry tables for `agent_hr_id in (50 ids) and agent_crm_id is not null`, chunk by chunk. Plan
-- entries had no agent_hr_id index, so every chunk scanned all 198,723 rows (135 MB): 124 calls at
-- 229 ms mean, 1,825,776 buffers, the heaviest plan-entries read. And each chunk matched about half of
-- those rows, of which PostgREST returned only its first 1,000, so a rep whose rows fell past that cap
-- was resolved from the other table or reported as having no CRM account.
--
-- WHAT IT ADDS
--   1. ireports360_plan_entries (agent_hr_id, agent_crm_id): with the visits index
--      perf_ireports360_visits_agent_hr_id_visit_date_crm, both halves are index-only scans
--      (EXPLAIN cost ~911 against ~17,000 for the scan).
--   2. phx_crm_agent_crm_ids_by_hr(text[]): one jsonb array of [hr_id, agent_crm_id], the HIGHEST
--      agent_crm_id per HR id across both tables, the same "highest id wins" the caller applied row by
--      row. A single jsonb value, not a set, so PostgREST's row cap cannot cut it. SECURITY DEFINER
--      (search_path 'public'), executable by the service role only, as the read was. Until it is
--      applied the caller falls back to its chunked read (PGRST202).
--
-- PRODUCTION got the index with CREATE INDEX CONCURRENTLY, run on its own, so no write lock landed on
-- a table the CRM sync writes to. CONCURRENTLY cannot run in a transaction and migrations do, so the
-- statement below is the plain form behind IF NOT EXISTS: a no-op where the index exists, correct on
-- a rebuilt database. A first attempt, a partial index `ireports360_plan_entries_agent_hr_crm_idx`
-- WHERE agent_crm_id IS NOT NULL, was never usable (the column is NOT NULL, so the planner drops the
-- filter and cannot match the predicate); it was dropped by hand on both databases the same night and
-- no migration ever created it.
--
-- ROLLBACK:
--   drop function if exists public.phx_crm_agent_crm_ids_by_hr(text[]);
--   drop index if exists public.ireports360_plan_entries_agent_hr_id_idx;

create index if not exists ireports360_plan_entries_agent_hr_id_idx
  on public.ireports360_plan_entries (agent_hr_id, agent_crm_id);

create or replace function public.phx_crm_agent_crm_ids_by_hr(p_hr_ids text[])
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce(jsonb_agg(jsonb_build_array(t.agent_hr_id, t.agent_crm_id) order by t.agent_hr_id), '[]'::jsonb)
  from (
    select u.agent_hr_id, max(u.agent_crm_id) as agent_crm_id
    from (
      select v.agent_hr_id, max(v.agent_crm_id) as agent_crm_id
      from public.ireports360_visits v
      where v.agent_hr_id = any(p_hr_ids) and v.agent_crm_id is not null
      group by v.agent_hr_id
      union all
      select p.agent_hr_id, max(p.agent_crm_id) as agent_crm_id
      from public.ireports360_plan_entries p
      where p.agent_hr_id = any(p_hr_ids) and p.agent_crm_id is not null
      group by p.agent_hr_id
    ) u
    group by u.agent_hr_id
  ) t;
$$;

comment on function public.phx_crm_agent_crm_ids_by_hr(text[]) is
  'The highest CRM agent id per HR id across ireports360_visits and ireports360_plan_entries, as one jsonb '
  'array of [hr_id, agent_crm_id]. Read by loadCrmContactSyncTargets (src/lib/crm/contacts-sync.ts). See '
  'supabase/migrations/20261025233000_crm_plan_entries_agent_hr_id_index.sql.';

revoke execute on function public.phx_crm_agent_crm_ids_by_hr(text[]) from public, anon, authenticated;
grant execute on function public.phx_crm_agent_crm_ids_by_hr(text[]) to service_role;

-- The departed-agent CRM exclusion (src/lib/crm/reads.ts scanDepartedAgentCrmIds) collected the
-- DISTINCT agent_crm_id values belonging to departed employees by keyset-paging every matching row
-- of ireports360_visits 2,000 at a time. Measured against production 2026-08-09: 53 departed hr ids
-- expanded to 106 casing keys, matched 15,492 visit rows, and cost 8 sequential round trips /
-- 1,944 ms to produce a set of 23 integers. Every one of those round trips crosses Railway (sfo) to
-- Supabase (eu-central-1), and the scan is unscoped by date on purpose (a departed rep's OLD rows
-- are what mark their crm_id), so the walk grows permanently with every resignation and can never
-- shrink. The whole table is 115,594 rows and only 208 distinct agent_crm_id values exist in it.
--
-- Postgres can answer this in one statement. PostgREST has no DISTINCT, hence an RPC.
--
-- Semantics are byte-identical to the page walk it replaces:
--   * `agent_hr_id = any(...)` is the same case-SENSITIVE exact match PostgREST's `in` produced --
--     the caller still sprays every casing/alias variant via expandHrIdFilterValues().
--   * agent_crm_id IS NOT NULL mirrors the walk's `if (row.agent_crm_id != null)` guard. The column
--     is NOT NULL in production; the guard is kept so a looser clone behaves the same way.
--   * DISTINCT reproduces the Set<number> the walk accumulated. Order is not significant -- the
--     caller sorts the final union.
-- It deliberately does NOT apply the resigned exclusion or the handed-over-slot carve-out: this is
-- the raw scan, and resolveLiveDepartedExclusion() still removes any crm_id an ACTIVE employee now
-- owns after this returns.
--
-- Service-role only, matching every other phx_* read RPC: the app calls it with the service-role
-- key, and anon/authenticated have no business enumerating departed agents. The GRANT comes after
-- the REVOKE on purpose -- revoking from PUBLIC on a default ACL strips service_role too.
create or replace function public.phx_crm_agent_crm_ids_for_hr_ids(p_agent_hr_ids text[])
returns table(agent_crm_id bigint)
language sql
stable
security definer
set search_path to 'public'
set statement_timeout to '30s'
as $function$
  select distinct v.agent_crm_id
  from public.ireports360_visits v
  where v.agent_hr_id = any(p_agent_hr_ids)
    and v.agent_crm_id is not null
$function$;

revoke execute on function public.phx_crm_agent_crm_ids_for_hr_ids(text[]) from public, anon, authenticated;
grant execute on function public.phx_crm_agent_crm_ids_for_hr_ids(text[]) to service_role;

comment on function public.phx_crm_agent_crm_ids_for_hr_ids(text[]) is
  'Distinct ireports360_visits.agent_crm_id values for the given resolved agent_hr_ids. Backs the live departed-agent CRM exclusion in src/lib/crm/reads.ts. Raw scan: applies no exclusion of its own.';

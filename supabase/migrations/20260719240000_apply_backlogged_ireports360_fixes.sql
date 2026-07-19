-- Applies two more backlogged-but-never-executed migrations found in the same audit:
-- 20260714000000_ireports360_visits_unmapped_partial_indexes.sql and
-- 20260717030000_crm_effective_visit_type_view.sql — both committed to main, neither ever applied
-- to production. Confirmed via to_regclass(): the view and both indexes are entirely absent from
-- production.
--
-- Impact of the gap: src/lib/crm/master.ts queries `ireports360_visits_effective` directly for the
-- CRM Master "Regular · No Check-in" tab — on production that tab has been querying a
-- nonexistent relation (hard DB error) since the feature shipped. src/lib/crm/admin.ts's
-- getUnmappedCrmIdentities() keyset-paginates without its supporting partial indexes, which the
-- original migration's own comment says "blew the 8-second Postgres statement timeout in
-- practice" — i.e. the CRM identity-resolution admin flow has been timing out on production.
--
-- One correction versus the original, never-applied view definition: it did not set
-- security_invoker, which is exactly why Supabase's advisor flags this view (confirmed present,
-- staging-only, as `security_definer_view`/ERROR — staging got this migration applied at some
-- point, production never did). Both ireports360_visits and ireports360_checkins have RLS enabled
-- with a real policy each, so a definer-mode view actually would bypass that policy for whoever
-- queries it. Adding `security_invoker = true` (Postgres 15+, this project runs 17) closes that
-- while preserving the exact same columns/logic — the view respects the querying role's own RLS
-- instead of the view owner's.

begin;

create index if not exists ireports360_visits_unmapped_agent_id_idx
  on public.ireports360_visits (id)
  where agent_hr_id is null;

create index if not exists ireports360_visits_unmapped_double_id_idx
  on public.ireports360_visits (id)
  where double_crm_id is not null and double_hr_id is null;

create index if not exists ireports360_checkins_agent_contact_date_idx
  on public.ireports360_checkins (agent_crm_id, contact_crm_id, check_date);

create or replace view public.ireports360_visits_effective
  with (security_invoker = true)
as
select
  v.*,
  ck.has_checkin,
  (v.visit_type = 0 and not ck.has_checkin) as reclassified_no_checkin,
  case when v.visit_type = 0 and not ck.has_checkin then -8 else v.visit_type end as effective_visit_type
from public.ireports360_visits v
cross join lateral (
  select exists (
    select 1
    from public.ireports360_checkins c
    where c.agent_crm_id = v.agent_crm_id
      and c.contact_crm_id = v.contact_crm_id
      and c.check_date >= v.visit_date::timestamp
      and c.check_date <  (v.visit_date + 1)::timestamp
  ) as has_checkin
) ck;

notify pgrst, 'reload schema';

commit;

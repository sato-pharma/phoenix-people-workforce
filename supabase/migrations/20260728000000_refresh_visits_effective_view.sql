-- Recreate ireports360_visits_effective so PostgreSQL recompiles its column list
-- and exposes the crm_contact_grade column added in 20260724160000_crm_contact_grade.sql.
-- PostgreSQL resolves SELECT v.* at view-creation time; the view must be recreated
-- after any new column is added to the underlying table.
--
-- DROP first: the prior view listed has_checkin BEFORE the (later-added) vendor columns, so a bare
-- CREATE OR REPLACE fails with 42P16 "cannot change name of view column has_checkin to crm_region_id"
-- (it cannot reorder existing columns). Dropping first sidesteps that. The view has no dependents.
-- Applied to staging + prod 2026-07-27 (reconcile_visits_effective_view_vstar); this file makes the
-- same definition reproducible on a fresh reset.

drop view if exists public.ireports360_visits_effective;

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
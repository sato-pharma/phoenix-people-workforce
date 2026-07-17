-- Effective visit type for iReports360.
--
-- Business rule (owner, 2026-07-17): a Regular visit (visit_type = 0) with NO matching GPS
-- check-in — same rep + same contact + same day — is not a real in-person regular visit, so it is
-- COUNTED as a Campaign (visit_type -8). The reclassification is ALWAYS surfaced via the
-- `reclassified_no_checkin` flag so it is transparent, never a silent recount.
--
-- The CRM master table's "Regular · No Check-in" tab filters this view on reclassified_no_checkin.
-- Other consumers can read `effective_visit_type` as the single source of the counted type.

create index if not exists ireports360_checkins_agent_contact_date_idx
  on public.ireports360_checkins (agent_crm_id, contact_crm_id, check_date);

create or replace view public.ireports360_visits_effective as
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

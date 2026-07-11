-- loadMirrorVisitsForRange (ireports360-source.ts) fetches a full month of visits from
-- ireports360_visits to build the NSM team calendar compliance matrix. The existing
-- visit_date index (ireports360_visits_visit_date_idx) narrows the scan to the date range,
-- but Postgres still performs a heap fetch for every matching row to project the selected
-- columns — expensive on a ~93k-row table with a wide raw_payload jsonb column per row.
--
-- This covering index adds the projected columns as INCLUDE so Postgres can satisfy the
-- entire query from the index alone (index-only scan), eliminating all heap fetches and
-- bringing the full-month fetch well within the 8-second statement timeout.
--
-- Columns covered match exactly the SELECT in loadMirrorVisitsForRange:
--   agent_crm_id, agent_hr_id, agent_name, ampm, contact_crm_id, contact_name,
--   crm_save_date, double_crm_id, double_hr_id, double_name, visit_type
-- (visit_date is the index key and is already included implicitly.)

create index if not exists ireports360_visits_visit_date_covering_idx
  on public.ireports360_visits (visit_date)
  include (
    agent_crm_id,
    agent_hr_id,
    agent_name,
    ampm,
    contact_crm_id,
    contact_name,
    crm_save_date,
    double_crm_id,
    double_hr_id,
    double_name,
    visit_type
  );
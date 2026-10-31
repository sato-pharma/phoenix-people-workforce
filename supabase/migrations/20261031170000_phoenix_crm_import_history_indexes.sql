-- WHAT: three indexes for the lowercased rep ids the iReports360 history import
--   (public.phoenix_crm_import_ireports360_history, 20261029212200) joins and filters on.
--   1. public.ireports360_visits (lower(agent_hr_id), visit_date) — the join from a rep's seat to his
--      old visits. A one-seat apply scanned all ~146,000 old visits for each seat.
--   2. au.occupancy_history (lower(occupant_canonical_hr_id), effective_from) — the two per-visit checks
--      on public.au_v_seat_occupancy_all ("was he on another rep seat that day", "was he on this seat").
--      The first scanned the whole occupancy table once for every visit.
--   3. public.employees (lower(hr_id)) — the double-visit partner lookup, which scanned every employee
--      once for every visit.
--   The function body does not change. The customer lookup is left alone: its OR already plans as a
--   BitmapOr over phoenix_crm_customers_reference_uidx and phoenix_crm_customers_own_contact_crm_id_key.
-- WHY: on about 69,000 visits each seat's transaction ran far longer than it needed to, and held its
--   locks on phoenix_crm_visits while it did. Account: docs/phoenix-crm-ireports360-history-import.md.
-- ROLLBACK:
--     drop index if exists public.ireports360_visits_agent_hr_lower_date_idx;
--     drop index if exists au.occupancy_history_occupant_lower_from_idx;
--     drop index if exists public.employees_hr_id_lower_idx;
--   Nothing is written to any row.

begin;
set local lock_timeout = '5s';

create index if not exists ireports360_visits_agent_hr_lower_date_idx
  on public.ireports360_visits (lower(agent_hr_id), visit_date);

create index if not exists occupancy_history_occupant_lower_from_idx
  on au.occupancy_history (lower(occupant_canonical_hr_id), effective_from);

create index if not exists employees_hr_id_lower_idx
  on public.employees (lower(hr_id));

commit;

-- Remove two stale "filled"-status medical-rep vacancy rows that leak into the
-- organogram as ghost VACANT cards. The live organogram filter keeps any vacancy whose
-- title classifies as a sales-structure role (open OR not) and lets downstream slot
-- reconciliation decide filled-vs-vacant; these two rows have no matching live employee
-- in their exact area/manager slot, so they render as phantom empty seats:
--   * id 11 — Pedia "Alex Center 2" (area 56): a leftover seat from before the owner
--     collapsed Pedia's "Alex Center 1/2" into a single "Alex Center" (filled by PD-0005).
--   * id 19 — CNS "Port said - Domiat" (area 62): a duplicate of the real filled CNS
--     seat already occupied by CN-0003.
-- Cancelling them (the established reconciliation status) drops them from the chart, so
-- Pedia shows 38 medical-rep seats (not 39) and CNS shows 34 (not 35), matching the
-- owner structure. Idempotent: keyed by stable vacancy_code, fires only while still filled.
update position_vacancies
   set status = 'cancelled',
       note = coalesce(note || E'\n', '') ||
              'Structure reconciliation 2026-07-06: stale filled-but-orphaned duplicate seat leaking as a ghost vacancy card; cancelled.'
 where vacancy_code = 'vacancy_11_sales_pedia_alex_center_2_medical_representative'
   and status = 'filled';

update position_vacancies
   set status = 'cancelled',
       note = coalesce(note || E'\n', '') ||
              'Structure reconciliation 2026-07-06: stale filled-but-orphaned duplicate seat leaking as a ghost vacancy card; cancelled.'
 where vacancy_code = 'vacancy_19_cns_port_said_domiat_medical_representative'
   and status = 'filled';

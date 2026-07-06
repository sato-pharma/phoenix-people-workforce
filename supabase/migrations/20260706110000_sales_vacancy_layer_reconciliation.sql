-- Reconcile the VACANT-seat layer (position_vacancies) of the three sales lines to the
-- owner-confirmed territory structure. The organogram renders both filled seats
-- (employees) and open seats (position_vacancies); the prior migration
-- (20260706100000) reconciled the filled layer, but the open-vacancy layer still had
-- stale duplicates (an open vacancy for a seat that is actually filled) and phantom
-- rows (an open vacancy for an area that isn't part of that line's structure), plus a
-- handful of genuinely-empty structure seats that had no card at all. This migration
-- makes every structure seat appear exactly once.
--
-- All statements are idempotent: closes are keyed by the stable vacancy_code and only
-- fire while the row is still 'open'; the new area + vacancies use ON CONFLICT DO
-- NOTHING and resolve area_id / manager by lookup, so re-running is a no-op.

-- 1) Close stale duplicate open vacancies (seat is actually filled by an active rep).
update position_vacancies
   set status = 'cancelled',
       note = coalesce(note || E'\n', '') ||
              'Structure reconciliation 2026-07-06: seat already filled by an active rep; stale open vacancy cancelled.'
 where vacancy_code = 'VAC-B153-DJW' and status = 'open';   -- Anti Infective Dakahlia 1 (filled by B-40)

update position_vacancies
   set status = 'cancelled',
       note = coalesce(note || E'\n', '') ||
              'Structure reconciliation 2026-07-06: seat already filled by an active rep; stale open vacancy cancelled.'
 where vacancy_code = 'VAC-B168-JPR' and status = 'open';   -- Pedia Alex Center (filled by PD-0005)

update position_vacancies
   set status = 'cancelled',
       note = coalesce(note || E'\n', '') ||
              'Structure reconciliation 2026-07-06: seat already filled by an active rep; stale open vacancy cancelled.'
 where vacancy_code = 'VAC-B114-0B2' and status = 'open';   -- Pedia Dakahlia 2 (filled by B-43)

-- 2) Close phantom open vacancy (area is not part of that line's structure at all).
update position_vacancies
   set status = 'cancelled',
       note = coalesce(note || E'\n', '') ||
              'Structure reconciliation 2026-07-06: area is not part of the CNS structure (CNS has Sharkia 1 & 3 only); phantom vacancy cancelled.'
 where vacancy_code = 'vacancy_18_sales_cns_sharkia_2_medical_representative' and status = 'open';

-- 3) Anti Infective has no line-owned "Heliopolis" area row; create it so its empty
--    Cairo-district Heliopolis seat can be represented on its own line.
insert into areas (line_id, code, name, is_active) values
  (1, 'ai_heliopolis', 'Heliopolis', true)
on conflict do nothing;

-- 4) Open the genuinely-empty structure seats that currently have no card. area_id and
--    manager are resolved by lookup so the insert is environment-robust; each new
--    vacancy nests under the correct (active) district manager.
insert into position_vacancies
  (vacancy_code, department_id, line_id, area_id, position_id, job_title, status, manager_hr_id, region_name, note)
select v.vacancy_code, 1, v.line_id, a.id, 2, 'Medical Representative', 'open', v.manager_hr_id, v.region_name,
       'Structure reconciliation 2026-07-06: opened missing empty structure seat.'
from (values
    ('VAC-STRUCT-AI-HELIOPOLIS-MR', 1, 'ai_heliopolis', 'AI-0001', 'Cairo'),
    ('VAC-STRUCT-AI-SOHAG2-MR',     1, 'sohag_2',       'B-175',   'Upper Egypt'),
    ('VAC-STRUCT-AI-DAKAHLIA4-MR',  1, 'ai_dakahlia_4', 'B-76',    'Delta (2)'),
    ('VAC-STRUCT-PD-DAKAHLIA4-MR',  2, 'dakahlia_4',    'B-5',     'Delta (2)')
  ) as v(vacancy_code, line_id, area_code, manager_hr_id, region_name)
join areas a on a.code = v.area_code and a.line_id = v.line_id
on conflict (vacancy_code) do nothing;

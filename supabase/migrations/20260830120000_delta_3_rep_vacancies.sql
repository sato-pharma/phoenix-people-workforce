-- Anti Infective Delta (3): open the three rep vacancies the district migration missed, and
-- correct the fourth, which was still carrying its pre-move manager and region.
--
-- Owner's instruction, 2026-08-30: recruitment/screening could not offer "Delta (3)" anywhere in
-- the send-to-manager position picker. Root cause traced to `20260828064500_anti_infective_delta_3_district.sql`
-- — that migration opened SEAT-AIF-DM-D3 and reparented all four rep seats (D11, D24, D25, OT2)
-- under it, and its own comment says "the DM seat and all four rep seats are left VACANT on
-- purpose... the owner adds the person, and `phx_hire_into_seat_on_vacancy_filled()` fills the
-- seat from the vacancy" — but it only ever inserted ONE `position_vacancies` row, for the DM
-- seat. Confirmed live 2026-08-30, before this migration:
--
--   SEAT-AIF-DM-D3   (DM)   -> filled by AI-0014 (Samaa Shalaby), legitimate hire, not touched here
--   SEAT-AIF-REP-D11 (REP)  -> vacant, NO position_vacancies row at all
--   SEAT-AIF-REP-D24 (REP)  -> vacant, but its open vacancy is `resignation_B-67_20260515112824`,
--                              opened in May for the OLD Delta (2) placement — manager_hr_id
--                              still B-76 (the old Delta (2) DM), region_name still 'Delta (2)'
--   SEAT-AIF-REP-D25 (REP)  -> vacant, NO position_vacancies row at all
--   SEAT-AIF-REP-OT2 (REP)  -> vacant, NO position_vacancies row at all
--
-- All four seats confirmed vacant (au_v_org_tree.is_vacant = true, occupant_hr_id null) before
-- writing this — never open a vacancy against a seat someone already occupies (the same class of
-- bug as the terminal-vacancy-guard gap tracked separately for issue #2 of this session).
--
-- Precedent followed: the DM vacancy insert in 20260828064500_anti_infective_delta_3_district.sql.

begin;

-- ── 1. Three missing rep vacancies ─────────────────────────────────────────────
-- Manager is AI-0014 (Samaa Shalaby), the seats' actual parent (SEAT-AIF-DM-D3's occupant) —
-- not the vacancy's own predecessor, since none of these three have one.
insert into public.position_vacancies
  (vacancy_code, status, job_title, position_id, line_id, area_id, seat_id,
   region_name, manager_hr_id, manager_name, note)
values
  ('VAC-D3-AIF-D11', 'open', 'Medical Representative', 2, 1,
   (select id from public.areas where code = 'D11'), 'SEAT-AIF-REP-D11',
   'Delta (3)', 'AI-0014', 'Samaa Shalaby',
   'Opened 2026-08-30: the Delta (3) district migration (2026-08-28) left this seat vacant on '
   'purpose but never opened its recruitment vacancy, so it could not be offered in the '
   'screening send-to-manager picker. No predecessor — this seat is new.'),
  ('VAC-D3-AIF-D25', 'open', 'Medical Representative', 2, 1,
   (select id from public.areas where code = 'D25'), 'SEAT-AIF-REP-D25',
   'Delta (3)', 'AI-0014', 'Samaa Shalaby',
   'Opened 2026-08-30: the Delta (3) district migration (2026-08-28) left this seat vacant on '
   'purpose but never opened its recruitment vacancy, so it could not be offered in the '
   'screening send-to-manager picker. No predecessor — this seat is new.'),
  ('VAC-D3-AIF-OT2', 'open', 'Medical Representative', 2, 1,
   (select id from public.areas where code = 'OT2'), 'SEAT-AIF-REP-OT2',
   'Delta (3)', 'AI-0014', 'Samaa Shalaby',
   'Opened 2026-08-30: the Delta (3) district migration (2026-08-28) left this seat vacant on '
   'purpose but never opened its recruitment vacancy, so it could not be offered in the '
   'screening send-to-manager picker. Covers Suez and Ismailia, one rep, per the district '
   'migration; no predecessor — this seat is new.')
on conflict (vacancy_code) do nothing;

-- ── 2. The fourth: fix, don't replace ──────────────────────────────────────────
-- This vacancy already exists and already carries the right AREA (D24 / Sharkia 1 — the seat's
-- area_code never moved, only its region and parent did). Only the manager and region were stale.
update public.position_vacancies
   set manager_hr_id = 'AI-0014',
       manager_name = 'Samaa Shalaby',
       region_name = 'Delta (3)',
       note = note || E'\nCorrected 2026-08-30: manager and region were still Delta (2)/B-76 from '
              'before the seat reparented to Delta (3) on 2026-08-28 — the district migration '
              'moved the seat but never touched this pre-existing vacancy row.'
 where vacancy_code = 'resignation_B-67_20260515112824'
   and seat_id = 'SEAT-AIF-REP-D24'
   and status = 'open';

commit;

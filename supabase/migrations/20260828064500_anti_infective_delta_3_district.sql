-- Anti Infective: open a new district, Delta (3), as a VACANT PLACEHOLDER.
--
-- Owner's instruction, 2026-08-28: a new District Manager position is open in the
-- ANTI INFECTIVE line only, covering Ismailia, Suez, Sharkia and Qalubia.
--
-- SCOPE: anti_infective ONLY. The owner reiterated this explicitly — do NOT touch Pedia or
-- CNS. Every statement below is scoped to the anti_infective line or to AIF-prefixed seats,
-- and the D11/D24/D25/OT2/OT9 rows on cns and pedia are left exactly as they are.
--
-- This hires nobody: the DM seat and all four rep seats are left VACANT on purpose. The owner
-- adds the person, and `phx_hire_into_seat_on_vacancy_filled()` fills the seat from the vacancy.
--
-- Already applied to production (project ozucdzovmcqvepbozvqf) on 2026-08-28, so every
-- statement here is idempotent and this file is the record of what was run.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS FILE DELIBERATELY DOES **NOT** DO: move the territory.
--
-- The five areas — D11 Qalubeya, D24 Sharkia 1, D25 Sharkia 2, OT2 Suez, OT9 Ismailia — STAY
-- where they are for now. They were moved on 2026-08-28 and moved back the same day, on the
-- owner's instruction that the new DM starts 1 September and the AUGUST monthly closing must
-- come out on the old structure, "normally, before the change we made".
--
-- WHY A DATE-STAMPED SWITCH CANNOT DO THIS. `loadLineOperationalRegions`
-- (src/lib/sales/closing-organogram-regions.ts) filters the map with:
--
--     if (from && from > today) return;
--     if (to   && to   < today) return;
--
-- where `today` defaults to the moment the report RUNS — and both call sites in
-- monthly-distributor-import.ts pass only the line code, never the period. So the closing
-- resolves geography as of the RUN DATE, not as of the month being closed. That is the owner's
-- own standing rule (all sales attribute to today's geography, never as-was), and it means
-- effective-dating these rows to 2026-09-01 would STILL pull August onto Delta (3) the moment
-- August is closed in September. Measured 2026-08-28: with the areas moved, July's Anti
-- Infective sales immediately regrouped under Delta (3) — 10 rows, 52 units.
--
-- So the territory move is a DATED ACTION, not a migration: it runs once the August closing is
-- published, and gets its own migration then. Until that moment the organogram shows the plan
-- (a vacant Delta (3) with its four rep chairs) and the closing shows today's reality
-- (D24 under Delta (2), the other four in Others). The two are meant to disagree.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Precedent followed:
--   20260802052000_sos_regions_upper_egypt_split.sql   — adding a region + its public mirror
--   20260803180926_split_gz6_fayoum_beni_suef.sql      — seats for a newly opened territory

begin;

-- ── 1. The region ──────────────────────────────────────────────────────────────
-- carries_target is GENERATED as (not is_other), so it is never inserted.
insert into au.regions (region_code, region_name, is_other, is_active)
values ('D3', 'Delta (3)', false, true)
on conflict (region_code) do nothing;

-- Mirror into the Source-of-Sales region registry, exactly as the UE split did.
insert into public.source_of_sales_regions
  (region_code, region_name, normalized_region_name, description, source_file, source_sheet, active)
values
  ('D3', 'Delta (3)', 'delta (3)',
   'Operational DM territory opened 2026-08-28 for Anti Infective; mirrors au_v_regions.',
   'organogram/au_v_regions', 'au_v_regions', true)
on conflict (region_code) do nothing;

-- Legacy area registry row, referenced by position_vacancies.area_id.
insert into public.areas (code, name, line_id, is_active, description)
values ('delta_3', 'Delta (3)', 1, true,
        'Region-level area for the Delta (3) district, opened 2026-08-28.')
on conflict (code) do nothing;

-- ── 2. Seats ───────────────────────────────────────────────────────────────────
-- The DM seat. Reports to the Anti Infective NSM, like every other AIF district.
insert into au.seats
  (seat_id, seat_tier, line_code, region_code, area_code, parent_seat_id,
   is_other_pseudo_dm, seat_label, is_active, effective_from)
values
  ('SEAT-AIF-DM-D3', 'DM', 'anti_infective', 'D3', null, 'SEAT-AIF-NSM',
   false, 'ANTI_INFECTIVE Delta (3) DM', true, date '2026-08-28')
on conflict (seat_id) do nothing;

-- Three new rep seats. With SEAT-AIF-REP-D24, reparented below, the district opens with the
-- FOUR medical reps the owner specified on 2026-08-28:
--
--   AIF Qalubeya rep         D11
--   AIF Sharkia 1 rep        D24
--   AIF Sharkia 2 rep        D25
--   AIF Suez & Ismailia rep  OT2 + OT9   <- ONE rep covers both governorates
--
-- Suez and Ismailia do NOT get a rep each. One seat serving two areas is an existing, supported
-- shape: SEAT-PED-REP-GZ6 already serves pedia:GZ6 and pedia:UE9 the same way. The seat carries
-- the primary area code (OT2); both areas point at it when the territory move runs.
--
-- Descriptive labels follow the 'AIF Fayoum rep' / 'AIF Beni Suef rep' precedent for
-- governorate-named areas, and the owner's rule that a name beats a raw code.
insert into au.seats
  (seat_id, seat_tier, line_code, region_code, area_code, parent_seat_id,
   is_other_pseudo_dm, seat_label, is_active, effective_from)
values
  ('SEAT-AIF-REP-D11','REP','anti_infective','D3','D11','SEAT-AIF-DM-D3',false,'AIF Qalubeya rep',       true,date '2026-08-28'),
  ('SEAT-AIF-REP-D25','REP','anti_infective','D3','D25','SEAT-AIF-DM-D3',false,'AIF Sharkia 2 rep',      true,date '2026-08-28'),
  ('SEAT-AIF-REP-OT2','REP','anti_infective','D3','OT2','SEAT-AIF-DM-D3',false,'AIF Suez & Ismailia rep',true,date '2026-08-28')
on conflict (seat_id) do nothing;

-- Sharkia 1 already had a rep seat under Delta (2). The SEAT moves now, so the organogram shows
-- the planned district; its AREA does not move until the territory step runs, so the August
-- closing still resolves D24 through Delta (2).
update au.seats
   set region_code = 'D3',
       parent_seat_id = 'SEAT-AIF-DM-D3',
       seat_label = 'AIF Sharkia 1 rep'
 where seat_id = 'SEAT-AIF-REP-D24';

-- ── 3. The vacancy that starts the lifecycle ───────────────────────────────────
-- status 'open'. When it is set to 'filled' with a filled_by_hr_id, the AFTER UPDATE trigger
-- trg_position_vacancies_hire_into_seat calls au.hire_into_seat, which writes the occupancy row.
insert into public.position_vacancies
  (vacancy_code, status, job_title, position_id, line_id, area_id, seat_id,
   region_name, manager_hr_id, manager_name, note)
values
  ('VAC-D3-AIF', 'open', 'District Sales Manager', 1, 1,
   (select id from public.areas where code = 'delta_3'),
   'SEAT-AIF-DM-D3', 'Delta (3)', 'AI-0008', 'Magdy El Senosey',
   'Opened 2026-08-28 on the owner''s instruction: a NEW Anti Infective district, Delta (3), '
   'covering Ismailia, Suez, Sharkia and Qalubia. This is a brand-new seat, not a replacement, '
   'so there is no predecessor to inherit from. Manager is the current occupant of the parent '
   'seat SEAT-AIF-NSM. The incoming DM starts 2026-09-01.')
on conflict (vacancy_code) do nothing;

commit;

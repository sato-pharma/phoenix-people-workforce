-- Anti Infective: open a new district, Delta (3).
--
-- Owner's instruction, 2026-08-28: a new District Manager position is open in the
-- ANTI INFECTIVE line only, covering Ismailia, Suez, Sharkia and Qalubia. This migration
-- builds the placeholder — the region, the seat, the vacancy and the territory. It hires
-- nobody: the DM seat and all five rep seats are left VACANT on purpose. The owner adds
-- the person, and `phx_hire_into_seat_on_vacancy_filled()` fills the seat from the vacancy.
--
-- Already applied by hand to production on 2026-08-28 (project ozucdzovmcqvepbozvqf), so
-- every statement here is idempotent and this file is the record of what was run.
--
-- Precedent followed:
--   20260802052000_sos_regions_upper_egypt_split.sql   — adding a region + its public mirror
--   20260803180926_split_gz6_fayoum_beni_suef.sql      — moving areas between DMs
--
-- Deliberately NOT touched:
--   * au.canonical_areas.code_region_code — the structural code-space region does not move.
--     Only line_area_map.operational_region_code does. (UE-1/UE-2 precedent.)
--   * Any sales row, and any au.monthly_targets row. Targets are keyed by (period, line,
--     area, product) with no region column, so they follow their area with nothing rewritten.
--   * The CNS and Pedia lines. Every change below is scoped to anti_infective.

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

-- Four new rep seats. Descriptive labels follow the 'AIF Fayoum rep' / 'AIF Beni Suef rep'
-- precedent for governorate-named areas, and the owner's rule that a name beats a raw code.
insert into au.seats
  (seat_id, seat_tier, line_code, region_code, area_code, parent_seat_id,
   is_other_pseudo_dm, seat_label, is_active, effective_from)
values
  ('SEAT-AIF-REP-D11','REP','anti_infective','D3','D11','SEAT-AIF-DM-D3',false,'AIF Qalubeya rep', true,date '2026-08-28'),
  ('SEAT-AIF-REP-D25','REP','anti_infective','D3','D25','SEAT-AIF-DM-D3',false,'AIF Sharkia 2 rep',true,date '2026-08-28'),
  ('SEAT-AIF-REP-OT2','REP','anti_infective','D3','OT2','SEAT-AIF-DM-D3',false,'AIF Suez rep',     true,date '2026-08-28'),
  ('SEAT-AIF-REP-OT9','REP','anti_infective','D3','OT9','SEAT-AIF-DM-D3',false,'AIF Ismailia rep', true,date '2026-08-28')
on conflict (seat_id) do nothing;

-- Sharkia 1 already had a rep seat under Delta (2); it follows its area across, and loses
-- the raw area code in its label at the same time.
update au.seats
   set region_code = 'D3',
       parent_seat_id = 'SEAT-AIF-DM-D3',
       seat_label = 'AIF Sharkia 1 rep'
 where seat_id = 'SEAT-AIF-REP-D24';

-- ── 3. Line ➜ area map ─────────────────────────────────────────────────────────
-- The five areas that make up the district. D11/D25 were other_line_specific and OT2/OT9
-- were other_permanent — all four sat in the Others bucket with no DM and no target. D24
-- was already vacant_will_hire under Delta (2).
--
-- carries_target is GENERATED — (area_state in ('occupied','vacant_will_hire')) — so it is
-- never written. Setting vacant_will_hire is what makes these areas target-bearing, and it
-- is the only state the model has for "a real DM owns this and the rep chair is empty".
-- It creates no target: au.monthly_targets stays untouched, so their target is zero until
-- one is uploaded.
--
-- Existing notes carry import tokens (token=QAL-AIF-OT, token=SH-AIF-OT) — appended to, never replaced.
update au.line_area_map m
   set operational_region_code = 'D3',
       dm_seat_id = 'SEAT-AIF-DM-D3',
       area_state = 'vacant_will_hire',
       other_type = null,
       staffed_in_line_code = null,
       rep_seat_id = 'SEAT-AIF-REP-' || m.area_code,
       notes = coalesce(nullif(m.notes, '') || ' | ', '')
               || 'Moved into the new Delta (3) district 2026-08-28'
 where m.line_code = 'anti_infective'
   and m.area_code in ('D11', 'D24', 'D25', 'OT2', 'OT9')
   and m.effective_to is null
   and m.operational_region_code is distinct from 'D3';

-- ── 4. The vacancy that starts the lifecycle ───────────────────────────────────
-- status 'open'. When it is set to 'filled' with a filled_by_hr_id, the AFTER UPDATE trigger
-- trg_position_vacancies_hire_into_seat calls au.hire_into_seat, which writes the occupancy
-- row and flips the district's areas from vacant_will_hire to occupied.
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
   'seat SEAT-AIF-NSM.')
on conflict (vacancy_code) do nothing;

commit;

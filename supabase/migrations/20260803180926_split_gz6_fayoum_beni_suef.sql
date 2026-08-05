-- Split the area "Fayoum-Beni Suef" (GZ6) into two: GZ6 "Fayoum" and a new UE9 "Beni Suef".
--
-- EDITED AFTER APPLY (2026-08-05, owner-approved). The four `effective_from` values below were
-- written as bare `current_date`. Production Postgres runs on UTC, so between Cairo 00:00 and 03:00
-- an unzoned `current_date` resolves to YESTERDAY — the exact drift the Cairo date guard
-- (tests/migrations-cairo-date-guard.test.ts) exists to prevent, and how a wrong hire date and
-- nightly SoS credit drift shipped before.
--
-- The applied production rows are CORRECT and were not touched: this migration ran at Cairo 15:09,
-- far outside that window, so UTC and Cairo agreed on the date. The edit removes the REPLAY risk —
-- a staging rebuild re-running this file after Cairo midnight would have seeded every date a day
-- early. The file now differs from the exact text that ran once in production; that is deliberate,
-- and the difference is strictly a correction.
--
-- WHY. GZ6 is one area holding 16 bricks that span two governorates, and on Anti Infective the two
-- halves belong to different district managers: Fayoum to the Giza DM, Beni Suef to Upper Egypt 2.
-- One area cannot sit in two territories, so the area itself has to split. The owner classified all
-- 16 bricks himself (6 Fayoum, 10 Beni Suef) and answered every open question on 2026-08-03.
--
-- BLOCKS. Bricks do not hang off areas directly — they hang off BLOCKS, and block_code is a global
-- primary key, so a block belongs to exactly one area. Three of GZ6's four blocks are cleanly one
-- side or the other, but B191 ("الوسطى – مدينة بنى سويف – مدينة الفيوم") straddles both:
--
--   B125  4 bricks  all Fayoum       -> stays on GZ6
--   B127  1 brick   all Beni Suef    -> moves to UE9
--   B128  4 bricks  all Beni Suef    -> moves to UE9
--   B191  7 bricks  5 Beni Suef + 2 Fayoum
--
-- So B191's two Fayoum bricks — مدينة الفيوم (B191-3) and طميه (B191-4) — are re-homed into B125,
-- the block that is already entirely Fayoum, and B191 then moves to UE9 intact. Owner's decision
-- 2026-08-03; the alternative was minting a new block code, but the numbering is external (B190,
-- B191, B192 all exist and belong to different areas) so inventing one is not ours to do.
--
-- The bricks then follow their blocks automatically: source_of_sales_bricks_block_hierarchy_fk is
-- ON UPDATE CASCADE, so moving a block's area_code rewrites its bricks' area_code with it. The
-- verification block at the end asserts that actually happened rather than trusting it.
--
-- WHAT MOVES, measured on production before writing this:
--   3,330 source_of_sales_fact_rollup rows and 4,977 source_of_sales_import_rows rows are restated
--   from GZ6 to UE9 — 5,915,286.92 EGP re-labelled across Anti Infective, CNS, Pedia and Head
--   Office. Only ANTI INFECTIVE changes which REGION the money lands in; CNS stays Others, Pedia
--   stays Giza and Head Office (no organogram) stays Giza. History does NOT re-cut itself:
--   phx_monthly_closing_matrix reads the area_code stored on the rollup rather than resolving it
--   through the brick master, so the stored values have to be restated here or every past month
--   keeps showing Beni Suef under Fayoum.
--
-- The import rows are restated for a second reason: loadMonthlyClosingDetails resolves an area
-- THROUGH the brick, then flags "sheet area != brick's area". Moving the bricks without moving the
-- rows would raise that flag on all 4,977 of them.
--
-- IMS. The area carries ims_ratio 0.0258 and the model requires every active non-OT area to sum to
-- exactly 0.9503 (see src/lib/sales/ims-ratio.ts and tests/sales-ims-ratio.test.ts). The ratio is
-- therefore SPLIT, never copied: 0.0097 to Fayoum and 0.0161 to Beni Suef, which add back to 0.0258
-- exactly. Owner-approved 2026-08-03, apportioned by brick count (6:10) as a stand-in until the IMS
-- audit gives a real figure for each governorate. Changing it later is a one-row update.
--
-- REVERSIBILITY. Every table this touches is backed up first into au.bak_20260803_gz6_* and the
-- verification block at the end asserts the counts and the IMS invariant. To roll back, restore
-- from those tables and drop UE9.

begin;

-- The 10 bricks the owner classified as Beni Suef. Everything below keys off this list.
create temporary table _beni_suef_bricks (brick_id text primary key) on commit drop;
insert into _beni_suef_bricks (brick_id) values
  ('B127-66'), -- بليفيا
  ('B128-2'),  -- الفشن
  ('B128-34'), -- دشطوط
  ('B128-4'),  -- إهناسيا
  ('B128-M1'), -- بوش
  ('B191-1'),  -- الوسطى
  ('B191-2'),  -- مدينة بنى سويف
  ('B191-5'),  -- مركز ناصر
  ('B191-6'),  -- بيبا
  ('B191-7');  -- سامستا
-- The other 6 stay on GZ6 and become Fayoum:
--   B125-10 سنورس - فيوم · B125-12 إطسا · B125-13 إبشواى · B125-M1 سنهور
--   B191-3 مدينة الفيوم · B191-4 طميه   (these two are re-homed from block B191 into B125)

-- ── Guards: refuse to run twice, or on a shape this migration was not written against ──
do $$
begin
  if exists (select 1 from public.source_of_sales_areas where area_code = 'UE9') then
    raise exception 'UE9 already exists — this migration has already run';
  end if;
  if (select count(*) from public.source_of_sales_bricks where area_code = 'GZ6' and active) <> 16 then
    raise exception 'Expected 16 active bricks on GZ6, found %',
      (select count(*) from public.source_of_sales_bricks where area_code = 'GZ6' and active);
  end if;
  if (select round(ims_ratio, 4) from public.source_of_sales_areas where area_code = 'GZ6') <> 0.0258 then
    raise exception 'GZ6 ims_ratio is no longer 0.0258 — re-derive the split before running';
  end if;
  if (select count(*) from public.source_of_sales_blocks where area_code = 'GZ6') <> 4 then
    raise exception 'Expected 4 blocks on GZ6, found %',
      (select count(*) from public.source_of_sales_blocks where area_code = 'GZ6');
  end if;
end $$;

-- ── Backups ──
create table au.bak_20260803_gz6_areas as
  select * from public.source_of_sales_areas where area_code in ('GZ6', 'UE9');
create table au.bak_20260803_gz6_blocks as
  select * from public.source_of_sales_blocks where area_code = 'GZ6';
create table au.bak_20260803_gz6_bricks as
  select * from public.source_of_sales_bricks where area_code = 'GZ6';
create table au.bak_20260803_gz6_line_area_map as
  select * from au.line_area_map where area_code = 'GZ6';
create table au.bak_20260803_gz6_targets as
  select * from au.monthly_targets where area_code = 'GZ6';
create table au.bak_20260803_gz6_direct_alloc as
  select * from au.direct_region_allocation where line_code = 'anti_infective' and sos_region_code = 'UE';
create table au.bak_20260803_gz6_rollup as
  select * from public.source_of_sales_fact_rollup
  where brick_id in (select brick_id from _beni_suef_bricks);
create table au.bak_20260803_gz6_import_rows as
  select * from public.source_of_sales_import_rows
  where brick_id in (select brick_id from _beni_suef_bricks)
     or brick_id in ('B191-3', 'B191-4');

-- ── 1. Area master ──
update public.source_of_sales_areas
   set area_name = 'Fayoum',
       normalized_area_name = 'fayoum',
       ims_ratio = 0.0097,
       updated_at = now()
 where area_code = 'GZ6';

insert into public.source_of_sales_areas
  (area_code, region_code, area_name, normalized_area_name, description, active, ims_ratio)
select 'UE9', region_code, 'Beni Suef', 'beni suef',
       'Split out of GZ6 Fayoum-Beni Suef on 2026-08-03', active, 0.0161
  from public.source_of_sales_areas
 where area_code = 'GZ6';

-- ── 2. Canonical area model ──
update au.canonical_areas set area_name = 'Fayoum' where area_code = 'GZ6';

insert into au.canonical_areas (area_code, area_name, code_region_code, is_permanent_other, sort_order, is_active)
select 'UE9', 'Beni Suef', code_region_code, false,
       (select coalesce(max(sort_order), 0) + 1 from au.canonical_areas), true
  from au.canonical_areas
 where area_code = 'GZ6';

-- ── 3. Re-home B191's two Fayoum bricks into the all-Fayoum block ──
-- Same area and region, so the hierarchy FK is satisfied throughout.
update public.source_of_sales_bricks
   set block_code = 'B125'
 where brick_id in ('B191-3', 'B191-4');

update public.source_of_sales_blocks
   set description = 'إطسا – سنهور – سنورس – مدينة الفيوم – طميه',
       updated_at = now()
 where block_code = 'B125';

update public.source_of_sales_blocks
   set description = 'الوسطى – مدينة بنى سويف',
       master_brick_id = 'B191-2',
       updated_at = now()
 where block_code = 'B191';

-- ── 4. Move the Beni Suef blocks to the new area ──
-- The bricks follow via ON UPDATE CASCADE on source_of_sales_bricks_block_hierarchy_fk.
update public.source_of_sales_blocks
   set area_code = 'UE9',
       updated_at = now()
 where block_code in ('B127', 'B128', 'B191');

-- ── 5. Seats ──
-- Fayoum moves to Giza, so its rep now reports to the Giza DM instead of the Upper Egypt 1 DM.
update au.seats
   set region_code = 'GZ',
       parent_seat_id = 'SEAT-AIF-DM-GZ',
       seat_label = 'AIF Fayoum rep'
 where seat_id = 'SEAT-AIF-REP-GZ6';

-- Beni Suef gets its OWN Anti Infective rep seat (owner's decision) — vacant until he hires.
insert into au.seats
  (seat_id, seat_tier, line_code, region_code, area_code, parent_seat_id,
   is_other_pseudo_dm, seat_label, is_active, effective_from)
values
  ('SEAT-AIF-REP-UE9', 'REP', 'anti_infective', 'UE-2', 'UE9', 'SEAT-AIF-DM-UE-2',
   false, 'AIF Beni Suef rep', true, (now() at time zone 'Africa/Cairo')::date);
-- On Pedia the two halves stay ONE territory, so no new seat there — UE9 reuses SEAT-PED-REP-GZ6.
-- On CNS the area has no rep at all and sits under SEAT-CNS-OTHERS.

-- ── 6. Line ➜ area map ──
update au.line_area_map
   set operational_region_code = 'GZ',
       dm_seat_id = 'SEAT-AIF-DM-GZ'
 where line_code = 'anti_infective' and area_code = 'GZ6';

-- carries_target is a GENERATED column — (area_state in ('occupied','vacant_will_hire')) — so it is
-- never inserted; area_state decides it. That lands exactly where the owner asked: Anti Infective
-- (vacant_will_hire) and Pedia (occupied) carry a target, CNS (other_line_specific) does not.
insert into au.line_area_map
  (line_code, area_code, operational_region_code, area_state, dm_seat_id, rep_seat_id,
   other_type, staffed_in_line_code, effective_from, notes)
values
  ('anti_infective', 'UE9', 'UE-2', 'vacant_will_hire', 'SEAT-AIF-DM-UE-2', 'SEAT-AIF-REP-UE9',
   null, null, (now() at time zone 'Africa/Cairo')::date, 'Split out of GZ6 on 2026-08-03'),
  ('cns', 'UE9', 'OT', 'other_line_specific', 'SEAT-CNS-OTHERS', null,
   null, null, (now() at time zone 'Africa/Cairo')::date, 'Split out of GZ6 on 2026-08-03'),
  ('pedia', 'UE9', 'GZ', 'occupied', 'SEAT-PED-DM-GZ', 'SEAT-PED-REP-GZ6',
   null, null, (now() at time zone 'Africa/Cairo')::date, 'Split out of GZ6 on 2026-08-03; one rep covers both halves');

-- ── 7. Targets ──
-- The owner put July's Anti Infective targets entirely on Beni Suef.
update au.monthly_targets
   set area_code = 'UE9'
 where area_code = 'GZ6' and line_code = 'anti_infective' and period = '2026-07';

-- ── 8. Direct allocation weights ──
-- These weights are area counts. UE-1 loses Fayoum-Beni Suef altogether (3 areas -> 2) and UE-2
-- gains Beni Suef (6 -> 7). Only used when a Direct row's submitting manager cannot be resolved.
update au.direct_region_allocation
   set weight = 2,
       note = 'Minia 1, Minia 2 — 2 areas (Nosiba Salah)',
       updated_at = now()
 where line_code = 'anti_infective' and sos_region_code = 'UE' and target_region_code = 'UE-1';

update au.direct_region_allocation
   set weight = 7,
       note = 'Assuit 1/2, Sohag 1/2, Qena 1/2, Beni Suef — 7 areas (Ahmed Nashaat Ali)',
       updated_at = now()
 where line_code = 'anti_infective' and sos_region_code = 'UE' and target_region_code = 'UE-2';

-- ── 9. Restate history ──
update public.source_of_sales_fact_rollup
   set area_code = 'UE9'
 where brick_id in (select brick_id from _beni_suef_bricks);

update public.source_of_sales_import_rows
   set area_code = 'UE9'
 where brick_id in (select brick_id from _beni_suef_bricks);

-- The two re-homed bricks keep their area but change block, so their history says so too.
update public.source_of_sales_import_rows
   set block_code = 'B125'
 where brick_id in ('B191-3', 'B191-4');

-- ── 10. Verify before committing ──
do $$
declare
  v_fayoum_bricks int;
  v_beni_bricks int;
  v_rollup int;
  v_import int;
  v_non_ot numeric;
  v_areas int;
  v_blocks int;
begin
  select count(*) into v_fayoum_bricks from public.source_of_sales_bricks where area_code = 'GZ6' and active;
  select count(*) into v_beni_bricks from public.source_of_sales_bricks where area_code = 'UE9' and active;
  if v_fayoum_bricks <> 6 or v_beni_bricks <> 10 then
    raise exception 'Brick split wrong: Fayoum %, Beni Suef % (expected 6 / 10)', v_fayoum_bricks, v_beni_bricks;
  end if;

  -- Every Beni Suef brick must actually be one of the ten the owner classified.
  if exists (
    select 1 from public.source_of_sales_bricks
     where area_code = 'UE9' and brick_id not in (select brick_id from _beni_suef_bricks)
  ) then
    raise exception 'A brick landed on Beni Suef that the owner did not classify as Beni Suef';
  end if;

  select count(*) into v_blocks from public.source_of_sales_blocks where area_code = 'UE9';
  if v_blocks <> 3 then raise exception 'Expected 3 blocks on UE9, got %', v_blocks; end if;

  -- The generated carries_target must have landed on the owner's answers.
  if (select count(*) from au.line_area_map
       where area_code = 'UE9'
         and carries_target <> (line_code in ('anti_infective', 'pedia'))) <> 0 then
    raise exception 'carries_target did not derive as expected for UE9';
  end if;

  -- Asserted as "nothing left behind" rather than an exact count, so a batch uploaded between
  -- measuring this and running it does not abort a correct migration.
  select count(*) into v_rollup from public.source_of_sales_fact_rollup
   where brick_id in (select brick_id from _beni_suef_bricks) and area_code <> 'UE9';
  select count(*) into v_import from public.source_of_sales_import_rows
   where brick_id in (select brick_id from _beni_suef_bricks) and area_code <> 'UE9';
  if v_rollup <> 0 or v_import <> 0 then
    raise exception 'Rows left on the old area: % rollup, % import', v_rollup, v_import;
  end if;

  -- The invariant the IMS model is built on: active non-OT areas must still total 0.9503.
  select count(*), round(sum(ims_ratio), 6) into v_areas, v_non_ot
    from public.source_of_sales_areas where active and region_code <> 'OT';
  if v_non_ot <> 0.9503 then
    raise exception 'IMS non-OT total is % across % areas, expected 0.950300', v_non_ot, v_areas;
  end if;

  raise notice 'GZ6 split OK — Fayoum % bricks, Beni Suef % bricks / % blocks, IMS % across % areas',
    v_fayoum_bricks, v_beni_bricks, v_blocks, v_non_ot, v_areas;
end $$;

commit;

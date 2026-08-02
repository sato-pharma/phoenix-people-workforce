-- Split area GZ6 "Fayoum-Beni Suef" into two areas: GZ8 "Fayoum" and GZ9 "Beni Suef".
--
-- WHY. The owner's rule (2026-08-02) is per-LINE: "only in Anti Infective, Fayoum belongs to GZ
-- and Beni Suef belongs to UE-1; in other lines these areas belong to GZ". GZ6 is ONE area
-- spanning TWO governorates, so that rule was not expressible. au.sos_area_crosswalk.brick_scope
-- looks like the hook for it but is `check (brick_scope in ('all','specific'))` with no brick-list
-- column anywhere -- all 49 rows are 'all'. Splitting the master geography is the only way.
--
-- SHAPE OF THE SPLIT. A brick inherits its area THROUGH its block
-- (source_of_sales_bricks -> source_of_sales_blocks on (block_code, area_code, region_code)), and a
-- block belongs to exactly one area. Block B191 is genuinely mixed, so it is split: its two Fayoum
-- bricks move to a NEW block B221 and B191 keeps the five Beni Suef bricks. The other three blocks
-- move whole. All three hierarchy FKs are ON UPDATE CASCADE, so repointing a block carries its
-- bricks automatically.
--
--   GZ8 Fayoum    (6 bricks)  B125 whole + new B221 (B191-3 مدينة الفيوم, B191-4 طميه)
--   GZ9 Beni Suef (10 bricks) B127 whole + B128 whole + B191 remainder
--
-- Brick classification confirmed by the owner against Master of Master.xlsx on 2026-08-02, and
-- independently corroborated by all 10 learned rows in source_of_sales_area_aliases
-- (fayoum tamia / fayoum ibshuay / bani suef elfashn / الواسطي ...), which are repointed below.
-- B127-66 (بليفيا), previously unclassified, was ruled Beni Suef by the owner.
--
-- BOTH new areas keep region_code 'GZ' -- the owner's "in other lines these areas belong to GZ".
-- Anti Infective's UE-1 placement for Beni Suef is expressed where it belongs, per line, on
-- au.line_area_map.operational_region_code. No fact row's region_code changes.
--
-- ims_ratio: GZ6 held 0.0258 and src/lib/sales/ims-ratio.ts asserts active non-OT areas sum to
-- exactly IMS_NON_OT_TOTAL (0.9503). Split by each side's share of GZ6's all-line units
-- (Fayoum 56.891% / Beni Suef 43.109%): 0.0147 + 0.0111 = 0.0258 exactly at 4dp, so the invariant
-- is preserved. GZ6 goes inactive and drops out of the sum.
--
-- GZ6 IS RETIRED, NEVER DELETED (active=false on both sides, the OT3 precedent) -- au.* references
-- SoS area codes with NO foreign key, so a delete would silently orphan history.

begin;

-- ---------------------------------------------------------------------------
-- 1. The two new areas
-- ---------------------------------------------------------------------------
insert into public.source_of_sales_areas
  (area_code, region_code, area_name, normalized_area_name, description, active,
   effective_from, source_file, source_sheet, ims_ratio)
values
  ('GZ8', 'GZ', 'Fayoum',    'fayoum',    'Split from GZ6 Fayoum-Beni Suef on 2026-08-02', true,
   date '2026-08-02', 'Master of Master.xlsx', 'Area_Master', 0.0147),
  ('GZ9', 'GZ', 'Beni Suef', 'beni suef', 'Split from GZ6 Fayoum-Beni Suef on 2026-08-02', true,
   date '2026-08-02', 'Master of Master.xlsx', 'Area_Master', 0.0111);

-- Mirror masters. Both are keyed on area_code alone and are read by the closing/master-data
-- surfaces for region naming.
insert into public.source_of_sales_area_regions
  (area_code, area_name, normalized_area_name, region_code, region_name, normalized_region_name,
   source_file, source_sheet, active)
values
  ('GZ8', 'Fayoum',    'fayoum',    'GZ', 'Giza', 'giza', 'Master of Master.xlsx', 'Areas', true),
  ('GZ9', 'Beni Suef', 'beni suef', 'GZ', 'Giza', 'giza', 'Master of Master.xlsx', 'Areas', true);

insert into public.sales_area_region_codes
  (area_code, area_name, normalized_area_name, region_code, region_name, normalized_region_name,
   source_file, source_sheet, active)
values
  ('GZ8', 'Fayoum',    'fayoum',    'GZ', 'Giza', 'giza', 'Master of Master.xlsx', 'Sheet1', true),
  ('GZ9', 'Beni Suef', 'beni suef', 'GZ', 'Giza', 'giza', 'Master of Master.xlsx', 'Sheet1', true);

-- ---------------------------------------------------------------------------
-- 2. Split block B191, then repoint the blocks (bricks follow via ON UPDATE CASCADE)
-- ---------------------------------------------------------------------------
-- New block carries the Fayoum half of the mixed block. B221 is the next free code (max is B220).
-- master_brick_id is deliberately left NULL here: trigger source_of_sales_blocks_master_brick_check
-- asserts the master brick already sits in the block, which cannot be true until the bricks move.
-- It is set immediately after the move, below.
insert into public.source_of_sales_blocks
  (block_code, area_code, region_code, description, normalized_description, active,
   effective_from, source_file, source_sheet, master_brick_id)
values
  ('B221', 'GZ8', 'GZ', 'مدينة الفيوم – طميه', 'مدينة الفيوم – طميه', true,
   date '2026-08-02', 'Master of Master.xlsx', 'Blocks', null);

-- Move the two Fayoum bricks out of the mixed block. Explicit (their block_code changes), and the
-- target (B221,'GZ8','GZ') already exists above so the composite FK is satisfied.
update public.source_of_sales_bricks
   set block_code = 'B221', area_code = 'GZ8', updated_at = now()
 where brick_id in ('B191-3', 'B191-4');

-- Now that B191-3 lives in B221 the trigger's assertion holds.
update public.source_of_sales_blocks
   set master_brick_id = 'B191-3', updated_at = now()
 where block_code = 'B221';

-- Whole-block moves. Each cascades its bricks' (block_code, area_code, region_code).
update public.source_of_sales_blocks set area_code = 'GZ8', updated_at = now() where block_code = 'B125';
update public.source_of_sales_blocks set area_code = 'GZ9', updated_at = now() where block_code = 'B127';
update public.source_of_sales_blocks set area_code = 'GZ9', updated_at = now() where block_code = 'B128';
update public.source_of_sales_blocks set area_code = 'GZ9', updated_at = now() where block_code = 'B191';

-- ---------------------------------------------------------------------------
-- 3. Repoint the sales data, driven by brick_id
-- ---------------------------------------------------------------------------
-- 26,269 of 26,275 GZ6 rows carry a brick_id and no GZ6 brick is tagged to a foreign area, so the
-- split is fully derivable. region_code is unchanged ('GZ' either side) and is left alone.
update public.source_of_sales_customer_map m
   set area_code = b.area_code, updated_at = now()
  from public.source_of_sales_bricks b
 where b.brick_id = m.brick_id and m.area_code = 'GZ6' and b.area_code in ('GZ8', 'GZ9');

update public.source_of_sales_fact_rollup f
   set area_code = b.area_code
  from public.source_of_sales_bricks b
 where b.brick_id = f.brick_id and f.area_code = 'GZ6' and b.area_code in ('GZ8', 'GZ9');

update public.source_of_sales_customer_directory_rollup d
   set area_code = b.area_code
  from public.source_of_sales_bricks b
 where b.brick_id = d.brick_id and d.area_code = 'GZ6' and b.area_code in ('GZ8', 'GZ9');

update public.source_of_sales_import_rows i
   set area_code = b.area_code, area_name = case b.area_code when 'GZ8' then 'Fayoum' else 'Beni Suef' end
  from public.source_of_sales_bricks b
 where b.brick_id = i.brick_id and i.area_code = 'GZ6' and b.area_code in ('GZ8', 'GZ9');

-- The 21 rows with no brick_id at all (6 fact_rollup, 9 import_rows, 6 directory_rollup) are this
-- month's not-yet-mapped PS customers -- 11 units, 0.00 EGP in fact_rollup. They go to Beni Suef so
-- the sales stay VISIBLE rather than silently vanishing onto a retired area; every place-name in
-- them (الواسطى, ميدوم) is Beni Suef. They re-attribute correctly once those customers are mapped
-- to bricks, which is the normal SoS workflow.
update public.source_of_sales_fact_rollup
   set area_code = 'GZ9' where area_code = 'GZ6' and coalesce(brick_id, '') = '';
update public.source_of_sales_customer_directory_rollup
   set area_code = 'GZ9' where area_code = 'GZ6' and brick_id is null;
update public.source_of_sales_import_rows
   set area_code = 'GZ9', area_name = 'Beni Suef' where area_code = 'GZ6' and coalesce(brick_id, '') = '';

-- ---------------------------------------------------------------------------
-- 4. Learned area aliases (the resolver's memory of how distributors spell these places)
-- ---------------------------------------------------------------------------
update public.source_of_sales_area_aliases set area_code = 'GZ8', updated_at = now()
 where area_code = 'GZ6'
   and normalized_alias in ('fayoum elfayoum city', 'fayoum etsa', 'fayoum snoures',
                            'fayoum tamia', 'fayoum ibshuay', 'الفيوم1');

update public.source_of_sales_area_aliases set area_code = 'GZ9', updated_at = now()
 where area_code = 'GZ6'
   and normalized_alias in ('bani suef bani suef city', 'bani suef elfashn',
                            'bani suef ehnasia', 'الواسطي');

-- ---------------------------------------------------------------------------
-- 5. au (organogram / seat model) side
-- ---------------------------------------------------------------------------
insert into au.canonical_areas (area_code, area_name, code_region_code, sort_order, is_active, is_permanent_other)
values ('GZ8', 'Fayoum', 'GZ', 31, true, false),
       ('GZ9', 'Beni Suef', 'GZ', 32, true, false);

insert into au.sos_area_crosswalk (sos_area_code, canonical_area_code, brick_scope)
values ('GZ8', 'GZ8', 'all'), ('GZ9', 'GZ9', 'all');

-- Anti Infective needs TWO rep seats: the owner's rule puts the two areas under DIFFERENT district
-- managers (Fayoum -> SEAT-AIF-DM-GZ, Beni Suef -> SEAT-AIF-ADM-UE-1) and a seat has one parent.
-- The existing GZ6 AIF seat is a VACANT placeholder, so repurposing it disturbs no person.
update au.seats
   set area_code = 'GZ9', seat_label = 'AIF Beni Suef rep'
 where seat_id = 'SEAT-AIF-REP-GZ6';

insert into au.seats (seat_id, line_code, seat_tier, seat_label, region_code, area_code,
                      parent_seat_id, is_active, effective_from, is_other_pseudo_dm)
values ('SEAT-AIF-REP-GZ8', 'anti_infective', 'REP', 'AIF Fayoum rep', 'GZ', 'GZ8',
        'SEAT-AIF-DM-GZ', true, date '2026-08-02', false);

-- Pedia does NOT need a second seat: both areas sit under the same Giza DM, and au.line_area_map
-- puts no unique constraint on rep_seat_id, so one seat legitimately serves both. B-52 keeps
-- covering the same ground and is not touched.
update au.seats
   set area_code = 'GZ8', seat_label = 'PED Fayoum + Beni Suef rep'
 where seat_id = 'SEAT-PED-REP-GZ6';

-- Keep the open (current-state) occupancy rows consistent with the seats' new areas.
update au.occupancy_history set area_code = 'GZ9' where seat_id = 'SEAT-AIF-REP-GZ6' and effective_to is null;
update au.occupancy_history set area_code = 'GZ8' where seat_id = 'SEAT-PED-REP-GZ6' and effective_to is null;

-- Close GZ6's three line rows and open six in their place. THIS is where the per-line rule lives:
-- Beni Suef is UE-1 for anti_infective and GZ for pedia, which one static region_code could never
-- say. CNS carries forward GZ6's existing 'other_line_specific' -> OT state for both areas (it is
-- NOT GZ, contrary to the original brief).
update au.line_area_map set effective_to = date '2026-08-01'
 where area_code = 'GZ6' and effective_to is null;

-- carries_target is GENERATED ALWAYS as (area_state in ('occupied','vacant_will_hire')) and must
-- NOT be listed here. The six area_state values below therefore yield target-carrying rows for
-- anti_infective and pedia, and a non-target row for cns, on both areas -- matching GZ6 today.
insert into au.line_area_map
  (line_code, area_code, effective_from, effective_to, operational_region_code, dm_seat_id,
   rep_seat_id, area_state, other_type, staffed_in_line_code, notes)
values
  -- Fayoum: Giza on every line.
  ('anti_infective', 'GZ8', date '2026-08-02', null, 'GZ',   'SEAT-AIF-DM-GZ',     'SEAT-AIF-REP-GZ8', 'vacant_will_hire',   null,            null,                     'split from GZ6 2026-08-02'),
  ('pedia',          'GZ8', date '2026-08-02', null, 'GZ',   'SEAT-PED-DM-GZ',     'SEAT-PED-REP-GZ6', 'occupied',           null,            null,                     'split from GZ6 2026-08-02; rep shared with GZ9'),
  ('cns',            'GZ8', date '2026-08-02', null, 'OT',   'SEAT-CNS-OTHERS',    null,               'other_line_specific','line_specific', 'anti_infective, pedia',  'token=FYM-CNS-OT; split from GZ6 2026-08-02'),
  -- Beni Suef: UE-1 for Anti Infective only, Giza otherwise.
  ('anti_infective', 'GZ9', date '2026-08-02', null, 'UE-1', 'SEAT-AIF-ADM-UE-1',  'SEAT-AIF-REP-GZ6', 'vacant_will_hire',   null,            null,                     'manager B-1 is an ACTING DM (also a rep); split from GZ6 2026-08-02'),
  ('pedia',          'GZ9', date '2026-08-02', null, 'GZ',   'SEAT-PED-DM-GZ',     'SEAT-PED-REP-GZ6', 'occupied',           null,            null,                     'split from GZ6 2026-08-02; rep shared with GZ8'),
  ('cns',            'GZ9', date '2026-08-02', null, 'OT',   'SEAT-CNS-OTHERS',    null,               'other_line_specific','line_specific', 'anti_infective, pedia',  'token=BNS-CNS-OT; split from GZ6 2026-08-02');

-- ---------------------------------------------------------------------------
-- 6. Retire GZ6 (never delete -- au.* references it with no FK)
-- ---------------------------------------------------------------------------
update public.source_of_sales_areas       set active = false, effective_to = date '2026-08-01', updated_at = now() where area_code = 'GZ6';
update public.source_of_sales_area_regions set active = false, updated_at = now() where area_code = 'GZ6';
update public.sales_area_region_codes      set active = false, updated_at = now() where area_code = 'GZ6';
update au.canonical_areas                  set is_active = false where area_code = 'GZ6';

-- ---------------------------------------------------------------------------
-- 7. Verification -- every one of these must hold or the migration aborts
-- ---------------------------------------------------------------------------
do $$
declare
  v_gz6_bricks int; v_gz8_bricks int; v_gz9_bricks int;
  v_gz6_rows   int; v_ims numeric;    v_lam int;
begin
  select count(*) into v_gz6_bricks from public.source_of_sales_bricks where area_code = 'GZ6';
  select count(*) into v_gz8_bricks from public.source_of_sales_bricks where area_code = 'GZ8';
  select count(*) into v_gz9_bricks from public.source_of_sales_bricks where area_code = 'GZ9';
  if v_gz6_bricks <> 0 or v_gz8_bricks <> 6 or v_gz9_bricks <> 10 then
    raise exception 'brick split wrong: GZ6=% GZ8=% GZ9=% (expected 0/6/10)',
      v_gz6_bricks, v_gz8_bricks, v_gz9_bricks;
  end if;

  select (select count(*) from public.source_of_sales_customer_map            where area_code = 'GZ6')
       + (select count(*) from public.source_of_sales_fact_rollup             where area_code = 'GZ6')
       + (select count(*) from public.source_of_sales_customer_directory_rollup where area_code = 'GZ6')
       + (select count(*) from public.source_of_sales_import_rows             where area_code = 'GZ6')
       + (select count(*) from public.source_of_sales_area_aliases            where area_code = 'GZ6')
    into v_gz6_rows;
  if v_gz6_rows <> 0 then
    raise exception 'still % data rows left on GZ6', v_gz6_rows;
  end if;

  -- The invariant src/lib/sales/ims-ratio.ts asserts (IMS_NON_OT_TOTAL).
  select sum(ims_ratio) into v_ims
    from public.source_of_sales_areas where active and region_code <> 'OT';
  if abs(v_ims - 0.9503) > 1e-6 then
    raise exception 'active non-OT ims_ratio sums to %, expected 0.9503', v_ims;
  end if;

  select count(*) into v_lam
    from au.line_area_map where area_code in ('GZ8', 'GZ9') and effective_to is null;
  if v_lam <> 6 then
    raise exception 'expected 6 open line_area_map rows for the new areas, found %', v_lam;
  end if;

  -- carries_target is generated; prove it landed as intended rather than assuming.
  if (select count(*) from au.line_area_map
       where area_code in ('GZ8', 'GZ9') and effective_to is null and carries_target) <> 4 then
    raise exception 'expected exactly 4 target-carrying rows (aif+pedia on both areas)';
  end if;

  if not exists (select 1 from au.line_area_map
                  where area_code = 'GZ9' and line_code = 'anti_infective'
                    and effective_to is null and operational_region_code = 'UE-1') then
    raise exception 'Beni Suef anti_infective is not mapped to UE-1';
  end if;

  if exists (select 1 from au.line_area_map
              where area_code = 'GZ8' and effective_to is null and operational_region_code = 'UE-1') then
    raise exception 'Fayoum must never map to UE-1';
  end if;
end $$;

commit;

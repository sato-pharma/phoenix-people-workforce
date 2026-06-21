-- Delta (3) — new Pedia sales region carved from existing geography (FORWARD-ONLY).
--
-- BUSINESS CHANGE
-- A 7th District Manager (Pedia line, reporting to the RSM) gets a NEW Source-of-Sales region
-- "Delta (3)" (code D3) = Sharkia + Suez + Ismailia + Qaluebya. Concretely:
--   * Qaluebya  — area D11 (15 bricks) is carved OUT of Delta (1) / D1.
--   * Sharkia   — areas D24 "Sharkia 1" (8) + D25 "Sharkia 2" (8) are carved OUT of Delta (2) / D2.
--   * Suez      — ONLY the "EL SEWIS" brick (B122-12) moves out of "Others"; the rest of the old
--                 "Suez / South Sinai" area (Sharm El Sheikh, South Sinai) STAYS in "Others".
--   * Ismailia  — created as an EMPTY placeholder area (no bricks / no sales yet); it becomes
--                 populated when Ismailia customers/bricks are uploaded later.
--
-- FORWARD-ONLY (effective June 2026). A sale's region is SNAPSHOTTED onto
-- source_of_sales_import_rows at upload time, so every batch already imported keeps its old region
-- (Delta (1)/Delta (2)/Others) — history is intentionally NOT rewritten. The import resolves a
-- NEW row's region LIVE from the brick master, so re-pointing the bricks here means every upload
-- from June 2026 onward attributes Sharkia/Qaluebya/Suez to Delta (3). NOTE: if any June-2026 (or
-- later) batch was already imported BEFORE this runs, re-import it to pick up Delta (3).
--
-- Re-runnable / idempotent: guarded inserts (on conflict) + region-scoped updates. Wrapped in a
-- transaction so a partial failure rolls back cleanly. Geography FKs are ON UPDATE CASCADE, so
-- moving an AREA's region_code cascades the region_code change to its blocks and bricks; the
-- denormalized region_name columns are refreshed explicitly afterward (step 5).

begin;

-- 1) Region master: add D3 = "Delta (3)". region_name MUST stay exactly "Delta (3)" — the sales
--    scope resolver matches an employee's region name verbatim (case/space-insensitive) against it.
insert into public.source_of_sales_regions
  (region_code, region_name, normalized_region_name, description, active,
   effective_from, effective_to, source_file, source_sheet, source_row_number)
values
  ('D3', 'Delta (3)', 'delta 3', 'Sharkia-Suez-Ismailia-Qalubeya', true,
   date '2026-06-01', null, 'manual:delta3_carveout', 'Region_Master', null)
on conflict (region_code) do update set
  region_name            = excluded.region_name,
  normalized_region_name = excluded.normalized_region_name,
  description            = excluded.description,
  active                = true,
  effective_from        = excluded.effective_from,
  updated_at            = now();

-- 2) Carve existing AREAS into D3. Changing the area's region_code cascades (ON UPDATE CASCADE) to
--    every block + brick beneath it. Qaluebya (D11) <- D1; Sharkia 1/2 (D24,D25) <- D2.
update public.source_of_sales_areas
set region_code = 'D3', updated_at = now()
where area_code in ('D11', 'D24', 'D25')
  and region_code <> 'D3';

-- 3) Suez — dedicated area + block under D3, then move ONLY the El Sewis brick (B122-12).
insert into public.source_of_sales_areas
  (area_code, area_name, normalized_area_name, region_code, region_name, description, active,
   source_file, source_sheet, effective_from)
values
  ('D31', 'Suez', 'suez', 'D3', 'Delta (3)', 'Suez', true,
   'manual:delta3_carveout', 'Areas', date '2026-06-01')
on conflict (area_code) do update set
  area_name = excluded.area_name, normalized_area_name = excluded.normalized_area_name,
  region_code = 'D3', region_name = 'Delta (3)', active = true, updated_at = now();

insert into public.source_of_sales_blocks
  (block_code, block_name, normalized_block_name, area_code, area_name, region_code, region_name,
   description, active, source_file, source_sheet)
values
  ('B300', 'Suez', 'suez', 'D31', 'Suez', 'D3', 'Delta (3)',
   'Suez', true, 'manual:delta3_carveout', 'Blocks')
on conflict (block_code) do update set
  area_code = 'D31', area_name = 'Suez', region_code = 'D3', region_name = 'Delta (3)',
  active = true, updated_at = now();

update public.source_of_sales_bricks
set block_code = 'B300', block_name = 'Suez', area_code = 'D31', area_name = 'Suez',
    region_code = 'D3', region_name = 'Delta (3)',
    source_area_code   = coalesce(source_area_code, 'OT2'),
    source_region_code = coalesce(source_region_code, 'OT'),
    updated_at = now()
where brick_id = 'B122-12';

-- 4) Ismailia — EMPTY placeholder area + block under D3 (no bricks yet).
insert into public.source_of_sales_areas
  (area_code, area_name, normalized_area_name, region_code, region_name, description, active,
   source_file, source_sheet, effective_from)
values
  ('D32', 'Ismailia', 'ismailia', 'D3', 'Delta (3)', 'Ismailia (placeholder — no bricks yet)', true,
   'manual:delta3_carveout', 'Areas', date '2026-06-01')
on conflict (area_code) do update set
  region_code = 'D3', region_name = 'Delta (3)', active = true, updated_at = now();

insert into public.source_of_sales_blocks
  (block_code, block_name, normalized_block_name, area_code, area_name, region_code, region_name,
   description, active, source_file, source_sheet)
values
  ('B301', 'Ismailia', 'ismailia', 'D32', 'Ismailia', 'D3', 'Delta (3)',
   'Ismailia (placeholder)', true, 'manual:delta3_carveout', 'Blocks')
on conflict (block_code) do update set
  area_code = 'D32', region_code = 'D3', region_name = 'Delta (3)', active = true, updated_at = now();

-- 5) Refresh the denormalized region_name on everything now in D3 (the cascade in step 2 only moved
--    region_code; the importer also snapshots region_name onto sales rows, so it must agree).
update public.source_of_sales_areas
set region_name = 'Delta (3)', updated_at = now()
where region_code = 'D3' and region_name is distinct from 'Delta (3)';

update public.source_of_sales_blocks
set region_name = 'Delta (3)', updated_at = now()
where region_code = 'D3' and region_name is distinct from 'Delta (3)';

update public.source_of_sales_bricks
set region_name = 'Delta (3)', updated_at = now()
where region_code = 'D3' and region_name is distinct from 'Delta (3)';

-- 6) Refresh the customer→brick snapshot used by the read-only "Database Validation" tab so it shows
--    the moved customers under Delta (3). (The import path itself re-derives region live from the
--    brick master, so this is display-consistency only; historical import_rows are untouched.)
update public.source_of_sales_customer_map cm
set region_code = b.region_code, area_code = b.area_code, updated_at = now()
from public.source_of_sales_bricks b
where cm.brick_id = b.brick_id
  and b.region_code = 'D3'
  and (cm.region_code is distinct from b.region_code or cm.area_code is distinct from b.area_code);

-- 7) Region-name aliases so a distributor file that names the region as text resolves to D3 on
--    import (best-effort; the authoritative path is customer -> brick -> region master).
insert into public.source_of_sales_region_aliases
  (region_code, alias, normalized_alias, source_labels, source_sheet)
values
  ('D3', 'Delta (3)', 'delta 3', array['manual:delta3_carveout'], 'Region_Master'),
  ('D3', 'D3',        'd3',      array['manual:delta3_carveout'], 'Region_Master')
on conflict (region_code, normalized_alias) do nothing;

commit;

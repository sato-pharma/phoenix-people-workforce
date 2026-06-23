-- D33 Shoubra el Khema — carve-out from CA → Delta (3) (FORWARD-ONLY).
--
-- BUSINESS CHANGE
-- Rep 4 of the new Delta (3) Pedia team covers Shoubra el Khema + Shoubra Masr.
-- Those 9 bricks are currently in CA6 (Cairo West, region CA).  Moving them to a
-- new area D33 "Shoubra el Khema" under D3 makes their sales appear on the Delta (3)
-- DSM's dashboard instead of Cairo's.
--
-- Bricks moved (all previously CA6 / region CA):
--   B20-32  SHOBRA MISR (ROD ELFARAG)
--   B20-33  شارع شبرا وتفرعاته ا
--   B21-34  EL MEZALAT
--   B22-35  الخلفاوى
--   B22-36  SHOBRA MISR (ELSAHEL)
--   B23-37  EL SHARABIA
--   B38-55  بهتيم - شبرا الخيمه
--   B38-56  CAIRO (SHOBRA)
--   B38-57  مسطرد
--
-- FORWARD-ONLY. Historical import_rows keep their old region (CA / Cairo).
-- Only new uploads from this point forward resolve these bricks to Delta (3).
-- Re-import any June-2026+ batch that was already imported before this runs.
--
-- Idempotent (ON CONFLICT guards). Transaction-wrapped.
--
-- NOTE FOR PRODUCTION APPLY: production source_of_sales_areas has no region_name;
-- production _blocks has no block_name / normalized_block_name / area_name / region_name;
-- production _bricks has no block_name / area_name / region_name.
-- Apply the stripped prod-adapted variant below, NOT this file directly.

begin;

-- 1) New area D33 "Shoubra el Khema" under D3
insert into public.source_of_sales_areas
  (area_code, area_name, normalized_area_name, region_code, region_name, description, active,
   source_file, source_sheet, effective_from)
values
  ('D33', 'Shoubra el Khema', 'shoubra el khema', 'D3', 'Delta (3)',
   'Shoubra el Khema + Shoubra Masr', true,
   'manual:d33_shoubra_carveout', 'Areas', date '2026-06-01')
on conflict (area_code) do update set
  region_code          = 'D3',
  region_name          = 'Delta (3)',
  active               = true,
  updated_at           = now();

-- 2) New block B302 "Shoubra el Khema" under D33
insert into public.source_of_sales_blocks
  (block_code, block_name, normalized_block_name, area_code, area_name,
   region_code, region_name, description, active, source_file, source_sheet)
values
  ('B302', 'Shoubra el Khema', 'shoubra el khema', 'D33', 'Shoubra el Khema',
   'D3', 'Delta (3)', 'Shoubra el Khema + Shoubra Masr', true,
   'manual:d33_shoubra_carveout', 'Blocks')
on conflict (block_code) do update set
  area_code            = 'D33',
  area_name            = 'Shoubra el Khema',
  region_code          = 'D3',
  region_name          = 'Delta (3)',
  active               = true,
  updated_at           = now();

-- 3) Move the 9 Shoubra bricks CA6/CA → D33/B302/D3
update public.source_of_sales_bricks
set block_code         = 'B302',
    block_name         = 'Shoubra el Khema',
    area_code          = 'D33',
    area_name          = 'Shoubra el Khema',
    region_code        = 'D3',
    region_name        = 'Delta (3)',
    source_area_code   = coalesce(source_area_code,   'CA6'),
    source_region_code = coalesce(source_region_code, 'CA'),
    updated_at         = now()
where brick_id in (
  'B20-32',  -- SHOBRA MISR (ROD ELFARAG)
  'B20-33',  -- شارع شبرا وتفرعاته ا
  'B21-34',  -- EL MEZALAT
  'B22-35',  -- الخلفاوى
  'B22-36',  -- SHOBRA MISR (ELSAHEL)
  'B23-37',  -- EL SHARABIA
  'B38-55',  -- بهتيم - شبرا الخيمه
  'B38-56',  -- CAIRO (SHOBRA)
  'B38-57'   -- مسطرد
)
  and region_code <> 'D3';   -- idempotency guard

-- 4) Refresh customer_map snapshot for moved bricks
update public.source_of_sales_customer_map cm
set region_code  = b.region_code,
    area_code    = b.area_code,
    updated_at   = now()
from public.source_of_sales_bricks b
where cm.brick_id = b.brick_id
  and b.area_code = 'D33'
  and (cm.region_code is distinct from b.region_code
    or cm.area_code   is distinct from b.area_code);

-- 5) Region alias so text-based importers resolve "Shoubra el Khema" → D3
insert into public.source_of_sales_region_aliases
  (region_code, alias, normalized_alias, source_labels, source_sheet)
values
  ('D3', 'Shoubra el Khema', 'shoubra el khema', array['manual:d33_shoubra_carveout'], 'Region_Master'),
  ('D3', 'Shoubra Masr',     'shoubra masr',     array['manual:d33_shoubra_carveout'], 'Region_Master')
on conflict (region_code, normalized_alias) do nothing;

commit;

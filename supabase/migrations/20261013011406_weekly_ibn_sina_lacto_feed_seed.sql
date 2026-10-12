-- Weekly Sales: seed the mapping for the THIRD Ibn Sina feed — IS-L, "Ibn Sina Lacto".
--
-- WHAT
--   1. Copies every Ibn Sina Sato (IS-S) branch-map row to IS-L, so the new code inherits the depot
--      geography Ibn Sina already has (49 rows on production, 2026-10-13).
--   2. Adds the two depots the LACTO MISR export carries that IS-S's map has never seen —
--      '04' Platform Delta (Tanta) and 'A2' Assiut 2 Warehouse.
--   3. Maps the four Lacto SKUs of that export to their Source-of-Sales master codes, by item code
--      AND by item name.
--
-- WHY
--   OWNER RULING, 2026-10-13: "ibn sina for outsource products and ibn sina sato for sato products
--   and add the third ibnsina lacto for lacto." Ibn Sina exports one SalesAndStockReport2_DataHub
--   workbook PER SUPPLIER, and on 2026-10-11 a second one arrived —
--   Weekly_Sales_And_Stock_For_LACTO_MISR_EG20261011120032.xlsx, supplier code 111399. Identical
--   shape to the Sato export, so it shares the adapter, but it must be its OWN distributor code:
--   de-cumulation groups by (distributor, cycle_month) and subtracts the previous week_start's
--   (product x branch) cell, so a Lacto sheet filed under IS-S becomes that group's latest week
--   while carrying none of the Sato cells — and the NEXT Sato file then subtracts zero instead of
--   its predecessor's month-to-date and books the whole cumulative month as one week.
--
--   Both mapping tables are keyed by distributor_code, so IS-S's rows do not carry over and a brand
--   new code maps nothing at all: every row of the file would fail (an unmapped alias and an
--   unmapped branch are both hard failures that block the batch, parser.ts resolveProduct).
--
-- THE TWO NEW DEPOTS — a judgement call, so it is recorded here rather than derived
--   '04' Platform Delta (Tanta) -> D1 Delta (1), area D14 Gharbia 1 (Tanta). Follows this table's own
--   precedent for a platform named after its city: 'T7' Platform Alexandria (Kabary2) sits at
--   AB / AB3 Alex West, and branch 50 Tanta Branch at D1 / D14. It carries no sales in the
--   2026-10-11 file at all (1 stock unit), so nothing moves on it today.
--   'A2' Assiut 2 Warehouse -> UE Upper Egypt, area NULL. Follows the WAREHOUSE precedent in the
--   same table — 'AS' Almaza Storage, 'B1' Benisuef 2 Warehouse and 'O1' October Regional Warehouse
--   all carry a region and no area, because a warehouse serves a region rather than one area. Of its
--   171 units in that file, 167 are Lacto Basic (Head Office, outside weekly scope) and 4 are
--   Advanced, so the area choice moves 4 units of tracked line.
--   Either is one click to change in the Branch Mapping admin tab; neither needs another migration.
--
-- ROLLBACK (additive, fully reversible — no existing row is read, changed or deleted):
--   delete from public.weekly_sales_product_aliases    where distributor_code = 'IS-L';
--   delete from public.weekly_sales_branch_region_map  where distributor_code = 'IS-L';
--
-- Idempotent: both inserts take the table's own unique key, so re-applying adds nothing and
-- overwrites nothing. A row an operator has since corrected by hand therefore survives a re-run.

-- 1 + 2. Branch map: inherit Ibn Sina Sato's depots, then the two the Lacto export adds.
insert into public.weekly_sales_branch_region_map (
  distributor_code, raw_branch, normalized_branch, source_file_type, branch_column_index,
  branch_header_raw, region_code, region_name, area_code, area_name, excluded, created_by, updated_by
)
select
  'IS-L', raw_branch, normalized_branch, source_file_type, branch_column_index,
  branch_header_raw, region_code, region_name, area_code, area_name, excluded,
  'B-10', 'claude-isl-feed-seed-2026-10-13'
from public.weekly_sales_branch_region_map
where distributor_code = 'IS-S'
on conflict (distributor_code, source_file_type, normalized_branch, coalesce(branch_column_index, -1))
  do nothing;

insert into public.weekly_sales_branch_region_map (
  distributor_code, raw_branch, normalized_branch, source_file_type,
  region_code, region_name, area_code, excluded, created_by, updated_by
)
values
  ('IS-L', '04', '04', 'any', 'D1', 'Delta (1)',    'D14', false, 'B-10', 'claude-isl-feed-seed-2026-10-13'),
  ('IS-L', 'A2', 'a2', 'any', 'UE', 'Upper Egypt',  null,  false, 'B-10', 'claude-isl-feed-seed-2026-10-13')
on conflict (distributor_code, source_file_type, normalized_branch, coalesce(branch_column_index, -1))
  do nothing;

-- 3. Product aliases for the four SKUs the LACTO MISR export carries.
--
-- The mapping is confirmed by price, not guessed from the names: the export values its stock at 93%
-- of its selling price, and for the plain SKUs that cost is 209.25 EGP — exactly the master
-- factory_price of LA003 / LA004 (Lacto Basic). The ADVANCED pair prices at 297 selling / 276.21
-- cost against LA001 / LA002 (Lacto Advanced, factory 270).
--
-- By the Head-Office golden rule, LA003 and LA004 sit on the Head Office line, which weekly does not
-- track — so ~93% of this file's value is deliberately out of scope and only the ADVANCED pair
-- (Pedia) ever reaches a tracked line. They are mapped anyway, because an UNMAPPED alias blocks the
-- whole batch; mapped-and-out-of-scope is the correct state, not an exclusion.
insert into public.weekly_sales_product_aliases (
  distributor_code, alias, alias_kind, normalized_alias, product_code, created_by, updated_by
)
values
  ('IS-L', '684793', 'code', '684793', 'LA003', 'B-10', 'claude-isl-feed-seed-2026-10-13'),
  ('IS-L', '684794', 'code', '684794', 'LA004', 'B-10', 'claude-isl-feed-seed-2026-10-13'),
  ('IS-L', '684795', 'code', '684795', 'LA001', 'B-10', 'claude-isl-feed-seed-2026-10-13'),
  ('IS-L', '684796', 'code', '684796', 'LA002', 'B-10', 'claude-isl-feed-seed-2026-10-13'),
  ('IS-L', 'LACTO 1 400 GM',          'name', 'lacto 1 400 gm',          'LA003', 'B-10', 'claude-isl-feed-seed-2026-10-13'),
  ('IS-L', 'LACTO 2 400 GM',          'name', 'lacto 2 400 gm',          'LA004', 'B-10', 'claude-isl-feed-seed-2026-10-13'),
  ('IS-L', 'LACTO 1 ADVANCED 400 GM', 'name', 'lacto 1 advanced 400 gm', 'LA001', 'B-10', 'claude-isl-feed-seed-2026-10-13'),
  ('IS-L', 'LACTO 2 ADVANCED 400 GM', 'name', 'lacto 2 advanced 400 gm', 'LA002', 'B-10', 'claude-isl-feed-seed-2026-10-13')
on conflict (distributor_code, alias_kind, normalized_alias) do nothing;

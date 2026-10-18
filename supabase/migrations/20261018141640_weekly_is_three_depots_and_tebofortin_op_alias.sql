-- Weekly Sales: Ibn Sina (IS) learns three depots and one old-price Tebofortin drops alias.
--
-- WHAT
--   1. Three rows in public.weekly_sales_branch_region_map for distributor_code 'IS':
--        'A2'  Assiut 2 Warehouse    -> UE Upper Egypt, area UE4 (Assuit 2)
--        'M2'  Cairo Main Warehouse  -> CA Cairo, no area
--        'D1'  El Sadat WH           -> D1 Delta (1), no area
--   2. One row in public.weekly_sales_product_aliases for distributor_code 'IS':
--        code 639566, "TEBOFORTIN ORAL DROPS 30ML(O.P)" -> TE001 (Tebofotin drops)
--
-- WHY
--   The IS file ISP SATO SALES & STOCK 14-10-2026 (679 rows, supplier MARCYRL) was dry-run through
--   the real parser against production's mappings on 2026-10-18. Once its sheet is read, 56 of 558
--   fact rows still block the batch (an unmapped alias and an unmapped depot are both hard
--   failures, parser.ts resolveProduct / resolveRegion):
--     43 rows  product code 639566 has no alias on IS
--     11 rows  depot 'A2' is not mapped on IS
--      2 rows  depot 'D1' is not mapped on IS (or on any distributor)
--      1 row   depot 'M2' is not mapped on IS
--
--   OWNER RULINGS, 2026-10-18 (asked in chat as multiple choice):
--     'D1' El Sadat WH  -> "Delta (1), no area". Sadat City is in Menoufia and Shbein El Kom,
--                          also Menoufia, already sits in Delta (1) on IS. Region only, the way the
--                          other warehouses are mapped, because the area is HIS call and he gave none.
--     639566            -> "TE001 Tebofortin drops". Every other old-price twin on IS maps to the
--                          product its current-price sibling maps to (585580 -> TE003, 639536 -> TE002,
--                          679750 -> TE005, 679749 -> TE004), and the sibling "(OLD PRICE)" drops
--                          alias 585582 already goes to TE001.
--
--   'A2' and 'M2' are not new rulings — they are the rulings the other Ibn Sina feeds already carry,
--   applied to the same physical depots: IS-L 'A2' is UE / UE4 (owner, 2026-10-13: "wire to assuit
--   2", 20261013120001) and IS-S and IS-L 'M2' are CA with no area (IS-S since 2026-06-28).
--   'UE4' is the area master's own code ("Assuit 2", region UE); area_name is left to the table's
--   BEFORE INSERT OR UPDATE trigger weekly_branch_area_is_consistent_trg, which fills it from the
--   master.
--
-- WHY A MIGRATION AND NOT JUST THE ADMIN TAB
--   The seed migration is how these rows exist, so a rebuild from migrations would otherwise lose
--   them and the next IS file would block again. Applied by this file, on staging and production.
--
-- ROLLBACK (additive — no existing row is read, changed or deleted):
--   delete from public.weekly_sales_branch_region_map
--    where distributor_code = 'IS' and normalized_branch in ('a2', 'm2', 'd1')
--      and created_by = 'B-10' and updated_by = 'claude-is-depots-2026-10-18';
--   delete from public.weekly_sales_product_aliases
--    where distributor_code = 'IS' and normalized_alias = '639566'
--      and updated_by = 'claude-is-depots-2026-10-18';
--
-- Idempotent: both inserts take the tables' own unique keys, so re-applying adds nothing and
-- overwrites nothing. A row an operator has since corrected by hand therefore survives a re-run.

insert into public.weekly_sales_branch_region_map (
  distributor_code, raw_branch, normalized_branch, source_file_type,
  region_code, region_name, area_code, excluded, created_by, updated_by
)
values
  ('IS', 'A2', 'a2', 'any', 'UE', 'Upper Egypt', 'UE4', false, 'B-10', 'claude-is-depots-2026-10-18'),
  ('IS', 'M2', 'm2', 'any', 'CA', 'Cairo',       null,  false, 'B-10', 'claude-is-depots-2026-10-18'),
  ('IS', 'D1', 'd1', 'any', 'D1', 'Delta (1)',   null,  false, 'B-10', 'claude-is-depots-2026-10-18')
on conflict (distributor_code, source_file_type, normalized_branch, coalesce(branch_column_index, -1))
  do nothing;

insert into public.weekly_sales_product_aliases (
  distributor_code, alias, alias_kind, normalized_alias, product_code, created_by, updated_by
)
values
  ('IS', '639566', 'code', '639566', 'TE001', 'B-10', 'claude-is-depots-2026-10-18')
on conflict (distributor_code, alias_kind, normalized_alias) do nothing;

-- Source of Sales + Marketing ROI: register the THIRD Ibn Sina channel — IS-L, "Ibn Sina-Lacto".
--
-- WHAT
--   1. public.source_of_sales_distributors   — one row, ('IS-L', 'Ibn Sina-Lacto', 'ibn sina-lacto').
--      This is the Upload Sales / Source of Sales distributor picker and the join key every monthly
--      surface reads a distributor's NAME from.
--   2. public.marketing_roi_distributor_rollup — one row, IS-L -> parent 'IS' / 'ibn sina', exactly as
--      IS, IS-S and IS-T already roll up, so Marketing ROI attributes Ibn Sina Lacto sales to the Ibn
--      Sina desk instead of to nobody.
--   3. public.source_of_sales_product_aliases — the four Lacto SKUs of the LACTO MISR export, by item
--      CODE and by item NAME (8 rows), so a monthly Ibn Sina Lacto sheet resolves instead of blocking.
--
-- WHY
--   OWNER RULING, 2026-10-13: "ibn sina for outsource products and ibn sina sato for sato products and
--   add the third ibnsina lacto for lacto", then — the same day — "every where in mapping and upload
--   and normalizer and every where". The weekly lane was seeded by
--   20261013011406_weekly_ibn_sina_lacto_feed_seed.sql; this is the MONTHLY half of the same ruling.
--
--   None of these three tables self-heals:
--     • source_of_sales_distributors is loaded from the owner's distributor-master file, and IS-L is
--       not in it — it is code-defined (SYSTEM_DISTRIBUTORS in src/lib/sales/master-data/
--       import-service.ts re-ensures it after every master import; this migration is that list's
--       mirror, the way EG-BR, IS-T and the other tender channels have theirs).
--     • marketing_roi_distributor_rollup is hand-maintained by design — see the header of
--       20260728110000_marketing_roi_rollup_epda_subchannels.sql. A missing row does not fall back to
--       the parent code: the sales simply reach no marketing desk.
--     • source_of_sales_product_aliases is keyed by (distributor_code, normalized_alias), so IS's and
--       IS-S's Lacto-free alias sets carry nothing over to a new code.
--
--   Read off production 2026-10-13 before writing this: IS, IS-S and IS-T are present in all the
--   tables above and IS-L is absent from every one of them.
--
-- THE ALIAS MAPPING — confirmed by PRICE, not guessed from the names
--   The LACTO MISR export values its stock at 93% of its selling price, and for the plain SKUs that
--   cost is exactly 209.25 EGP — the master factory_price of LA003 / LA004 (Lacto Basic). The ADVANCED
--   pair prices at 297 selling / 276.21 cost against LA001 / LA002 (Lacto Advanced, factory 270).
--   By the Head-Office golden rule LA003/LA004 sit on the Head Office line, which weekly does not
--   track — but monthly Source of Sales does carry Head Office, so on this side all four codes count.
--   normalized_alias is the key normalizeAliasKey() produces: non-alphanumeric -> single space,
--   collapsed, trimmed, lower-cased.
--
-- ROLLBACK (additive, fully reversible — no existing row is read, changed or deleted):
--   delete from public.source_of_sales_product_aliases    where distributor_code = 'IS-L';
--   delete from public.marketing_roi_distributor_rollup   where sos_distributor_code = 'IS-L';
--   delete from public.source_of_sales_distributors       where distributor_code = 'IS-L';
--
-- Idempotent: every insert takes the table's own unique key and does nothing on conflict, so
-- re-applying adds nothing and a row an operator has since corrected by hand survives a re-run.

-- 1. The Source of Sales distributor channel.
-- source_file / source_sheet are left to their column defaults ('phoenix products.xlsx' /
-- 'Distrubutors') deliberately: that is what EVERY row of this table carries, the code-defined
-- channels DIRECT, EG-BR, EG-HOS and IS-T included (read on production 2026-10-13), and it is what
-- ensureSystemDistributors() writes — so this row is identical to the one that path would create.
insert into public.source_of_sales_distributors (
  distributor_code, distributor_name, normalized_distributor_name, active
)
values
  ('IS-L', 'Ibn Sina-Lacto', 'ibn sina-lacto', true)
on conflict (distributor_code) do nothing;

-- 2. Marketing ROI roll-up: IS-L belongs to the Ibn Sina desk, like IS-S and IS-T.
insert into public.marketing_roi_distributor_rollup (
  sos_distributor_code, parent_distributor_code, marketing_normalized_name
)
values
  ('IS-L', 'IS', 'ibn sina')
on conflict (sos_distributor_code) do update
  set parent_distributor_code  = excluded.parent_distributor_code,
      marketing_normalized_name = excluded.marketing_normalized_name;

-- 3. Product aliases for the four Lacto SKUs — by item code and by item name.
insert into public.source_of_sales_product_aliases (
  distributor_code, alias, normalized_alias, product_code, source_labels, source_file, source_sheet, active
)
values
  ('IS-L', '684793', '684793', 'LA003', array['Ibn Sina-Lacto'], 'migration', 'Product_Alias', true),
  ('IS-L', '684794', '684794', 'LA004', array['Ibn Sina-Lacto'], 'migration', 'Product_Alias', true),
  ('IS-L', '684795', '684795', 'LA001', array['Ibn Sina-Lacto'], 'migration', 'Product_Alias', true),
  ('IS-L', '684796', '684796', 'LA002', array['Ibn Sina-Lacto'], 'migration', 'Product_Alias', true),
  ('IS-L', 'LACTO 1 400 GM',          'lacto 1 400 gm',          'LA003', array['Ibn Sina-Lacto'], 'migration', 'Product_Alias', true),
  ('IS-L', 'LACTO 2 400 GM',          'lacto 2 400 gm',          'LA004', array['Ibn Sina-Lacto'], 'migration', 'Product_Alias', true),
  ('IS-L', 'LACTO 1 ADVANCED 400 GM', 'lacto 1 advanced 400 gm', 'LA001', array['Ibn Sina-Lacto'], 'migration', 'Product_Alias', true),
  ('IS-L', 'LACTO 2 ADVANCED 400 GM', 'lacto 2 advanced 400 gm', 'LA002', array['Ibn Sina-Lacto'], 'migration', 'Product_Alias', true)
on conflict (distributor_code, normalized_alias) do nothing;

-- Unify marketing_products.product_code with the Source-of-Sales product_code for the same
-- product, so a single code identifies a product across both catalogs. Sales is the reference
-- (source_of_sales_products.product_code is the canonical id used by product_scope_override in
-- sales dashboards; marketing_products previously minted its own independent MKT_PRD#### codes
-- during the one-off reference-workbook import, so the same product had two different codes).
--
-- Scope: all 21 rows in marketing_products today match a source_of_sales_products row 1:1 by
-- normalized name + line (20 exact matches; "Tebofrtin drops" / CNS is a data-entry typo for the
-- sales catalog's "Tebofotin drops" / CNS, TE001 — same product, only spelling drifted between
-- the two source files). Sales-only products (the confidential LA003/LA004/SS001 and the
-- IGNORE sentinel) have no marketing_products row and are untouched.
--
-- Safe to rerun: each UPDATE is keyed on the OLD (MKT_PRD####) code, so a second run is a no-op.
-- marketing_request_products references marketing_products by the surrogate `id` column (not by
-- product_code), so this rename has no effect on the 316 existing request-product rows.
update public.marketing_products as mp
set product_code = mapping.new_code,
    updated_at = now()
from (values
  ('MKT_PRD0001', 'TE001'), -- Tebofrtin drops (typo for Tebofotin drops) / CNS
  ('MKT_PRD0002', 'TE002'), -- Tebofortine Forte 80 / CNS
  ('MKT_PRD0003', 'TE003'), -- Tebofortine 40 mg / CNS
  ('MKT_PRD0004', 'TE004'), -- Tebofortin 240 mg max / CNS
  ('MKT_PRD0005', 'TE005'), -- Tebofortin 120 mg Intens / CNS
  ('MKT_PRD0006', 'RI001'), -- Rispadex 3 mg UPA / CNS
  ('MKT_PRD0007', 'RI002'), -- Rispadex 3 mg / CNS
  ('MKT_PRD0008', 'RI003'), -- Rispadex 1mg Syp / CNS
  ('MKT_PRD0009', 'DO001'), -- Dopaminict 1mg UPA / CNS
  ('MKT_PRD0010', 'DO002'), -- Dopaminect 1mg / CNS
  ('MKT_PRD0011', 'DO003'), -- Dolabactin / CNS
  ('MKT_PRD0012', 'CO001'), -- Conviban 50 mg / CNS
  ('MKT_PRD0013', 'CO002'), -- Conviban 25mg/ml Syp / CNS
  ('MKT_PRD0014', 'CO003'), -- Conviban 25 mg / CNS
  ('MKT_PRD0015', 'CO004'), -- Conviban 100 mg / CNS
  ('MKT_PRD0016', 'SA001'), -- Saginko / Anti infective
  ('MKT_PRD0017', 'RO001'), -- Royafloxacin / Anti infective
  ('MKT_PRD0018', 'IV001'), -- Ivyronc / Pedia
  ('MKT_PRD0019', 'GU001'), -- Guamusin / Pedia
  ('MKT_PRD0020', 'LA001'), -- Lacto Advanced 1 / Pedia
  ('MKT_PRD0021', 'LA002')  -- Lacto Advanced 2 / Pedia
) as mapping(old_code, new_code)
where mp.product_code = mapping.old_code;

-- Direct Orders · name the parent table's two distributor columns as dead
--
-- `public.direct_order_pharmacies.distributor_code` and `.distributor_customer_code` are empty on
-- every row: 0 of 72 rows carry a value in either, measured on the production project
-- ozucdzovmcqvepbozvqf on 2026-09-03. Nothing reads them, in the application or in the database:
--
--   * `mapPharmacyRow()` maps neither column, and hands back `distributorCodes: []` for
--     `attachDistributorCodes()` to fill from the child table instead.
--   * `phx_create_direct_order_pharmacy` and `phx_resolve_directory_pharmacy` both omit the two
--     columns from their INSERT into this table, then write the child table.
--   * `phx_search_direct_order_customers` left-joins the child table and filters on
--     `c.distributor_code`, never on the parent.
--   * No view, materialized view, index, constraint, trigger or RLS policy references either one.
--
-- The live link is `public.direct_order_pharmacy_distributor_codes (distributor_code,
-- customer_code)`, and it works: 45 of its 54 rows resolve against
-- `public.source_of_sales_customer_map`, covering 54 distinct pharmacies.
--
-- The trap these comments close: a query that links a direct-order pharmacy to a Source of Sales
-- customer through the PARENT column returns zero rows and raises no error. That reads as "direct
-- orders are not linked to sales" when they are in fact 83 percent linked, through the child.
--
-- Comments only. The columns are deliberately left in place; dropping them is a separate step that
-- needs owner approval and must land AFTER the deploy that stops naming them in an insert.

comment on column public.direct_order_pharmacies.distributor_code is
  'DEAD COLUMN - never read, and empty on every row. The live distributor link for a direct-order pharmacy is public.direct_order_pharmacy_distributor_codes (distributor_code, customer_code). Joining Source of Sales through this column returns zero rows with no error, which reads as "not linked" when the pharmacy is linked through the child table.';

comment on column public.direct_order_pharmacies.distributor_customer_code is
  'DEAD COLUMN - never read, and empty on every row. The live customer code for a direct-order pharmacy is public.direct_order_pharmacy_distributor_codes.customer_code, paired with distributor_code in the same child row. Joining Source of Sales through this column returns zero rows with no error, which reads as "not linked" when the pharmacy is linked through the child table.';

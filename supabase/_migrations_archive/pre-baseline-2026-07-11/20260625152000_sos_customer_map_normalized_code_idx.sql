-- Expression index matching the normalized customer-code lookup that every
-- region/pharmacy-attribution function uses to join source_of_sales_customer_map
-- to marketing_pharmacy_distributor_codes.normalized_pharmacy_code:
--   lower(btrim(regexp_replace(coalesce(customer_code,''),'\s+',' ','g')))
--
-- That includes phx_marketing_roi_fast's `rta` CTE (region lookup, runs
-- unconditionally regardless of region/distributor filters),
-- phx_marketing_roi_customer_dashboard, phx_refresh_marketing_roi_facts, the ROI
-- health-check functions, and the pharmacy-mapping-coverage view. The only
-- existing index on this table (source_of_sales_customer_map_lookup_idx) is on
-- the raw (distributor_code, customer_code) pair, so every one of those lateral
-- lookups currently has to scan the table per joined row instead of using an
-- index. Additive, index-only — no schema or function changes.
create index if not exists source_of_sales_customer_map_normalized_code_idx
  on public.source_of_sales_customer_map (
    (lower(btrim(regexp_replace(coalesce(customer_code,''),'\s+',' ','g'))))
  )
  where active;

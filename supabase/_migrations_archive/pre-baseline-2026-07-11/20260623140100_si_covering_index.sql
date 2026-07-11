-- Performance: extend the covering index on source_of_sales_import_rows to include
-- the columns needed by phx_si_period_totals (official_line, region_code, area_code,
-- client_code). The original index was missing these, causing heap fetches that
-- drove cache hit rate down to 82% (all other tables are 99%+).
-- Dropping and recreating because INCLUDE columns cannot be added to an existing index.

drop index if exists public.sos_rows_period_value_cover_idx;

create index sos_rows_period_value_cover_idx
  on public.source_of_sales_import_rows (invoice_period)
  include (
    batch_id,
    qty,
    discount,
    value,
    is_direct,
    product_code,
    official_line,
    region_code,
    area_code,
    client_code
  );

-- Supporting indexes for the fact-rollup-based function rewrites + customer map pagination.

-- Covering index for phx_exec_brick, phx_monthly_closing_matrix, phx_monthly_closing_direct,
-- and phx_si_distributor_product. Filters on (is_direct, period, official_line, region_code)
-- with all aggregate columns in INCLUDE — enables index-only scans against the batch join.
create index if not exists sos_fact_rollup_direct_period_line_idx
  on public.source_of_sales_fact_rollup (is_direct, period, official_line, region_code)
  include (batch_id, distributor_code, area_code, brick_id, product_code, product_name,
           total_qty, effective_units, direct_value);

-- Covering index for phx_si_period_totals customer_presence_rollup CTE.
-- Supports the batch_id join + line/region filters with client_code in INCLUDE.
create index if not exists sos_customer_presence_batch_period_idx
  on public.source_of_sales_customer_presence_rollup (batch_id, period)
  include (client_code, official_line, region_code, present_nonexcluded);

-- Index-only scan for the paginated source_of_sales_customer_map fetch
-- (.eq("active", true).order("distributor_code").order("customer_code").range(from, to)).
-- Turns 16,703-row full-table fetches into index pagination.
create index if not exists sos_customer_map_active_dist_client_idx
  on public.source_of_sales_customer_map (active, distributor_code, customer_code)
  include (brick_id);

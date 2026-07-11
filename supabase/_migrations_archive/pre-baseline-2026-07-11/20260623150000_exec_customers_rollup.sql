-- perf: rewrite phx_exec_customers to read source_of_sales_customer_directory_rollup
-- instead of scanning the full 410MB source_of_sales_import_rows table.
-- The rollup has the same grain (batch × period × distributor × client × product) and is
-- pre-aggregated at import time.  effective_units = sum(qty*(1-discount)) and total_qty = sum(qty),
-- so value = effective_units * factory_price is equivalent to the original line_value expression.
-- This eliminates the most expensive remaining raw-table scan (~7.4% of total DB time).

create or replace function public.phx_exec_customers(p_period text default null)
returns table (
  client_code    text,
  client_name    text,
  distributor_code text,
  region_code    text,
  area_code      text,
  brick_id       text,
  units          numeric,
  value          numeric
)
language sql
stable
security definer
set search_path = public
set statement_timeout = '45s'
as $$
  with filtered as (
    select
      r.client_code,
      r.client_name,
      r.distributor_code,
      r.region_code,
      r.area_code,
      r.brick_id,
      r.latest_row_created_at,
      r.total_qty,
      r.effective_units * coalesce(p.factory_price, 0) as line_value
    from public.source_of_sales_customer_directory_rollup r
    join public.source_of_sales_import_batches b
      on b.id = r.batch_id and b.status = 'validated'
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = r.product_code
    where (p_period is null or r.period = p_period)
      and r.client_code is not null
  ),
  latest as (
    select distinct on (client_code, distributor_code)
      client_code, distributor_code, client_name, region_code, area_code, brick_id
    from filtered
    order by client_code, distributor_code, latest_row_created_at desc
  ),
  agg as (
    select
      client_code,
      distributor_code,
      sum(total_qty)    as units,
      sum(line_value)   as value
    from filtered
    group by client_code, distributor_code
  )
  select a.client_code, l.client_name, a.distributor_code,
         l.region_code, l.area_code, l.brick_id, a.units, a.value
  from agg a
  join latest l using (client_code, distributor_code);
$$;

revoke all on function public.phx_exec_customers(text) from public, anon, authenticated;
grant  execute on function public.phx_exec_customers(text) to service_role;

-- Rewrite exec functions to read from source_of_sales_fact_rollup (~20k pre-aggregated rows)
-- instead of scanning the raw source_of_sales_import_rows table (410MB, ~4M rows).
-- Impact: phx_exec_brick (~1.1% DB time), phx_monthly_closing_matrix (~1.9%),
--         phx_monthly_closing_direct (~1.8%) — combined ~4.8% of total DB time eliminated.
--
-- Correctness:
--   effective_units = sum(qty * (1 - discount))  — pricing base pre-computed at import
--   direct_value    = sum(value) for is_direct rows — pre-computed at import
--   Value for distributor rows = effective_units * factory_price (joined at query time)
--   These match the original qty*(1-discount)*factory_price and r.value formulas exactly.

create or replace function public.phx_exec_brick(p_period text default null)
returns table (
  distributor_code text,
  region_code      text,
  area_code        text,
  brick_id         text,
  units            numeric,
  value            numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select
    f.distributor_code, f.region_code, f.area_code, f.brick_id,
    sum(f.total_qty)                                           as units,
    sum(f.effective_units * coalesce(p.factory_price, 0))     as value
  from public.source_of_sales_fact_rollup f
  join public.source_of_sales_import_batches b
    on b.id = f.batch_id and b.status = 'validated'
  left join public.source_of_sales_products p
    on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
  where not f.is_direct
    and (p_period is null or f.period = p_period)
  group by f.distributor_code, f.region_code, f.area_code, f.brick_id;
$$;

revoke execute on function public.phx_exec_brick(text) from public, anon, authenticated;
grant  execute on function public.phx_exec_brick(text) to service_role;


create or replace function public.phx_monthly_closing_matrix(p_line text, p_period text)
returns table (
  area_code    text,
  product_code text,
  sales_units  numeric,
  sales_value  numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select
    f.area_code, f.product_code,
    sum(f.total_qty)                                       as sales_units,
    sum(f.effective_units * coalesce(p.factory_price, 0)) as sales_value
  from public.source_of_sales_fact_rollup f
  join public.source_of_sales_import_batches b
    on b.id = f.batch_id and b.status = 'validated'
  left join public.source_of_sales_products p
    on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
  where f.period = p_period
    and lower(btrim(f.official_line)) = lower(btrim(p_line))
    and not f.is_direct
  group by f.area_code, f.product_code;
$$;

revoke execute on function public.phx_monthly_closing_matrix(text, text) from public, anon, authenticated;
grant  execute on function public.phx_monthly_closing_matrix(text, text) to service_role;


create or replace function public.phx_monthly_closing_direct(p_line text, p_period text)
returns table (
  region_code  text,
  product_code text,
  sales_units  numeric,
  sales_value  numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select
    f.region_code, f.product_code,
    sum(f.total_qty)   as sales_units,
    sum(f.direct_value) as sales_value
  from public.source_of_sales_fact_rollup f
  join public.source_of_sales_import_batches b
    on b.id = f.batch_id and b.status = 'validated'
  where f.period = p_period
    and lower(btrim(f.official_line)) = lower(btrim(p_line))
    and f.is_direct
  group by f.region_code, f.product_code;
$$;

revoke execute on function public.phx_monthly_closing_direct(text, text) from public, anon, authenticated;
grant  execute on function public.phx_monthly_closing_direct(text, text) to service_role;

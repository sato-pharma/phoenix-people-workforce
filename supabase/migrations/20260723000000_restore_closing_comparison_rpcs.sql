-- Restore the phx_closing_* comparison trio that was erroneously dropped in
-- 20260622140000_drop_dead_executive_snapshot_rpcs.sql (pre-baseline). The functions
-- are actively called by src/lib/sales/monthly-closing-comparison.ts (the monthly
-- closing XLSX export's distributor comparison & insights section).
--
-- Rewritten to read from source_of_sales_fact_rollup (not the raw import_rows table)
-- for consistency with the surviving phx_monthly_closing_matrix / _direct siblings.
-- Includes the hard-coded confidential product exclusion (LA003/LA004/SS001) and a
-- 45s statement_timeout guard.
--
-- Grants: service_role only (no anon/authenticated — these are server-side RPCs).

------------------------------------------------------------------------
-- 1. phx_closing_distributor_product
------------------------------------------------------------------------
create or replace function public.phx_closing_distributor_product(p_line text, p_period text)
returns table (
  distributor_code text,
  region_code      text,
  area_code        text,
  product_code     text,
  product_name     text,
  units            numeric,
  value            numeric
)
language sql stable security definer
set search_path = public
set statement_timeout = '45s'
as $$
  select
    f.distributor_code,
    f.region_code,
    f.area_code,
    f.product_code,
    max(f.product_name)                                      as product_name,
    sum(f.total_qty)                                         as units,
    sum(f.effective_units * coalesce(p.factory_price, 0))    as value
  from public.source_of_sales_fact_rollup f
  join public.source_of_sales_import_batches b
    on b.id = f.batch_id and b.status = 'validated'
  left join public.source_of_sales_products p
    on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
  where f.period = p_period
    and lower(btrim(f.official_line)) = lower(btrim(p_line))
    and not f.is_direct
    and upper(btrim(coalesce(f.product_code, ''))) not in ('LA003', 'LA004', 'SS001')
  group by f.distributor_code, f.region_code, f.area_code, f.product_code;
$$;

revoke execute on function public.phx_closing_distributor_product(text, text) from public, anon, authenticated;
grant execute on function public.phx_closing_distributor_product(text, text) to service_role;

------------------------------------------------------------------------
-- 2. phx_closing_brick
------------------------------------------------------------------------
create or replace function public.phx_closing_brick(p_line text, p_period text)
returns table (
  distributor_code text,
  region_code      text,
  area_code        text,
  brick_id         text,
  units            numeric,
  value            numeric
)
language sql stable security definer
set search_path = public
set statement_timeout = '45s'
as $$
  select
    f.distributor_code,
    f.region_code,
    f.area_code,
    f.brick_id,
    sum(f.total_qty)                                         as units,
    sum(f.effective_units * coalesce(p.factory_price, 0))    as value
  from public.source_of_sales_fact_rollup f
  join public.source_of_sales_import_batches b
    on b.id = f.batch_id and b.status = 'validated'
  left join public.source_of_sales_products p
    on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
  where f.period = p_period
    and lower(btrim(f.official_line)) = lower(btrim(p_line))
    and not f.is_direct
    and upper(btrim(coalesce(f.product_code, ''))) not in ('LA003', 'LA004', 'SS001')
  group by f.distributor_code, f.region_code, f.area_code, f.brick_id;
$$;

revoke execute on function public.phx_closing_brick(text, text) from public, anon, authenticated;
grant execute on function public.phx_closing_brick(text, text) to service_role;

------------------------------------------------------------------------
-- 3. phx_closing_customers
------------------------------------------------------------------------
-- The original derived client_name via DISTINCT ON ... ORDER BY created_at DESC on
-- the raw import_rows. The fact_rollup carries client_code but not client_name.
-- We join source_of_sales_customer_map (the normalised source of truth for customer
-- metadata) to obtain the name, area, brick, and region.  Unmapped clients get
-- their metadata from the rollup row itself (which inherits from the import row's
-- geography) and a blank client_name (the TS caller falls back to client_code).
create or replace function public.phx_closing_customers(p_line text, p_period text)
returns table (
  client_code      text,
  client_name      text,
  distributor_code text,
  region_code      text,
  area_code        text,
  brick_id         text,
  units            numeric,
  value            numeric
)
language sql stable security definer
set search_path = public
set statement_timeout = '45s'
as $$
  with agg as (
    select
      f.client_code,
      f.distributor_code,
      -- Geography from the rollup row (fallback when customer_map has no entry)
      max(f.region_code)  as rollup_region,
      max(f.area_code)    as rollup_area,
      max(f.brick_id)     as rollup_brick,
      sum(f.total_qty)                                       as units,
      sum(f.effective_units * coalesce(p.factory_price, 0))  as value
    from public.source_of_sales_fact_rollup f
    join public.source_of_sales_import_batches b
      on b.id = f.batch_id and b.status = 'validated'
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
    where f.period = p_period
      and lower(btrim(f.official_line)) = lower(btrim(p_line))
      and f.client_code is not null
      and upper(btrim(coalesce(f.product_code, ''))) not in ('LA003', 'LA004', 'SS001')
    group by f.client_code, f.distributor_code
  )
  select
    a.client_code,
    coalesce(cm.customer_name, '') as client_name,
    a.distributor_code,
    coalesce(cm.region_code, a.rollup_region)  as region_code,
    coalesce(cm.area_code,   a.rollup_area)    as area_code,
    coalesce(cm.brick_id,    a.rollup_brick)   as brick_id,
    a.units,
    a.value
  from agg a
  left join public.source_of_sales_customer_map cm
    on cm.distributor_code = a.distributor_code
   and cm.customer_code    = a.client_code
   and cm.active;
$$;

revoke execute on function public.phx_closing_customers(text, text) from public, anon, authenticated;
grant execute on function public.phx_closing_customers(text, text) to service_role;

------------------------------------------------------------------------
-- Notify PostgREST to reload its schema cache
------------------------------------------------------------------------
notify pgrst, 'reload schema';

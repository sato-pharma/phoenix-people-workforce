-- Executive Report RPCs — company-wide (ALL lines) aggregates powering the downloaded
-- executive comparison + insights workbook.
--
-- These mirror the Monthly Closing comparison RPCs but (a) drop the official_line filter so
-- every line is included, (b) take a NULLABLE period: when p_period is null the report spans
-- ALL uploaded months (all-time), otherwise it narrows to that month. Value is ALWAYS
-- recomputed the canonical way (Qty x (1 - discount) x live factory_price); the stored value
-- column is never used; bonus rows carry a 100% discount so they add quantity but no value.
--
-- Canonical predicate: validated batch + the row's invoice month equals its batch month, with
-- the optional period narrowing. Read-only, additive, reversible (drop the 3 functions).
-- Apply to PRODUCTION with approval.

-- distributor x line x region x area x product
create or replace function public.phx_exec_distributor_product(p_period text default null)
returns table (
  distributor_code text,
  official_line text,
  region_code text,
  area_code text,
  product_code text,
  product_name text,
  units numeric,
  value numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select
    r.distributor_code, r.official_line, r.region_code, r.area_code, r.product_code,
    max(r.product_name) as product_name,
    sum(r.qty) as units,
    sum(r.qty * (1 - coalesce(r.discount, 0)) * coalesce(p.factory_price, 0)) as value
  from public.source_of_sales_import_rows r
  join public.source_of_sales_import_batches b on b.id = r.batch_id
  left join public.source_of_sales_products p
    on upper(btrim(p.product_code)) = upper(btrim(r.product_code))
  where b.status = 'validated' and r.invoice_period = b.period
    and (p_period is null or b.period = p_period)
  group by r.distributor_code, r.official_line, r.region_code, r.area_code, r.product_code;
$$;

revoke all on function public.phx_exec_distributor_product(text) from public, anon, authenticated;
grant execute on function public.phx_exec_distributor_product(text) to service_role;

-- distributor x brick
create or replace function public.phx_exec_brick(p_period text default null)
returns table (
  distributor_code text,
  region_code text,
  area_code text,
  brick_id text,
  units numeric,
  value numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select
    r.distributor_code, r.region_code, r.area_code, r.brick_id,
    sum(r.qty) as units,
    sum(r.qty * (1 - coalesce(r.discount, 0)) * coalesce(p.factory_price, 0)) as value
  from public.source_of_sales_import_rows r
  join public.source_of_sales_import_batches b on b.id = r.batch_id
  left join public.source_of_sales_products p
    on upper(btrim(p.product_code)) = upper(btrim(r.product_code))
  where b.status = 'validated' and r.invoice_period = b.period
    and (p_period is null or b.period = p_period)
  group by r.distributor_code, r.region_code, r.area_code, r.brick_id;
$$;

revoke all on function public.phx_exec_brick(text) from public, anon, authenticated;
grant execute on function public.phx_exec_brick(text) to service_role;

-- one row per (client_code, distributor) — same merge rule as the Customer Directory
create or replace function public.phx_exec_customers(p_period text default null)
returns table (
  client_code text,
  client_name text,
  distributor_code text,
  region_code text,
  area_code text,
  brick_id text,
  units numeric,
  value numeric
)
language sql
stable
security definer
set search_path = public
as $$
  with scoped as (
    select
      r.client_code, r.distributor_code, r.client_name, r.region_code, r.area_code,
      r.brick_id, r.qty, r.created_at,
      r.qty * (1 - coalesce(r.discount, 0)) * coalesce(p.factory_price, 0) as line_value
    from public.source_of_sales_import_rows r
    join public.source_of_sales_import_batches b on b.id = r.batch_id
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(r.product_code))
    where b.status = 'validated' and r.invoice_period = b.period
      and (p_period is null or b.period = p_period)
      and r.client_code is not null
  ),
  latest as (
    select distinct on (client_code, distributor_code)
      client_code, distributor_code, client_name, region_code, area_code, brick_id
    from scoped
    order by client_code, distributor_code, created_at desc
  ),
  agg as (
    select client_code, distributor_code, sum(qty) as units, sum(line_value) as value
    from scoped
    group by client_code, distributor_code
  )
  select a.client_code, l.client_name, a.distributor_code, l.region_code, l.area_code,
         l.brick_id, a.units, a.value
  from agg a
  join latest l using (client_code, distributor_code);
$$;

revoke all on function public.phx_exec_customers(text) from public, anon, authenticated;
grant execute on function public.phx_exec_customers(text) to service_role;

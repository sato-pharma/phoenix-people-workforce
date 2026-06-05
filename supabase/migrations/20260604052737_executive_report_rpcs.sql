-- Executive Report RPCs — company-wide (ALL lines) aggregates, nullable period (all-time when
-- null). Mirror the Monthly Closing comparison RPCs but drop the line filter. Value recomputed
-- Qty x (1 - discount) x live factory_price. Read-only, additive, reversible.

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
grant execute on function public.phx_exec_customers(text) to service_role;;

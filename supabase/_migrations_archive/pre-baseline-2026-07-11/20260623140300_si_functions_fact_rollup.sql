-- Rewrite Sales Intelligence functions to read from pre-computed fact rollup tables
-- instead of scanning raw source_of_sales_import_rows (410MB).
-- Impact: phx_si_distributor_product (~3.2% DB time), phx_si_period_totals (~2.6% DB time)
--
-- phx_si_period_totals customer_count:
--   Uses source_of_sales_customer_presence_rollup (one row per customer per period/line/region).
--   present_nonexcluded = true means the customer had ≥1 non-confidential product row
--   (LA003/LA004/SS001 excluded at refresh time), matching the intent of p_exclude_codes.

create or replace function public.phx_si_distributor_product(
  p_period        text    default null,
  p_exclude_codes text[]  default '{}',
  p_lines         text[]  default '{}',
  p_regions       text[]  default '{}'
)
returns table (
  distributor_code text,
  official_line    text,
  region_code      text,
  area_code        text,
  product_code     text,
  product_name     text,
  units            numeric,
  value            numeric
)
language sql
stable
security definer
set search_path = public
set statement_timeout = '45s'
as $$
  select
    f.distributor_code,
    f.official_line,
    f.region_code,
    coalesce(nullif(f.area_code, ''), 'DIRECT') as area_code,
    f.product_code,
    max(f.product_name)                         as product_name,
    sum(f.total_qty)                            as units,
    sum(case when f.is_direct
             then f.direct_value
             else f.effective_units * coalesce(p.factory_price, 0) end) as value
  from public.source_of_sales_fact_rollup f
  join public.source_of_sales_import_batches b
    on b.id = f.batch_id and b.status = 'validated'
  left join public.source_of_sales_products p
    on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
  where (p_period is null or f.period = p_period)
    and (
      cardinality(p_exclude_codes) = 0
      or upper(btrim(f.product_code)) <> all (
        select upper(btrim(c)) from unnest(p_exclude_codes) as c
      )
    )
    and (
      cardinality(p_lines) = 0
      or lower(btrim(f.official_line)) in (select lower(btrim(x)) from unnest(p_lines) as x)
    )
    and (
      cardinality(p_regions) = 0
      or lower(btrim(f.region_code)) in (select lower(btrim(x)) from unnest(p_regions) as x)
    )
  group by f.distributor_code, f.official_line, f.region_code,
           coalesce(nullif(f.area_code, ''), 'DIRECT'), f.product_code;
$$;

revoke execute on function public.phx_si_distributor_product(text, text[], text[], text[]) from public, anon, authenticated;
grant  execute on function public.phx_si_distributor_product(text, text[], text[], text[]) to service_role;


create or replace function public.phx_si_period_totals(
  p_exclude_codes text[] default '{}',
  p_lines         text[] default '{}',
  p_regions       text[] default '{}'
)
returns table (
  period         text,
  units          numeric,
  value          numeric,
  customer_count integer,
  product_count  integer,
  area_count     integer
)
language sql
stable
security definer
set search_path = public
set statement_timeout = '45s'
as $$
  with fact_agg as (
    select
      f.period,
      sum(f.total_qty) as units,
      sum(case when f.is_direct
               then f.direct_value
               else f.effective_units * coalesce(p.factory_price, 0) end) as value,
      count(distinct upper(btrim(f.product_code)))::integer      as product_count,
      count(distinct nullif(btrim(f.area_code), ''))::integer    as area_count
    from public.source_of_sales_fact_rollup f
    join public.source_of_sales_import_batches b
      on b.id = f.batch_id and b.status = 'validated'
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
    where (
        cardinality(p_exclude_codes) = 0
        or upper(btrim(f.product_code)) <> all (
          select upper(btrim(c)) from unnest(p_exclude_codes) as c
        )
      )
      and (
        cardinality(p_lines) = 0
        or lower(btrim(f.official_line)) in (select lower(btrim(x)) from unnest(p_lines) as x)
      )
      and (
        cardinality(p_regions) = 0
        or lower(btrim(f.region_code)) in (select lower(btrim(x)) from unnest(p_regions) as x)
      )
    group by f.period
  ),
  cust_agg as (
    select
      cp.period,
      count(distinct cp.client_code)::integer as customer_count
    from public.source_of_sales_customer_presence_rollup cp
    join public.source_of_sales_import_batches b
      on b.id = cp.batch_id and b.status = 'validated'
    where (cardinality(p_exclude_codes) = 0 or cp.present_nonexcluded = true)
      and (
        cardinality(p_lines) = 0
        or lower(btrim(cp.official_line)) in (select lower(btrim(x)) from unnest(p_lines) as x)
      )
      and (
        cardinality(p_regions) = 0
        or lower(btrim(cp.region_code)) in (select lower(btrim(x)) from unnest(p_regions) as x)
      )
    group by cp.period
  )
  select
    f.period,
    f.units,
    f.value,
    coalesce(c.customer_count, 0) as customer_count,
    f.product_count,
    f.area_count
  from fact_agg f
  left join cust_agg c on c.period = f.period;
$$;

revoke execute on function public.phx_si_period_totals(text[], text[], text[]) from public, anon, authenticated;
grant  execute on function public.phx_si_period_totals(text[], text[], text[]) to service_role;

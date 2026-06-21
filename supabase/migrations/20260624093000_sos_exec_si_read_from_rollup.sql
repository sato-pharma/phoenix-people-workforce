-- Phase 1 / Performance: cut the executive / sales-intelligence RPCs over to read
-- the pre-aggregated rollup instead of live-scanning source_of_sales_import_rows.
--
-- Signatures, return columns, attributes (STABLE SECURITY DEFINER, search_path,
-- statement_timeout) and output semantics are IDENTICAL to the previous bodies
-- (verified row-for-row via EXCEPT before applying this migration). Pricing stays
-- live: effective_units * current factory_price; direct rows use stored direct_value.

create or replace function public.phx_exec_distributor_product(p_period text default null::text)
 returns table(distributor_code text, official_line text, region_code text, area_code text, product_code text, product_name text, units numeric, value numeric)
 language sql
 stable security definer
 set search_path to 'public'
 set statement_timeout to '45s'
as $function$
  select
    f.distributor_code,
    f.official_line,
    f.region_code,
    coalesce(nullif(f.area_code, ''), 'DIRECT') as area_code,
    f.product_code,
    max(f.product_name) as product_name,
    sum(f.total_qty) as units,
    sum(case when f.is_direct
             then f.direct_value
             else f.effective_units * coalesce(p.factory_price, 0) end) as value
  from public.source_of_sales_fact_rollup f
  left join public.source_of_sales_products p
    on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
  where (p_period is null or f.period = p_period)
  group by f.distributor_code, f.official_line, f.region_code,
           coalesce(nullif(f.area_code, ''), 'DIRECT'), f.product_code;
$function$;

create or replace function public.phx_exec_brick(p_period text default null::text)
 returns table(distributor_code text, region_code text, area_code text, brick_id text, units numeric, value numeric)
 language sql
 stable security definer
 set search_path to 'public'
 set statement_timeout to '45s'
as $function$
  select
    f.distributor_code,
    f.region_code,
    f.area_code,
    f.brick_id,
    sum(f.total_qty) as units,
    sum(f.effective_units * coalesce(p.factory_price, 0)) as value
  from public.source_of_sales_fact_rollup f
  left join public.source_of_sales_products p
    on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
  where (p_period is null or f.period = p_period)
    and f.is_direct = false
  group by f.distributor_code, f.region_code, f.area_code, f.brick_id;
$function$;

create or replace function public.phx_si_period_totals(p_exclude_codes text[] default '{}'::text[], p_lines text[] default '{}'::text[], p_regions text[] default '{}'::text[])
 returns table(period text, units numeric, value numeric, customer_count integer, product_count integer, area_count integer)
 language sql
 stable security definer
 set search_path to 'public'
 set statement_timeout to '45s'
as $function$
  with flt as (
    select
      r.period,
      r.total_qty,
      r.effective_units,
      r.direct_value,
      r.is_direct,
      r.product_code,
      r.area_code,
      coalesce(p.factory_price, 0) as factory_price
    from public.source_of_sales_fact_rollup r
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(r.product_code))
    where upper(btrim(r.product_code)) <> all (
        select upper(btrim(c)) from unnest(p_exclude_codes) as c
      )
      and (
        cardinality(p_lines) = 0
        or lower(btrim(r.official_line)) in (select lower(btrim(x)) from unnest(p_lines) as x)
      )
      and (
        cardinality(p_regions) = 0
        or lower(btrim(r.region_code)) in (select lower(btrim(x)) from unnest(p_regions) as x)
      )
  ),
  val as (
    select
      period,
      sum(total_qty) as units,
      sum(case when is_direct then direct_value else effective_units * factory_price end) as value,
      count(distinct upper(btrim(product_code)))::integer as product_count,
      count(distinct nullif(btrim(area_code), ''))::integer as area_count
    from flt
    group by period
  ),
  cust as (
    select
      c.period,
      count(distinct c.client_code)::integer as customer_count
    from public.source_of_sales_customer_presence_rollup c
    where (case when cardinality(p_exclude_codes) = 0 then c.present_any else c.present_nonexcluded end)
      and (
        cardinality(p_lines) = 0
        or lower(btrim(c.official_line)) in (select lower(btrim(x)) from unnest(p_lines) as x)
      )
      and (
        cardinality(p_regions) = 0
        or lower(btrim(c.region_code)) in (select lower(btrim(x)) from unnest(p_regions) as x)
      )
    group by c.period
  )
  select
    v.period,
    v.units,
    v.value,
    coalesce(cu.customer_count, 0) as customer_count,
    v.product_count,
    v.area_count
  from val v
  left join cust cu on cu.period = v.period;
$function$;

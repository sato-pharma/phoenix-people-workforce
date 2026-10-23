-- phx_exec_customers: resolve the excluded product codes once, not once per row.
--
-- The filter read
--     upper(btrim(coalesce(product_code, ''))) <> all (
--       select upper(btrim(x)) from unnest(p_exclude_codes) as x)
-- and that bare sublink is planned as a SubPlan, so the Function Scan on unnest is
-- re-executed for EVERY row of public.source_of_sales_customer_directory_rollup + public.source_of_sales_fact_rollup.
-- Measured on production against public.source_of_sales_fact_rollup:
--     SubPlan   -> Function Scan on unnest, loops=295418, 1322 ms
--     InitPlan  -> Function Scan on unnest, loops=1,      357 ms
-- Both readings warm (shared hit=8304, zero reads), both keeping 61875 rows per worker
-- and removing 36598 - the row counts are identical, which is the equivalence at plan level.
--
-- Wrapping the same sublink in ARRAY( ) makes it uncorrelated-scalar, so the planner lifts
-- it to an InitPlan evaluated once per execution. ARRAY(subquery) yields '{}' for an empty
-- or NULL input - never NULL - so "<> all" stays TRUE when nothing is excluded, exactly as
-- the set form behaved. No coalesce is needed and none is added.
--
-- Equivalence proven BEFORE this migration was written:
--   * truth table over 7 array shapes x 4 probe values - 28/28 identical, NULL corners included;
--   * every row of analytics.sos_fact_all, source_of_sales_fact_rollup,
--     source_of_sales_customer_directory_rollup and source_of_sales_products - 853,159 rows -
--     compared under 5 array shapes: 4,265,795 comparisons, 0 differences;
--   * the edit is mechanically confined: stripping the inserted ARRAY( ) wrap reproduces the
--     live pg_get_functiondef output byte for byte, and the body grew by exactly 7 bytes per site.
--
-- The body below is production's own definition with that one wrap applied. Nothing else moved:
-- same signature, same volatility, same SECURITY DEFINER, same search_path and timeouts.
-- phx_closing_channel_totals already resolves the array once into a local variable and is
-- deliberately left alone; phx_exec_sos_trend does not carry this shape.

CREATE OR REPLACE FUNCTION public.phx_exec_customers(p_period text DEFAULT NULL::text, p_exclude_codes text[] DEFAULT ARRAY['LA003'::text, 'LA004'::text, 'SS001'::text], p_lines text[] DEFAULT NULL::text[], p_products text[] DEFAULT NULL::text[], p_regions text[] DEFAULT NULL::text[], p_areas text[] DEFAULT NULL::text[])
 RETURNS TABLE(client_code text, client_name text, distributor_code text, region_code text, area_code text, brick_id text, units numeric, value numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '45s'
 SET work_mem TO '96MB'
AS $function$
#variable_conflict use_column
begin
  return query
  with period_price as (
    select d.product_code || '|' || d.period as pair,
           public.phx_factory_price(d.product_code, d.period) as period_price
    from (
      select distinct r.product_code, r.period
      from public.source_of_sales_customer_directory_rollup r
      where (p_period is null or r.period = p_period)
      union
      select distinct f.product_code, f.period
      from public.source_of_sales_fact_rollup f
      where (p_period is null or f.period = p_period)
    ) d
  ),
  filtered as (
    select
      r.client_code, r.client_name, r.distributor_code, r.region_code, r.area_code, r.brick_id,
      r.latest_row_created_at, r.total_qty,
      case when r.is_direct then coalesce(r.direct_value, 0)
           else r.effective_units * coalesce(pp.period_price, 0) end as line_value
    from public.source_of_sales_customer_directory_rollup r
    join public.source_of_sales_import_batches b on b.id = r.batch_id and b.status = 'validated'
    left join public.source_of_sales_products p on upper(btrim(p.product_code)) = upper(btrim(r.product_code))
    left join period_price pp on pp.pair = r.product_code || '|' || r.period
    where (p_period is null or r.period = p_period)
      and r.client_code is not null
      and (cardinality(p_exclude_codes) = 0
           or upper(btrim(coalesce(r.product_code, ''))) <> all (array(select upper(btrim(x)) from unnest(p_exclude_codes) as x)))
      and (p_lines    is null or r.official_line = any(p_lines))
      and (p_products is null or r.product_code  = any(p_products))
      and (p_regions  is null or r.region_code   = any(p_regions))
      and (p_areas    is null or r.area_code     = any(p_areas))
  ),
  latest as (
    select distinct on (client_code, distributor_code)
      client_code, distributor_code, client_name, region_code, area_code, brick_id
    from filtered
    order by client_code, distributor_code, latest_row_created_at desc
  ),
  agg as (
    select client_code, distributor_code, sum(total_qty) as units, sum(line_value) as value
    from filtered group by client_code, distributor_code
  ),
  office as (
    select
      'OFFICE'::text as client_code,
      'Office'::text as client_name,
      'Office'::text as distributor_code,
      null::text as region_code,
      null::text as area_code,
      null::text as brick_id,
      sum(f.total_qty) as units,
      sum(f.effective_units * coalesce(pp.period_price, 0)) as value
    from public.source_of_sales_fact_rollup f
    join public.source_of_sales_import_batches b on b.id = f.batch_id and b.status = 'validated'
    left join public.source_of_sales_products p on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
    left join period_price pp on pp.pair = f.product_code || '|' || f.period
    where (p_period is null or f.period = p_period)
      and f.is_direct = false
      and upper(btrim(coalesce(f.distributor_code, ''))) = 'OFFICE'
      and (cardinality(p_exclude_codes) = 0
           or upper(btrim(coalesce(f.product_code, ''))) <> all (array(select upper(btrim(x)) from unnest(p_exclude_codes) as x)))
      and (p_lines    is null or f.official_line = any(p_lines))
      and (p_products is null or f.product_code  = any(p_products))
      and (p_regions  is null or f.region_code   = any(p_regions))
      and (p_areas    is null or f.area_code     = any(p_areas))
    having sum(f.total_qty) is not null
  )
  select a.client_code, l.client_name, a.distributor_code,
         l.region_code, l.area_code, l.brick_id, a.units, a.value
  from agg a join latest l using (client_code, distributor_code)
  union all
  select o.client_code, o.client_name, o.distributor_code,
         o.region_code, o.area_code, o.brick_id, o.units, o.value
  from office o;
end;
$function$;

-- The ACL is unchanged by `create or replace`, and production already carries exactly
-- `postgres=X/postgres | service_role=X/postgres` on this function. These two statements are
-- idempotent against that, and they are what makes the file say so on its own.
revoke execute on function public.phx_exec_customers(text, text[], text[], text[], text[], text[]) from public, anon, authenticated;
grant execute on function public.phx_exec_customers(text, text[], text[], text[], text[], text[]) to service_role;

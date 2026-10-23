-- phx_exec_distributor_product: resolve the excluded product codes once, not once per row.
--
-- The filter read
--     upper(btrim(coalesce(product_code, ''))) <> all (
--       select upper(btrim(x)) from unnest(p_exclude_codes) as x)
-- and that bare sublink is planned as a SubPlan, so the Function Scan on unnest is
-- re-executed for EVERY row of public.source_of_sales_fact_rollup.
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

CREATE OR REPLACE FUNCTION public.phx_exec_distributor_product(p_period text DEFAULT NULL::text, p_lines text[] DEFAULT '{}'::text[], p_distributors text[] DEFAULT '{}'::text[], p_regions text[] DEFAULT '{}'::text[], p_areas text[] DEFAULT '{}'::text[], p_products text[] DEFAULT '{}'::text[], p_exclude_codes text[] DEFAULT ARRAY['LA003'::text, 'LA004'::text, 'SS001'::text])
 RETURNS TABLE(distributor_code text, official_line text, region_code text, area_code text, product_code text, product_name text, units numeric, value numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '45s'
AS $function$
#variable_conflict use_column
begin
  if p_period is null then
    return query
    with period_price as (
      select d.product_code || '|' || d.period as pair,
             public.phx_factory_price(d.product_code, d.period) as period_price
      from (select distinct f.product_code, f.period from public.source_of_sales_fact_rollup f) d
    )
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
               else f.effective_units * coalesce(pp.period_price, 0) end) as value
    from public.source_of_sales_fact_rollup f
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
    left join period_price pp
      on pp.pair = f.product_code || '|' || f.period
    where (
        cardinality(p_lines) = 0
        or lower(btrim(coalesce(f.official_line, ''))) in (select lower(btrim(x)) from unnest(p_lines) as x)
      )
      and (
        cardinality(p_distributors) = 0
        or upper(btrim(coalesce(f.distributor_code, ''))) in (select upper(btrim(x)) from unnest(p_distributors) as x)
      )
      and (
        cardinality(p_regions) = 0
        or upper(btrim(coalesce(f.region_code, ''))) in (select upper(btrim(x)) from unnest(p_regions) as x)
      )
      and (
        cardinality(p_areas) = 0
        or upper(btrim(coalesce(nullif(f.area_code, ''), 'DIRECT'))) in (select upper(btrim(x)) from unnest(p_areas) as x)
      )
      and (
        cardinality(p_products) = 0
        or upper(btrim(coalesce(f.product_code, ''))) in (select upper(btrim(x)) from unnest(p_products) as x)
      )
      and (
        cardinality(p_exclude_codes) = 0
        or upper(btrim(coalesce(f.product_code, ''))) <> all (array(select upper(btrim(x)) from unnest(p_exclude_codes) as x))
      )
    group by f.distributor_code, f.official_line, f.region_code,
             coalesce(nullif(f.area_code, ''), 'DIRECT'), f.product_code;
  else
    return query
    with period_price as (
      select d.product_code || '|' || d.period as pair,
             public.phx_factory_price(d.product_code, d.period) as period_price
      from (
        select distinct f.product_code, f.period
        from public.source_of_sales_fact_rollup f
        where f.period = p_period
      ) d
    )
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
               else f.effective_units * coalesce(pp.period_price, 0) end) as value
    from public.source_of_sales_fact_rollup f
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
    left join period_price pp
      on pp.pair = f.product_code || '|' || f.period
    where f.period = p_period
      and (
        cardinality(p_lines) = 0
        or lower(btrim(coalesce(f.official_line, ''))) in (select lower(btrim(x)) from unnest(p_lines) as x)
      )
      and (
        cardinality(p_distributors) = 0
        or upper(btrim(coalesce(f.distributor_code, ''))) in (select upper(btrim(x)) from unnest(p_distributors) as x)
      )
      and (
        cardinality(p_regions) = 0
        or upper(btrim(coalesce(f.region_code, ''))) in (select upper(btrim(x)) from unnest(p_regions) as x)
      )
      and (
        cardinality(p_areas) = 0
        or upper(btrim(coalesce(nullif(f.area_code, ''), 'DIRECT'))) in (select upper(btrim(x)) from unnest(p_areas) as x)
      )
      and (
        cardinality(p_products) = 0
        or upper(btrim(coalesce(f.product_code, ''))) in (select upper(btrim(x)) from unnest(p_products) as x)
      )
      and (
        cardinality(p_exclude_codes) = 0
        or upper(btrim(coalesce(f.product_code, ''))) <> all (array(select upper(btrim(x)) from unnest(p_exclude_codes) as x))
      )
    group by f.distributor_code, f.official_line, f.region_code,
             coalesce(nullif(f.area_code, ''), 'DIRECT'), f.product_code;
  end if;
end;
$function$;

-- The ACL is unchanged by `create or replace`, and production already carries exactly
-- `postgres=X/postgres | service_role=X/postgres` on this function. These two statements are
-- idempotent against that, and they are what makes the file say so on its own.
revoke execute on function public.phx_exec_distributor_product(text, text[], text[], text[], text[], text[], text[]) from public, anon, authenticated;
grant execute on function public.phx_exec_distributor_product(text, text[], text[], text[], text[], text[], text[]) to service_role;

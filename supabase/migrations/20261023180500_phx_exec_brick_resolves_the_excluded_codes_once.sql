-- phx_exec_brick: resolve the excluded product codes once, not once per row.
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

CREATE OR REPLACE FUNCTION public.phx_exec_brick(p_period text DEFAULT NULL::text, p_exclude_codes text[] DEFAULT ARRAY['LA003'::text, 'LA004'::text, 'SS001'::text], p_lines text[] DEFAULT NULL::text[], p_products text[] DEFAULT NULL::text[], p_regions text[] DEFAULT NULL::text[], p_areas text[] DEFAULT NULL::text[])
 RETURNS TABLE(distributor_code text, region_code text, area_code text, brick_id text, units numeric, value numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '45s'
AS $function$
#variable_conflict use_column
begin
  return query
  with period_price as (
    select d.product_code || '|' || d.period as pair,
           public.phx_factory_price(d.product_code, d.period) as period_price
    from (
      select distinct f.product_code, f.period
      from public.source_of_sales_fact_rollup f
      where (p_period is null or f.period = p_period)
    ) d
  )
  select
    f.distributor_code,
    f.region_code,
    f.area_code,
    f.brick_id,
    sum(f.total_qty)                                      as units,
    sum(f.effective_units * coalesce(pp.period_price, 0)) as value
  from public.source_of_sales_fact_rollup f
  join public.source_of_sales_import_batches b
    on b.id = f.batch_id and b.status = 'validated'
  left join public.source_of_sales_products p
    on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
  left join period_price pp
    on pp.pair = f.product_code || '|' || f.period
  where (p_period is null or f.period = p_period)
    and f.is_direct = false
    and (
      cardinality(p_exclude_codes) = 0
      or upper(btrim(coalesce(f.product_code, ''))) <> all (array(
           select upper(btrim(x)) from unnest(p_exclude_codes) as x))
    )
    and (p_lines    is null or f.official_line = any(p_lines))
    and (p_products is null or f.product_code  = any(p_products))
    and (p_regions  is null or f.region_code   = any(p_regions))
    and (p_areas    is null or f.area_code     = any(p_areas))
  group by f.distributor_code, f.region_code, f.area_code, f.brick_id;
end;
$function$;

-- The ACL is unchanged by `create or replace`, and production already carries exactly
-- `postgres=X/postgres | service_role=X/postgres` on this function. These two statements are
-- idempotent against that, and they are what makes the file say so on its own.
revoke execute on function public.phx_exec_brick(text, text[], text[], text[], text[], text[]) from public, anon, authenticated;
grant execute on function public.phx_exec_brick(text, text[], text[], text[], text[], text[]) to service_role;

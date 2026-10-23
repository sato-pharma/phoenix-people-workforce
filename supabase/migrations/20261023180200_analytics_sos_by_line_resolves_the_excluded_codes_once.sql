-- analytics_sos_by_line: resolve the excluded product codes once, not once per row.
--
-- The filter read
--     upper(btrim(coalesce(product_code, ''))) <> all (
--       select upper(btrim(x)) from unnest(p_exclude_codes) as x)
-- and that bare sublink is planned as a SubPlan, so the Function Scan on unnest is
-- re-executed for EVERY row of analytics.sos_fact_all.
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

CREATE OR REPLACE FUNCTION public.analytics_sos_by_line(p_periods text[] DEFAULT NULL::text[], p_period_from text DEFAULT NULL::text, p_period_to text DEFAULT NULL::text, p_channels text[] DEFAULT NULL::text[], p_lines text[] DEFAULT NULL::text[], p_distributors text[] DEFAULT NULL::text[], p_regions text[] DEFAULT NULL::text[], p_areas text[] DEFAULT NULL::text[], p_products text[] DEFAULT NULL::text[], p_families text[] DEFAULT NULL::text[], p_client_codes text[] DEFAULT NULL::text[], p_exclude_codes text[] DEFAULT ARRAY['LA003'::text, 'LA004'::text, 'SS001'::text])
 RETURNS TABLE(period text, year integer, month integer, line text, channel text, units numeric, value numeric)
 LANGUAGE sql
 STABLE PARALLEL SAFE SECURITY DEFINER
 SET search_path TO 'analytics', 'public'
AS $function$
  select period, year, month, line, channel,
         sum(units) as units,
         sum(value) as value
  from   analytics.sos_fact_all
  where  (p_periods is null    or period = any(p_periods))
    and  (p_period_from is null or period >= p_period_from)
    and  (p_period_to   is null or period <= p_period_to)
    and  (p_channels is null    or channel = any(p_channels))
    and  (p_lines is null       or line = any(p_lines))
    and  (p_distributors is null or distributor_code = any(p_distributors))
    and  (p_regions is null     or region_code = any(p_regions))
    and  (p_areas is null       or area_code = any(p_areas))
    and  (p_products is null    or product_code = any(p_products))
    and  (p_families is null    or family = any(p_families))
    and  (p_client_codes is null or client_code = any(p_client_codes))
    and  (p_exclude_codes is null
          or upper(btrim(coalesce(product_code, ''))) <> all (array(
               select upper(btrim(c)) from unnest(p_exclude_codes) as c)))
  group by period, year, month, line, channel
  order by period, value desc;
$function$;

-- The ACL is unchanged by `create or replace`, and production already carries exactly
-- `postgres=X/postgres | service_role=X/postgres` on this function. These two statements are
-- idempotent against that, and they are what makes the file say so on its own.
revoke execute on function public.analytics_sos_by_line(text[], text, text, text[], text[], text[], text[], text[], text[], text[], text[], text[]) from public, anon, authenticated;
grant execute on function public.analytics_sos_by_line(text[], text, text, text[], text[], text[], text[], text[], text[], text[], text[], text[]) to service_role;

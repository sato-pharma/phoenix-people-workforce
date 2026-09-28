-- phx_exec_sos_trend_reads_the_period_price
--
-- WHAT THIS CHANGES: `public.phx_exec_sos_trend` now takes its factory price from
--   public.phx_factory_price(product_code, period) instead of reading
--   source_of_sales_products.factory_price straight off the product master. Byte-identical to the
--   body on production apart from that one expression, and only where it VALUES a row.
--
-- WHY: owner instruction 2026-09-28, repricing Saginko — direct orders from that day, "the sales
--   and target of the retail to be adjusted from 1 October". The resolver falls back to the master
--   price when no override covers the period, so a product without an override row is valued
--   exactly as before and this file moves no number on its own. Rationale, the override table and
--   the resolver: 20260928184100_period_scoped_factory_prices.sql.
--
--   One function per file on purpose: several guards in tests/ resolve "the newest migration that
--   defines X" and then read that whole file, so a bundle of 31 functions makes one function's SQL
--   answer for another's.
--
-- ROLLBACK: re-apply the previous definition. The cheaper undo is to drop the override row —
--   delete from public.source_of_sales_product_price_history where product_code = 'SA001';
--   which restores the old valuation everywhere without touching a function.

begin;

create or replace function public.phx_exec_sos_trend(p_periods text[] DEFAULT '{}'::text[], p_lines text[] DEFAULT '{}'::text[], p_distributors text[] DEFAULT '{}'::text[], p_regions text[] DEFAULT '{}'::text[], p_areas text[] DEFAULT '{}'::text[], p_products text[] DEFAULT '{}'::text[], p_exclude_codes text[] DEFAULT ARRAY['LA003'::text, 'LA004'::text, 'SS001'::text])
 RETURNS TABLE(period text, units numeric, value numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '45s'
AS $function$
#variable_conflict use_column
declare
  -- Normalised ONCE, exactly as the old per-row sub-selects normalised them.
  v_lines         text[] := array(select lower(btrim(x)) from unnest(p_lines) as x);
  v_distributors  text[] := array(select upper(btrim(x)) from unnest(p_distributors) as x);
  v_regions       text[] := array(select upper(btrim(x)) from unnest(p_regions) as x);
  v_areas         text[] := array(select upper(btrim(x)) from unnest(p_areas) as x);
  v_products      text[] := array(select upper(btrim(x)) from unnest(p_products) as x);
  v_exclude_codes text[] := array(select upper(btrim(x)) from unnest(p_exclude_codes) as x);
begin
  if cardinality(p_lines) > 0 and not coalesce('' = any(v_lines), false) then
    -- Line-scoped and no blank line asked for: read only those lines' rows, on the line index.
    return query
    select
      g.period,
      sum(g.q) as units,
      sum(case when g.is_direct
               then g.dv
               else g.eu * coalesce(public.phx_factory_price(g.product_code, g.period), 0) end) as value
    from (
      select
        f.period,
        f.official_line,
        case when cardinality(p_distributors) = 0 then null else f.distributor_code end as distributor_code,
        case when cardinality(p_regions) = 0 then null else f.region_code end as region_code,
        case when cardinality(p_areas) = 0 then null else f.area_code end as area_code,
        f.product_code,
        f.is_direct,
        sum(f.total_qty) as q,
        sum(f.effective_units) as eu,
        sum(f.direct_value) as dv
      from public.source_of_sales_fact_rollup f
      where lower(btrim(f.official_line)) = any (v_lines)
        and (cardinality(p_periods) = 0 or f.period = any (p_periods))
      group by 1, 2, 3, 4, 5, 6, 7
      offset 0 -- keeps the per-group predicates below from being pushed back down onto every row
    ) g
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(g.product_code))
    where (
        cardinality(p_lines) = 0
        or lower(btrim(coalesce(g.official_line, ''))) = any (v_lines)
      )
      and (
        cardinality(p_distributors) = 0
        or upper(btrim(coalesce(g.distributor_code, ''))) = any (v_distributors)
      )
      and (
        cardinality(p_regions) = 0
        or upper(btrim(coalesce(g.region_code, ''))) = any (v_regions)
      )
      and (
        cardinality(p_areas) = 0
        or upper(btrim(coalesce(nullif(g.area_code, ''), 'DIRECT'))) = any (v_areas)
      )
      and (
        cardinality(p_products) = 0
        or upper(btrim(coalesce(g.product_code, ''))) = any (v_products)
      )
      and (
        cardinality(p_exclude_codes) = 0
        or upper(btrim(coalesce(g.product_code, ''))) <> all (v_exclude_codes)
      )
    group by g.period;
  else
    return query
    select
      g.period,
      sum(g.q) as units,
      sum(case when g.is_direct
               then g.dv
               else g.eu * coalesce(public.phx_factory_price(g.product_code, g.period), 0) end) as value
    from (
      select
        f.period,
        case when cardinality(p_lines) = 0 then null else f.official_line end as official_line,
        case when cardinality(p_distributors) = 0 then null else f.distributor_code end as distributor_code,
        case when cardinality(p_regions) = 0 then null else f.region_code end as region_code,
        case when cardinality(p_areas) = 0 then null else f.area_code end as area_code,
        f.product_code,
        f.is_direct,
        sum(f.total_qty) as q,
        sum(f.effective_units) as eu,
        sum(f.direct_value) as dv
      from public.source_of_sales_fact_rollup f
      where (cardinality(p_periods) = 0 or f.period = any (p_periods))
      group by 1, 2, 3, 4, 5, 6, 7
      offset 0 -- keeps the per-group predicates below from being pushed back down onto every row
    ) g
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(g.product_code))
    where (
        cardinality(p_lines) = 0
        or lower(btrim(coalesce(g.official_line, ''))) = any (v_lines)
      )
      and (
        cardinality(p_distributors) = 0
        or upper(btrim(coalesce(g.distributor_code, ''))) = any (v_distributors)
      )
      and (
        cardinality(p_regions) = 0
        or upper(btrim(coalesce(g.region_code, ''))) = any (v_regions)
      )
      and (
        cardinality(p_areas) = 0
        or upper(btrim(coalesce(nullif(g.area_code, ''), 'DIRECT'))) = any (v_areas)
      )
      and (
        cardinality(p_products) = 0
        or upper(btrim(coalesce(g.product_code, ''))) = any (v_products)
      )
      and (
        cardinality(p_exclude_codes) = 0
        or upper(btrim(coalesce(g.product_code, ''))) <> all (v_exclude_codes)
      )
    group by g.period;
  end if;
end;
$function$;

revoke execute on function public.phx_exec_sos_trend(text[], text[], text[], text[], text[], text[], text[]) from public, anon, authenticated;
grant execute on function public.phx_exec_sos_trend(text[], text[], text[], text[], text[], text[], text[]) to service_role;

commit;

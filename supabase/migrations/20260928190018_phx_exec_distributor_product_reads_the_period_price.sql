-- phx_exec_distributor_product_reads_the_period_price
--
-- WHAT THIS CHANGES: `public.phx_exec_distributor_product` now takes its factory price from
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

create or replace function public.phx_exec_distributor_product(p_period text DEFAULT NULL::text, p_lines text[] DEFAULT '{}'::text[], p_distributors text[] DEFAULT '{}'::text[], p_regions text[] DEFAULT '{}'::text[], p_areas text[] DEFAULT '{}'::text[], p_products text[] DEFAULT '{}'::text[], p_exclude_codes text[] DEFAULT ARRAY['LA003'::text, 'LA004'::text, 'SS001'::text])
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
               else f.effective_units * coalesce(public.phx_factory_price(f.product_code, f.period), 0) end) as value
    from public.source_of_sales_fact_rollup f
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
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
        or upper(btrim(coalesce(f.product_code, ''))) <> all (select upper(btrim(x)) from unnest(p_exclude_codes) as x)
      )
    group by f.distributor_code, f.official_line, f.region_code,
             coalesce(nullif(f.area_code, ''), 'DIRECT'), f.product_code;
  else
    return query
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
               else f.effective_units * coalesce(public.phx_factory_price(f.product_code, f.period), 0) end) as value
    from public.source_of_sales_fact_rollup f
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
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
        or upper(btrim(coalesce(f.product_code, ''))) <> all (select upper(btrim(x)) from unnest(p_exclude_codes) as x)
      )
    group by f.distributor_code, f.official_line, f.region_code,
             coalesce(nullif(f.area_code, ''), 'DIRECT'), f.product_code;
  end if;
end;
$function$;

revoke execute on function public.phx_exec_distributor_product(text, text[], text[], text[], text[], text[], text[]) from public, anon, authenticated;
grant execute on function public.phx_exec_distributor_product(text, text[], text[], text[], text[], text[], text[]) to service_role;

commit;

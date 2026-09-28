-- phx_closing_distributor_product_reads_the_period_price
--
-- WHAT THIS CHANGES: `public.phx_closing_distributor_product` now takes its factory price from
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

create or replace function public.phx_closing_distributor_product(p_line text, p_period text)
 RETURNS TABLE(distributor_code text, region_code text, area_code text, product_code text, product_name text, units numeric, value numeric)
 LANGUAGE sql
 STABLE PARALLEL SAFE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '45s'
AS $function$
  select
    r.distributor_code,
    r.region_code,
    r.area_code,
    r.product_code,
    max(r.product_name)                                     as product_name,
    sum(r.units_qty)                                        as units,
    sum(r.eff_units * coalesce(public.phx_factory_price(r.product_code, p_period), 0))         as value
  from public.source_of_sales_distributor_product_rollup r
  left join public.source_of_sales_products p
    on upper(btrim(p.product_code)) = upper(btrim(r.product_code))
  where r.period = p_period
    and r.line_key = lower(btrim(p_line))
  group by r.distributor_code, r.region_code, r.area_code, r.product_code;
$function$;

revoke execute on function public.phx_closing_distributor_product(text, text) from public, anon, authenticated;
grant execute on function public.phx_closing_distributor_product(text, text) to service_role;

commit;

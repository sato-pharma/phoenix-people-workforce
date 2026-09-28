-- phx_monthly_closing_matrix_reads_the_period_price
--
-- WHAT THIS CHANGES: `public.phx_monthly_closing_matrix` now takes its factory price from
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

create or replace function public.phx_monthly_closing_matrix(p_line text, p_period text)
 RETURNS TABLE(area_code text, product_code text, sales_units numeric, sales_value numeric)
 LANGUAGE sql
 STABLE PARALLEL SAFE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '45s'
AS $function$
  select
    f.area_code, f.product_code,
    sum(f.total_qty)                                       as sales_units,
    sum(f.effective_units * coalesce(public.phx_factory_price(f.product_code, f.period), 0)) as sales_value
  from public.source_of_sales_fact_rollup f
  join public.source_of_sales_import_batches b
    on b.id = f.batch_id and b.status = 'validated'
  left join public.source_of_sales_products p
    on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
  where f.period = p_period
    and lower(btrim(f.official_line)) = lower(btrim(p_line))
    and not f.is_direct
    and upper(btrim(coalesce(f.product_code, ''))) not in ('LA003', 'LA004', 'SS001')
  group by f.area_code, f.product_code;
$function$;

revoke execute on function public.phx_monthly_closing_matrix(text, text) from public, anon, authenticated;
grant execute on function public.phx_monthly_closing_matrix(text, text) to service_role;
grant execute on function public.phx_monthly_closing_matrix(text, text) to analytics_readonly;

commit;

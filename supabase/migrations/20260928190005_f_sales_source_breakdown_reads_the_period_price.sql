-- f_sales_source_breakdown_reads_the_period_price
--
-- WHAT THIS CHANGES: `au.f_sales_source_breakdown` now takes its factory price from
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

create or replace function au.f_sales_source_breakdown(p_period text, p_line_code text, p_area_code text, p_product_code text DEFAULT NULL::text)
 RETURNS TABLE(product_code text, product_name text, distributor_name text, brick_name text, units numeric, value numeric)
 LANGUAGE sql
 STABLE PARALLEL SAFE SECURITY DEFINER
 SET search_path TO 'au', 'public'
AS $function$
  select
    upper(btrim(f.product_code)) as product_code,
    max(coalesce(p.product_name, f.product_name)) as product_name,
    coalesce(d.distributor_name, f.distributor_code, '(unknown distributor)') as distributor_name,
    coalesce(nullif(btrim(b.brick_name), ''), '(no brick)') as brick_name,
    sum(f.total_qty) as units,
    sum(f.effective_units * coalesce(public.phx_factory_price(f.product_code, f.period), 0)) as value
  from public.source_of_sales_fact_rollup f
  join public.source_of_sales_import_batches ib on ib.id = f.batch_id and ib.status = 'validated'
  join au.sos_official_line_map lm on lower(btrim(lm.official_line)) = lower(btrim(f.official_line)) and lm.line_code = p_line_code
  left join public.source_of_sales_distributors d on d.distributor_code = f.distributor_code
  left join public.source_of_sales_bricks b on b.brick_id = f.brick_id
  left join public.source_of_sales_products p on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
  where f.period = p_period
    and not f.is_direct
    and f.area_code = p_area_code
    and (p_product_code is null or upper(btrim(f.product_code)) = upper(btrim(p_product_code)))
    and upper(btrim(coalesce(f.product_code,''))) not in ('LA003','LA004','SS001')
  group by upper(btrim(f.product_code)),
           coalesce(d.distributor_name, f.distributor_code, '(unknown distributor)'),
           coalesce(nullif(btrim(b.brick_name), ''), '(no brick)')
  having sum(f.total_qty) <> 0 or sum(f.effective_units * coalesce(public.phx_factory_price(f.product_code, f.period),0)) <> 0
  order by value desc, units desc;
$function$;

commit;

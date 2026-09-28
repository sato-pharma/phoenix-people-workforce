-- f_monthly_attribution_reconcile_reads_the_period_price
--
-- WHAT THIS CHANGES: `au.f_monthly_attribution_reconcile` now takes its factory price from
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

create or replace function au.f_monthly_attribution_reconcile(p_period text)
 RETURNS TABLE(line_code text, mapped_value numeric, unmapped_value numeric, attributed_value numeric, raw_value numeric, diff numeric)
 LANGUAGE sql
 STABLE PARALLEL SAFE SECURITY DEFINER
 SET search_path TO 'au', 'public'
AS $function$
  with att as (
    select coalesce(a.line_code,'(unmapped)') as line_code,
           sum(a.sales_value) filter (where a.mapped)     as mapped_value,
           sum(a.sales_value) filter (where not a.mapped)  as unmapped_value,
           sum(a.sales_value)                              as attributed_value
    from au.f_monthly_attribution(p_period) a
    group by coalesce(a.line_code,'(unmapped)')
  ),
  raw as (
    select coalesce(lm.line_code,'(unmapped)') as line_code,
           sum(case when f.is_direct then f.direct_value
                    else f.effective_units * coalesce(public.phx_factory_price(f.product_code, f.period),0) end) as raw_value
    from public.source_of_sales_fact_rollup f
    join public.source_of_sales_import_batches b on b.id = f.batch_id and b.status = 'validated'
    left join au.sos_official_line_map lm on lower(btrim(lm.official_line)) = lower(btrim(f.official_line))
    left join public.source_of_sales_products pp on upper(btrim(pp.product_code)) = upper(btrim(f.product_code))
    where f.period = p_period
      and upper(btrim(coalesce(f.product_code,''))) not in ('LA003','LA004','SS001')
    group by coalesce(lm.line_code,'(unmapped)')
  )
  select
    coalesce(att.line_code, raw.line_code)          as line_code,
    coalesce(att.mapped_value,0)                    as mapped_value,
    coalesce(att.unmapped_value,0)                  as unmapped_value,
    coalesce(att.attributed_value,0)                as attributed_value,
    coalesce(raw.raw_value,0)                       as raw_value,
    coalesce(att.attributed_value,0) - coalesce(raw.raw_value,0) as diff
  from att
  full join raw on raw.line_code = att.line_code
  order by 1;
$function$;

commit;

-- phx_closing_publication_snapshot_reads_the_period_price
--
-- WHAT THIS CHANGES: `public.phx_closing_publication_snapshot` now takes its factory price from
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

create or replace function public.phx_closing_publication_snapshot(p_line text, p_period text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE PARALLEL SAFE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with cells as (
    select f.area_code, f.product_code, coalesce(f.is_direct, false) as is_direct,
           sum(f.total_qty) as units,
           sum(case when coalesce(f.is_direct, false)
                    then coalesce(f.direct_value, 0)
                    else f.effective_units * coalesce(public.phx_factory_price(f.product_code, f.period), 0)
               end) as value
    from source_of_sales_fact_rollup f
    left join source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
    where f.period = p_period
      and lower(btrim(regexp_replace(f.official_line, '\s+', ' ', 'g'))) = lower(btrim(regexp_replace(p_line, '\s+', ' ', 'g')))
    group by 1, 2, 3
    having sum(f.total_qty) <> 0
  )
  select jsonb_build_object(
    'units', coalesce((select sum(units) from cells), 0),
    'value', coalesce((select sum(value) from cells), 0),
    'cells', (select count(*) from cells),
    'breakdown', coalesce((
      select jsonb_agg(jsonb_build_object('a', area_code, 'p', product_code, 'd', is_direct,
                                          'u', units, 'v', value)
                       order by area_code, product_code, is_direct)
      from cells
    ), '[]'::jsonb)
  );
$function$;

revoke execute on function public.phx_closing_publication_snapshot(text, text) from public, anon, authenticated;
grant execute on function public.phx_closing_publication_snapshot(text, text) to service_role;

commit;

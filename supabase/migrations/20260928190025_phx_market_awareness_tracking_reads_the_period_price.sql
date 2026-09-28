-- phx_market_awareness_tracking_reads_the_period_price
--
-- WHAT THIS CHANGES: `public.phx_market_awareness_tracking` now takes its factory price from
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

create or replace function public.phx_market_awareness_tracking(p_line_code text, p_from_period text, p_to_period text, p_area_code text, p_brick_ids text[], p_product_codes text[])
 RETURNS TABLE(period text, scope text, indirect_units numeric, indirect_value numeric, direct_units numeric, direct_value numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '45s'
AS $function$
  with rows_in_window as (
    select
      f.period,
      f.area_code,
      f.brick_id,
      f.is_direct,
      f.total_qty,
      f.effective_units,
      f.direct_value,
      f.product_code
    from public.source_of_sales_fact_rollup f
    join public.source_of_sales_import_batches b
      on b.id = f.batch_id and b.status = 'validated'
    where f.period between p_from_period and p_to_period
      and lower(btrim(f.official_line)) in (
        select lower(btrim(m.official_line))
        from au.sos_official_line_map m
        where lower(btrim(m.line_code)) = lower(btrim(p_line_code))
      )
      and upper(btrim(f.product_code)) = any (
        select upper(btrim(code)) from unnest(p_product_codes) as code
      )
      and (
        not f.is_direct
        or upper(btrim(coalesce(f.product_code, ''))) not in ('LA003', 'LA004', 'SS001')
      )
      and not (f.is_direct and f.period = '2026-07')
  ),
  priced as (
    select
      r.*,
      r.effective_units * coalesce(public.phx_factory_price(r.product_code, r.period), 0) as indirect_value
    from rows_in_window r
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(r.product_code))
  ),
  scoped as (
    select 'brick'::text as scope, * from priced
     where brick_id = any (p_brick_ids)
    union all
    select 'area'::text, * from priced
     where btrim(area_code) = btrim(p_area_code)
    union all
    select 'area_bricked'::text, * from priced
     where btrim(area_code) = btrim(p_area_code)
       and brick_id is not null
       and btrim(brick_id) <> ''
  )
  select
    s.period,
    s.scope,
    coalesce(sum(s.total_qty)      filter (where not s.is_direct), 0) as indirect_units,
    coalesce(sum(s.indirect_value) filter (where not s.is_direct), 0) as indirect_value,
    coalesce(sum(s.total_qty)      filter (where s.is_direct), 0)     as direct_units,
    coalesce(sum(s.direct_value)   filter (where s.is_direct), 0)     as direct_value
  from scoped s
  group by s.period, s.scope;
$function$;

revoke execute on function public.phx_market_awareness_tracking(text, text, text, text, text[], text[]) from public, anon, authenticated;
grant execute on function public.phx_market_awareness_tracking(text, text, text, text, text[], text[]) to service_role;

commit;

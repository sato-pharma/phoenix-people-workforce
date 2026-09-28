-- phx_closing_customers_reads_the_period_price
--
-- WHAT THIS CHANGES: `public.phx_closing_customers` now takes its factory price from
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

create or replace function public.phx_closing_customers(p_line text, p_period text)
 RETURNS TABLE(client_code text, client_name text, distributor_code text, region_code text, area_code text, brick_id text, units numeric, value numeric)
 LANGUAGE sql
 STABLE PARALLEL SAFE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '45s'
AS $function$
  with agg as (
    select
      f.client_code,
      f.distributor_code,
      nullif(f.region_code, '') as fact_region,
      nullif(f.area_code, '')   as fact_area,
      nullif(f.brick_id, '')    as fact_brick,
      sum(f.total_qty) as units,
      sum(
        case
          when coalesce(f.is_direct, false) then coalesce(f.direct_value, 0)
          else f.effective_units * coalesce(public.phx_factory_price(f.product_code, f.period), 0)
        end
      ) as value
    from public.source_of_sales_fact_rollup f
    join public.source_of_sales_import_batches b
      on b.id = f.batch_id and b.status = 'validated'
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
    where f.period = p_period
      and lower(btrim(f.official_line)) = lower(btrim(p_line))
      and f.client_code is not null
      and upper(btrim(coalesce(f.product_code, ''))) not in ('LA003', 'LA004', 'SS001')
    group by
      f.client_code, f.distributor_code,
      nullif(f.region_code, ''), nullif(f.area_code, ''), nullif(f.brick_id, '')
  )
  select
    a.client_code,
    coalesce(cm.customer_name, '') as client_name,
    a.distributor_code,
    coalesce(a.fact_region, cm.region_code) as region_code,
    coalesce(a.fact_area,   cm.area_code)   as area_code,
    coalesce(a.fact_brick,  cm.brick_id)    as brick_id,
    a.units,
    a.value
  from agg a
  left join public.source_of_sales_customer_map cm
    on cm.distributor_code = a.distributor_code
   and cm.customer_code    = a.client_code
   and cm.active;
$function$;

revoke execute on function public.phx_closing_customers(text, text) from public, anon, authenticated;
grant execute on function public.phx_closing_customers(text, text) to service_role;

commit;

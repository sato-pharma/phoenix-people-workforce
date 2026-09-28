-- phx_territory_area_pharmacies_reads_the_period_price
--
-- WHAT THIS CHANGES: `public.phx_territory_area_pharmacies` now takes its factory price from
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

create or replace function public.phx_territory_area_pharmacies(p_area_codes text[], p_periods text[], p_lines text[])
 RETURNS TABLE(brick_id text, client_code text, client_name text, official_line text, product_code text, product_name text, period text, units numeric, value numeric, scope_total_units numeric, scope_total_value numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '30s'
AS $function$
#variable_conflict use_column
begin
  return query
  with filtered as (
    select
      coalesce(nullif(btrim(r.brick_id), ''), '(unmapped)') as brick_id,
      r.client_code,
      r.client_name,
      coalesce(nullif(btrim(r.official_line), ''), 'Unknown') as official_line,
      coalesce(nullif(btrim(r.product_code), ''), '') as product_code,
      coalesce(nullif(btrim(p.product_name), ''), 'Unknown product') as product_name,
      r.period,
      r.latest_row_created_at,
      r.effective_units as row_units,
      case when r.is_direct then coalesce(r.direct_value, 0)
           else r.effective_units * coalesce(public.phx_factory_price(r.product_code, r.period), 0) end as row_value
    from public.source_of_sales_customer_directory_rollup r
    join public.source_of_sales_import_batches b
      on b.id = r.batch_id and b.status = 'validated'
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(r.product_code))
    where upper(btrim(coalesce(r.area_code, ''))) in (
        select upper(btrim(x)) from unnest(p_area_codes) as x
      )
      and r.period = any (p_periods)
      and r.client_code is not null
      and (
        cardinality(p_lines) = 0
        or lower(btrim(coalesce(r.official_line, ''))) in (
          select lower(btrim(x)) from unnest(p_lines) as x
        )
      )
      and upper(btrim(coalesce(r.product_code, ''))) not in ('LA003', 'LA004', 'SS001')
  ),
  latest_name as (
    select distinct on (client_code) client_code, client_name
    from filtered
    where client_name is not null
    order by client_code, latest_row_created_at desc
  ),
  agg as (
    select brick_id, client_code, official_line, product_code, product_name, period,
           sum(row_units) as units, sum(row_value) as value
    from filtered
    group by brick_id, client_code, official_line, product_code, product_name, period
  )
  select
    a.brick_id,
    a.client_code,
    coalesce(ln.client_name, 'Unknown'),
    a.official_line,
    a.product_code,
    a.product_name,
    a.period,
    a.units,
    a.value,
    sum(a.units) over (),
    sum(a.value) over ()
  from agg a
  left join latest_name ln using (client_code);
end;
$function$;

revoke execute on function public.phx_territory_area_pharmacies(text[], text[], text[]) from public, anon, authenticated;
grant execute on function public.phx_territory_area_pharmacies(text[], text[], text[]) to service_role;

commit;

-- phx_exec_customers_reads_the_period_price
--
-- WHAT THIS CHANGES: `public.phx_exec_customers` now takes its factory price from
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

create or replace function public.phx_exec_customers(p_period text DEFAULT NULL::text, p_exclude_codes text[] DEFAULT ARRAY['LA003'::text, 'LA004'::text, 'SS001'::text], p_lines text[] DEFAULT NULL::text[], p_products text[] DEFAULT NULL::text[], p_regions text[] DEFAULT NULL::text[], p_areas text[] DEFAULT NULL::text[])
 RETURNS TABLE(client_code text, client_name text, distributor_code text, region_code text, area_code text, brick_id text, units numeric, value numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '45s'
 SET work_mem TO '96MB'
AS $function$
#variable_conflict use_column
begin
  return query
  with filtered as (
    select
      r.client_code, r.client_name, r.distributor_code, r.region_code, r.area_code, r.brick_id,
      r.latest_row_created_at, r.total_qty,
      case when r.is_direct then coalesce(r.direct_value, 0)
           else r.effective_units * coalesce(public.phx_factory_price(r.product_code, r.period), 0) end as line_value
    from public.source_of_sales_customer_directory_rollup r
    join public.source_of_sales_import_batches b on b.id = r.batch_id and b.status = 'validated'
    left join public.source_of_sales_products p on upper(btrim(p.product_code)) = upper(btrim(r.product_code))
    where (p_period is null or r.period = p_period)
      and r.client_code is not null
      and (cardinality(p_exclude_codes) = 0
           or upper(btrim(coalesce(r.product_code, ''))) <> all (select upper(btrim(x)) from unnest(p_exclude_codes) as x))
      and (p_lines    is null or r.official_line = any(p_lines))
      and (p_products is null or r.product_code  = any(p_products))
      and (p_regions  is null or r.region_code   = any(p_regions))
      and (p_areas    is null or r.area_code     = any(p_areas))
  ),
  latest as (
    select distinct on (client_code, distributor_code)
      client_code, distributor_code, client_name, region_code, area_code, brick_id
    from filtered
    order by client_code, distributor_code, latest_row_created_at desc
  ),
  agg as (
    select client_code, distributor_code, sum(total_qty) as units, sum(line_value) as value
    from filtered group by client_code, distributor_code
  ),
  office as (
    select
      'OFFICE'::text as client_code,
      'Office'::text as client_name,
      'Office'::text as distributor_code,
      null::text as region_code,
      null::text as area_code,
      null::text as brick_id,
      sum(f.total_qty) as units,
      sum(f.effective_units * coalesce(public.phx_factory_price(f.product_code, f.period), 0)) as value
    from public.source_of_sales_fact_rollup f
    join public.source_of_sales_import_batches b on b.id = f.batch_id and b.status = 'validated'
    left join public.source_of_sales_products p on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
    where (p_period is null or f.period = p_period)
      and f.is_direct = false
      and upper(btrim(coalesce(f.distributor_code, ''))) = 'OFFICE'
      and (cardinality(p_exclude_codes) = 0
           or upper(btrim(coalesce(f.product_code, ''))) <> all (select upper(btrim(x)) from unnest(p_exclude_codes) as x))
      and (p_lines    is null or f.official_line = any(p_lines))
      and (p_products is null or f.product_code  = any(p_products))
      and (p_regions  is null or f.region_code   = any(p_regions))
      and (p_areas    is null or f.area_code     = any(p_areas))
    having sum(f.total_qty) is not null
  )
  select a.client_code, l.client_name, a.distributor_code,
         l.region_code, l.area_code, l.brick_id, a.units, a.value
  from agg a join latest l using (client_code, distributor_code)
  union all
  select o.client_code, o.client_name, o.distributor_code,
         o.region_code, o.area_code, o.brick_id, o.units, o.value
  from office o;
end;
$function$;

revoke execute on function public.phx_exec_customers(text, text[], text[], text[], text[], text[]) from public, anon, authenticated;
grant execute on function public.phx_exec_customers(text, text[], text[], text[], text[], text[]) to service_role;

commit;

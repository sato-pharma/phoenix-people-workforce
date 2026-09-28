-- phx_customer_directory_reads_the_period_price
--
-- WHAT THIS CHANGES: `public.phx_customer_directory` now takes its factory price from
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

create or replace function public.phx_customer_directory(p_region_codes text[] DEFAULT NULL::text[], p_area_codes text[] DEFAULT NULL::text[], p_brick_codes text[] DEFAULT NULL::text[], p_distributor_codes text[] DEFAULT NULL::text[], p_from_period text DEFAULT NULL::text, p_to_period text DEFAULT NULL::text, p_exclude_codes text[] DEFAULT ARRAY['LA003'::text, 'LA004'::text, 'SS001'::text])
 RETURNS TABLE(client_code text, client_name text, client_address text, distributor_code text, brick_id text, area_code text, region_code text, total_units numeric, total_value numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '45s'
 SET work_mem TO '128MB'
AS $function$
  with filtered as materialized (
    select
      c.client_code,
      c.client_name,
      c.client_address,
      c.distributor_code,
      c.brick_id,
      c.area_code,
      c.region_code,
      c.latest_row_created_at,
      c.total_qty,
      c.effective_units * coalesce(public.phx_factory_price(c.product_code, c.period), 0) as line_value
    from public.source_of_sales_customer_directory_rollup c
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = c.product_code
    where (p_distributor_codes is null or cardinality(p_distributor_codes) = 0 or c.distributor_code = any(p_distributor_codes))
      and (p_region_codes is null or cardinality(p_region_codes) = 0 or c.region_code = any(p_region_codes))
      and (p_area_codes is null or cardinality(p_area_codes) = 0 or c.area_code = any(p_area_codes))
      and (p_brick_codes is null or cardinality(p_brick_codes) = 0 or c.brick_id = any(p_brick_codes))
      and (p_from_period is null or c.period >= p_from_period)
      and (p_to_period is null or c.period <= p_to_period)
      and upper(btrim(coalesce(c.product_code, ''))) <> all (
        select upper(btrim(x)) from unnest(coalesce(p_exclude_codes, '{}'::text[])) as x
      )
  ),
  latest as (
    select distinct on (client_code, distributor_code)
      client_code,
      distributor_code,
      client_name,
      client_address,
      brick_id,
      area_code,
      region_code
    from filtered
    order by client_code, distributor_code, latest_row_created_at desc
  ),
  agg as (
    select
      client_code,
      distributor_code,
      sum(total_qty) as total_units,
      sum(line_value) as total_value
    from filtered
    group by client_code, distributor_code
  )
  select
    a.client_code,
    l.client_name,
    coalesce(
      nullif(btrim(l.client_address), ''),
      nullif(btrim(m.address), ''),
      ''
    ) as client_address,
    a.distributor_code,
    l.brick_id,
    l.area_code,
    l.region_code,
    a.total_units,
    a.total_value
  from agg a
  join latest l using (client_code, distributor_code)
  left join public.source_of_sales_customer_map m
    on m.distributor_code = a.distributor_code
   and m.customer_code = a.client_code
   and m.active;
$function$;

revoke execute on function public.phx_customer_directory(text[], text[], text[], text[], text, text, text[]) from public, anon, authenticated;
grant execute on function public.phx_customer_directory(text[], text[], text[], text[], text, text, text[]) to service_role;

commit;

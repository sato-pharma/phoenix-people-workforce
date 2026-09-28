-- phx_customer_sales_reads_the_period_price
--
-- WHAT THIS CHANGES: `public.phx_customer_sales` now takes its factory price from
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

create or replace function public.phx_customer_sales(p_distributor_code text, p_client_code text, p_from_period text DEFAULT NULL::text, p_to_period text DEFAULT NULL::text, p_exclude_codes text[] DEFAULT ARRAY['LA003'::text, 'LA004'::text, 'SS001'::text])
 RETURNS TABLE(invoice_period text, product_code text, product_name text, official_line text, brick_id text, area_code text, region_code text, client_name text, client_address text, qty numeric, line_value numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select
    r.invoice_period, r.product_code, r.product_name, r.official_line, r.brick_id,
    r.area_code, r.region_code, r.client_name, r.client_address, r.qty,
    r.qty * coalesce(public.phx_factory_price(r.product_code, r.invoice_period), 0) as line_value
  from public.source_of_sales_import_rows r
  join public.source_of_sales_import_batches b on b.id = r.batch_id
  left join public.source_of_sales_products p
    on upper(btrim(p.product_code)) = upper(btrim(r.product_code))
  where b.status = 'validated'
    and r.distributor_code = p_distributor_code
    and r.client_code = p_client_code
    and (p_from_period is null or r.invoice_period >= p_from_period)
    and (p_to_period is null or r.invoice_period <= p_to_period)
    and upper(btrim(coalesce(r.product_code, ''))) <> all (
      select upper(btrim(x)) from unnest(coalesce(p_exclude_codes, '{}'::text[])) as x
    )
  order by r.invoice_period, r.product_name;
$function$;

revoke execute on function public.phx_customer_sales(text, text, text, text, text[]) from public, anon, authenticated;
grant execute on function public.phx_customer_sales(text, text, text, text, text[]) to service_role;

commit;

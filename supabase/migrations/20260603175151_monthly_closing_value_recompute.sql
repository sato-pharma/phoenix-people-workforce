-- Monthly Closing — value is recomputed by the report, not read from the stored row value.
--
-- The closing must compute Sales Value itself from current master data:
--   value = Qty (only; bonus excluded) x current factory_price x (1 - per-row discount)
-- summed per area x product. The distributor's stored `value` column (computed at import
-- time under whatever rule was then active) is NEVER used by the closing.
--
-- 1) Persist the per-row discount so the RPC can recompute. The importer already parses it
--    (discountFraction); existing rows default to 0 (current uploads carry no discounts), so
--    their value collapses to Qty x factory_price — which is the correct, current rule.
-- 2) Replace the aggregation RPC to recompute value from qty, discount, and the LIVE
--    factory_price from source_of_sales_products (left join so an unmapped product yields 0,
--    never an error). Region subtotals and the national total are still derived in the app
--    from this area x product grain (each area counted once).
--
-- Additive + reversible. Apply to PRODUCTION (ozucdzovmcqvepbozvqf) with explicit approval.
-- Rollback: drop column discount; restore the prior sum(r.value) RPC body.

alter table public.source_of_sales_import_rows
  add column if not exists discount numeric(9, 6) not null default 0;

create or replace function public.phx_monthly_closing_matrix(p_line text, p_period text)
returns table (
  area_code text,
  product_code text,
  sales_units numeric,
  sales_value numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select
    r.area_code,
    r.product_code,
    sum(r.qty) as sales_units,
    sum(r.qty * (1 - coalesce(r.discount, 0)) * coalesce(p.factory_price, 0)) as sales_value
  from public.source_of_sales_import_rows r
  join public.source_of_sales_import_batches b on b.id = r.batch_id
  left join public.source_of_sales_products p
    on upper(btrim(p.product_code)) = upper(btrim(r.product_code))
  where b.status = 'validated'
    and b.period = p_period
    and r.invoice_period = p_period
    and lower(btrim(r.official_line)) = lower(btrim(p_line))
  group by r.area_code, r.product_code;
$$;

revoke all on function public.phx_monthly_closing_matrix(text, text) from public, anon, authenticated;
grant execute on function public.phx_monthly_closing_matrix(text, text) to service_role;

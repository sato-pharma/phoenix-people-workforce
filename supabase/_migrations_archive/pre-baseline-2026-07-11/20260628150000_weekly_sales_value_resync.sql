-- ─────────────────────────────────────────────────────────────────────────────
-- System-wide price sync (stored values): resync stored weekly sales value from the
-- CURRENT Product Master factory price.
--
-- Context: Product Master (source_of_sales_products.factory_price) is the single source of truth for
-- price. loadWeeklyDashboard already recomputes value = net_qty x current factory_price at READ time,
-- so the weekly dashboard, Excel export and portal are always live. This function fixes the STORED
-- weekly_sales_rows.sales_value so the few paths that read the stored column directly (e.g.
-- /api/sales/weekly/export-batches, which bypasses the dashboard service) also reflect price edits.
--
-- It is called automatically after a Product Master price import (see src/lib/sales/master-data/
-- import-service.ts) and is safe to run manually/repeatedly (idempotent).
--
-- Rules (mirror the parser's value logic exactly):
--   • Non-Direct rows: sales_value = net_qty x factory_price.
--   • Direct channel ("Direct"): KEEP the sheet's own value — never recompute from price.
--   • Unmapped products (no master / price <= 0): left unchanged (no matching join row).
-- Additive: defines one SECURITY DEFINER function, no schema/data changes. Reversible (drop function).
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.phx_recompute_weekly_sales_value()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  affected integer;
begin
  update public.weekly_sales_rows r
     set sales_value = round((coalesce(r.net_qty, 0) * p.factory_price)::numeric, 6)
    from public.source_of_sales_products p
   where upper(btrim(r.product_code)) = upper(btrim(p.product_code))
     and coalesce(p.factory_price, 0) > 0
     and upper(btrim(coalesce(r.distributor_code, ''))) <> 'DIRECT'
     -- skip no-op updates so row_count reflects real changes and we avoid needless writes
     and r.sales_value is distinct from round((coalesce(r.net_qty, 0) * p.factory_price)::numeric, 6);
  get diagnostics affected = row_count;
  return affected;
end;
$function$;

-- Server-only (matches the rest of the weekly_sales_* surface — service-role via getSupabaseAdmin).
revoke all on function public.phx_recompute_weekly_sales_value() from public, anon, authenticated;
grant  execute on function public.phx_recompute_weekly_sales_value() to service_role;

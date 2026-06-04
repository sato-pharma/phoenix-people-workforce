-- Monthly Closing aggregation RPC.
--
-- Returns Sales Units (sum of qty) and Sales Value (sum of value) at AREA x PRODUCT
-- grain for one line and one month, combining every distributor's validated upload.
-- Region subtotals and the national grand total are derived in the application layer
-- from this area-grain result, so each area is counted exactly once (no double count).
--
-- source_of_sales_import_rows is service_role-only; this SECURITY DEFINER function is
-- granted to service_role only and adds no new RLS surface. The application calls it via
-- getSupabaseAdmin() (service role). Additive: creates a function only, no table/data
-- changes. Rollback = DROP FUNCTION public.phx_monthly_closing_matrix(text, text).
--
-- Applied to PRODUCTION (ozucdzovmcqvepbozvqf) on 2026-06-03 with explicit owner approval,
-- because the live Source-of-Sales data the report reads resides in production. Re-applying
-- elsewhere (e.g. new staging) is safe and idempotent (create or replace).

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
    sum(r.value) as sales_value
  from public.source_of_sales_import_rows r
  join public.source_of_sales_import_batches b on b.id = r.batch_id
  where b.status = 'validated'
    and b.period = p_period
    and r.invoice_period = p_period
    and lower(btrim(r.official_line)) = lower(btrim(p_line))
  group by r.area_code, r.product_code;
$$;

revoke all on function public.phx_monthly_closing_matrix(text, text) from public, anon, authenticated;
grant execute on function public.phx_monthly_closing_matrix(text, text) to service_role;

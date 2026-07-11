-- Monthly Closing aggregation RPC (additive, read-only, service_role only).
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
grant execute on function public.phx_monthly_closing_matrix(text, text) to service_role;;

-- Office channel — a computed allocation distributor (NOT a raw upload). The office file reports
-- product NAME + total UNITS with no geography. Its units are distributed to bricks using how every
-- other channel sold the same products that period (two-step: region share incl. Direct, then brick
-- share excl. Direct). Office rows are stored as normal import rows with distributor_code='Office',
-- is_direct=false, and a real (or NATIONAL) geography per allocated slice. Additive + reversible.

-- 1. Register the Office channel so it appears as its own distributor everywhere.
insert into public.source_of_sales_distributors (distributor_code, distributor_name, normalized_distributor_name, active)
values ('Office', 'Office', 'office', true)
on conflict (distributor_code) do update
  set distributor_name = excluded.distributor_name,
      normalized_distributor_name = excluded.normalized_distributor_name,
      active = true,
      updated_at = now();

-- 2. Per-product REGION share across ALL confirmed channels INCLUDING Direct (excludes Office itself
--    to avoid self-feeding). Drives step 1 of the office allocation.
create or replace function public.phx_office_region_share(p_period text)
returns table (
  product_code text,
  region_code text,
  units numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select
    r.product_code,
    r.region_code,
    sum(r.qty) as units
  from public.source_of_sales_import_rows r
  join public.source_of_sales_import_batches b on b.id = r.batch_id
  where b.status = 'validated' and b.period = p_period and r.invoice_period = p_period
    and r.distributor_code <> 'Office'
  group by r.product_code, r.region_code;
$$;

revoke all on function public.phx_office_region_share(text) from public, anon, authenticated;
grant execute on function public.phx_office_region_share(text) to service_role;

-- 3. Per-product BRICK share across only brick-carrying channels (EXCLUDES Direct, which is
--    region-only, and Office itself). Drives step 2 of the office allocation.
create or replace function public.phx_office_brick_share(p_period text)
returns table (
  product_code text,
  brick_id text,
  area_code text,
  region_code text,
  units numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select
    r.product_code,
    r.brick_id,
    r.area_code,
    r.region_code,
    sum(r.qty) as units
  from public.source_of_sales_import_rows r
  join public.source_of_sales_import_batches b on b.id = r.batch_id
  where b.status = 'validated' and b.period = p_period and r.invoice_period = p_period
    and r.distributor_code <> 'Office'
    and coalesce(r.is_direct, false) = false
    and coalesce(btrim(r.brick_id), '') <> ''
  group by r.product_code, r.brick_id, r.area_code, r.region_code;
$$;

revoke all on function public.phx_office_brick_share(text) from public, anon, authenticated;
grant execute on function public.phx_office_brick_share(text) to service_role;

-- Note on the monthly closing matrix: Office rows carry is_direct=false and a REAL area_code per
-- allocated slice, so phx_monthly_closing_matrix (area × product) already places office units in the
-- correct area cells — that is the entire point of the allocation, so Office is intentionally NOT
-- excluded there. Office remains separately attributable in the dashboard (byDistributor) and the
-- executive views (phx_exec_distributor_product groups by distributor_code='Office'). The small
-- NATIONAL remainder (area_code blank, unplaceable units) shows in the dashboard but not the
-- area-grid closing matrix.

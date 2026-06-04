-- Direct channel — company direct sales (not through a distributor). Special rules:
--  * value is taken from the sheet's own Value column (NOT recomputed from factory price),
--  * geography is Region-only (no area/brick), with a special "National" region bucket.
--
-- This migration registers the Direct channel, adds the is_direct discriminator, keeps the
-- distributor closing matrix distributor-only, adds a Direct closing RPC (stored value), and
-- teaches the Executive RPCs to use the stored value for Direct rows. Additive + reversible.
-- Apply to PRODUCTION only with approval.

-- 1. Register the Direct channel so it appears in the upload dropdown.
insert into public.source_of_sales_distributors (distributor_code, distributor_name, normalized_distributor_name, active)
values ('Direct', 'Direct (Company)', 'direct (company)', true)
on conflict (distributor_code) do update
  set distributor_name = excluded.distributor_name,
      normalized_distributor_name = excluded.normalized_distributor_name,
      active = true,
      updated_at = now();

-- 2. Explicit discriminator. The importer sets it true for Direct rows; every RPC keys off it.
alter table public.source_of_sales_import_rows
  add column if not exists is_direct boolean not null default false;

create index if not exists source_of_sales_import_rows_is_direct_idx
  on public.source_of_sales_import_rows (is_direct);

-- 3. Keep the distributor closing matrix distributor-only (Direct has no area + a different
--    value basis). Value still recomputed Qty x (1 - discount) x live factory_price.
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
    r.area_code, r.product_code,
    sum(r.qty) as sales_units,
    sum(r.qty * (1 - coalesce(r.discount, 0)) * coalesce(p.factory_price, 0)) as sales_value
  from public.source_of_sales_import_rows r
  join public.source_of_sales_import_batches b on b.id = r.batch_id
  left join public.source_of_sales_products p
    on upper(btrim(p.product_code)) = upper(btrim(r.product_code))
  where b.status = 'validated' and b.period = p_period and r.invoice_period = p_period
    and lower(btrim(r.official_line)) = lower(btrim(p_line))
    and coalesce(r.is_direct, false) = false
  group by r.area_code, r.product_code;
$$;

revoke all on function public.phx_monthly_closing_matrix(text, text) from public, anon, authenticated;
grant execute on function public.phx_monthly_closing_matrix(text, text) to service_role;

-- 4. Direct closing rows: region x product, value taken STRAIGHT from the stored sheet value
--    (no factory recompute). Returns real regions AND the "National" bucket.
create or replace function public.phx_monthly_closing_direct(p_line text, p_period text)
returns table (
  region_code text,
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
    r.region_code, r.product_code,
    sum(r.qty) as sales_units,
    sum(r.value) as sales_value
  from public.source_of_sales_import_rows r
  join public.source_of_sales_import_batches b on b.id = r.batch_id
  where b.status = 'validated' and b.period = p_period and r.invoice_period = p_period
    and lower(btrim(r.official_line)) = lower(btrim(p_line))
    and coalesce(r.is_direct, false) = true
  group by r.region_code, r.product_code;
$$;

revoke all on function public.phx_monthly_closing_direct(text, text) from public, anon, authenticated;
grant execute on function public.phx_monthly_closing_direct(text, text) to service_role;

-- 5. Executive Report — distributor×product now uses the STORED value for Direct rows and
--    buckets Direct (which has no area) under a synthetic 'DIRECT' area.
create or replace function public.phx_exec_distributor_product(p_period text default null)
returns table (
  distributor_code text,
  official_line text,
  region_code text,
  area_code text,
  product_code text,
  product_name text,
  units numeric,
  value numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select
    r.distributor_code, r.official_line, r.region_code,
    coalesce(nullif(r.area_code, ''), 'DIRECT') as area_code,
    r.product_code,
    max(r.product_name) as product_name,
    sum(r.qty) as units,
    sum(case when coalesce(r.is_direct, false)
             then r.value
             else r.qty * (1 - coalesce(r.discount, 0)) * coalesce(p.factory_price, 0) end) as value
  from public.source_of_sales_import_rows r
  join public.source_of_sales_import_batches b on b.id = r.batch_id
  left join public.source_of_sales_products p
    on upper(btrim(p.product_code)) = upper(btrim(r.product_code))
  where b.status = 'validated' and r.invoice_period = b.period
    and (p_period is null or b.period = p_period)
  group by r.distributor_code, r.official_line, r.region_code,
           coalesce(nullif(r.area_code, ''), 'DIRECT'), r.product_code;
$$;

revoke all on function public.phx_exec_distributor_product(text) from public, anon, authenticated;
grant execute on function public.phx_exec_distributor_product(text) to service_role;

-- 6. Bricks + customers rankings exclude Direct (it has no brick and no client code).
create or replace function public.phx_exec_brick(p_period text default null)
returns table (
  distributor_code text,
  region_code text,
  area_code text,
  brick_id text,
  units numeric,
  value numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select
    r.distributor_code, r.region_code, r.area_code, r.brick_id,
    sum(r.qty) as units,
    sum(r.qty * (1 - coalesce(r.discount, 0)) * coalesce(p.factory_price, 0)) as value
  from public.source_of_sales_import_rows r
  join public.source_of_sales_import_batches b on b.id = r.batch_id
  left join public.source_of_sales_products p
    on upper(btrim(p.product_code)) = upper(btrim(r.product_code))
  where b.status = 'validated' and r.invoice_period = b.period
    and (p_period is null or b.period = p_period)
    and coalesce(r.is_direct, false) = false
  group by r.distributor_code, r.region_code, r.area_code, r.brick_id;
$$;

revoke all on function public.phx_exec_brick(text) from public, anon, authenticated;
grant execute on function public.phx_exec_brick(text) to service_role;

create or replace function public.phx_exec_customers(p_period text default null)
returns table (
  client_code text,
  client_name text,
  distributor_code text,
  region_code text,
  area_code text,
  brick_id text,
  units numeric,
  value numeric
)
language sql
stable
security definer
set search_path = public
as $$
  with scoped as (
    select
      r.client_code, r.distributor_code, r.client_name, r.region_code, r.area_code,
      r.brick_id, r.qty, r.created_at,
      r.qty * (1 - coalesce(r.discount, 0)) * coalesce(p.factory_price, 0) as line_value
    from public.source_of_sales_import_rows r
    join public.source_of_sales_import_batches b on b.id = r.batch_id
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(r.product_code))
    where b.status = 'validated' and r.invoice_period = b.period
      and (p_period is null or b.period = p_period)
      and r.client_code is not null
      and coalesce(r.is_direct, false) = false
  ),
  latest as (
    select distinct on (client_code, distributor_code)
      client_code, distributor_code, client_name, region_code, area_code, brick_id
    from scoped
    order by client_code, distributor_code, created_at desc
  ),
  agg as (
    select client_code, distributor_code, sum(qty) as units, sum(line_value) as value
    from scoped
    group by client_code, distributor_code
  )
  select a.client_code, l.client_name, a.distributor_code, l.region_code, l.area_code,
         l.brick_id, a.units, a.value
  from agg a
  join latest l using (client_code, distributor_code);
$$;

revoke all on function public.phx_exec_customers(text) from public, anon, authenticated;
grant execute on function public.phx_exec_customers(text) to service_role;

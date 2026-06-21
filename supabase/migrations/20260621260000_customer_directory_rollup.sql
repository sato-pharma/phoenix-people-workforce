-- Performance: cached customer-directory rollup for Customer Directory / Customer Mapping.
--
-- The previous phx_customer_directory_json function scanned the raw
-- source_of_sales_import_rows table and aggregated every validated row on each
-- page load. On production that raw table is hundreds of MB and the Supabase
-- Data API can cancel the statement before the page renders.
--
-- This rollup keeps the same business behavior:
-- - customer rows still come only from validated Source of Sales batches
-- - customer code + distributor remains the directory grain
-- - pricing remains live by storing effective units and multiplying by the
--   current source_of_sales_products.factory_price at read time

create table if not exists public.source_of_sales_customer_directory_rollup (
  batch_id uuid not null references public.source_of_sales_import_batches(id) on delete cascade,
  period text not null default '',
  distributor_code text not null,
  client_code text not null,
  product_code text not null default '',
  client_name text,
  client_address text,
  brick_id text,
  area_code text,
  region_code text,
  latest_row_created_at timestamptz not null,
  effective_units numeric(20,6) not null default 0,
  total_qty numeric(20,6) not null default 0,
  row_count integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (batch_id, period, distributor_code, client_code, product_code)
);

create index if not exists sos_customer_directory_rollup_period_idx
  on public.source_of_sales_customer_directory_rollup (period);

create index if not exists sos_customer_directory_rollup_distributor_idx
  on public.source_of_sales_customer_directory_rollup (distributor_code);

create index if not exists sos_customer_directory_rollup_geo_idx
  on public.source_of_sales_customer_directory_rollup (region_code, area_code, brick_id);

create index if not exists sos_customer_directory_rollup_client_idx
  on public.source_of_sales_customer_directory_rollup (client_code);

alter table public.source_of_sales_customer_directory_rollup enable row level security;

revoke all on table public.source_of_sales_customer_directory_rollup from anon, authenticated;
grant select, insert, update, delete on table public.source_of_sales_customer_directory_rollup to service_role;

drop policy if exists source_of_sales_customer_directory_rollup_service_role_all
  on public.source_of_sales_customer_directory_rollup;
create policy source_of_sales_customer_directory_rollup_service_role_all
on public.source_of_sales_customer_directory_rollup
for all
to service_role
using (true)
with check (true);

create or replace function public.phx_refresh_sos_customer_directory_rollup(p_batch_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
set statement_timeout to '60s'
as $function$
begin
  delete from public.source_of_sales_customer_directory_rollup
  where batch_id = p_batch_id;

  insert into public.source_of_sales_customer_directory_rollup (
    batch_id,
    period,
    distributor_code,
    client_code,
    product_code,
    client_name,
    client_address,
    brick_id,
    area_code,
    region_code,
    latest_row_created_at,
    effective_units,
    total_qty,
    row_count
  )
  select
    r.batch_id,
    coalesce(nullif(btrim(r.invoice_period), ''), '') as period,
    coalesce(nullif(btrim(r.distributor_code), ''), b.distributor_code, '') as distributor_code,
    nullif(btrim(r.client_code), '') as client_code,
    coalesce(nullif(upper(btrim(r.product_code)), ''), '') as product_code,
    (array_agg(nullif(btrim(r.client_name), '') order by (nullif(btrim(r.client_name), '') is null), r.created_at desc nulls last))[1] as client_name,
    (array_agg(nullif(btrim(r.client_address), '') order by (nullif(btrim(r.client_address), '') is null), r.created_at desc nulls last))[1] as client_address,
    (array_agg(nullif(btrim(r.brick_id), '') order by (nullif(btrim(r.brick_id), '') is null), r.created_at desc nulls last))[1] as brick_id,
    (array_agg(nullif(btrim(r.area_code), '') order by (nullif(btrim(r.area_code), '') is null), r.created_at desc nulls last))[1] as area_code,
    (array_agg(nullif(btrim(r.region_code), '') order by (nullif(btrim(r.region_code), '') is null), r.created_at desc nulls last))[1] as region_code,
    max(coalesce(r.created_at, b.created_at, 'epoch'::timestamptz)) as latest_row_created_at,
    sum(coalesce(r.qty, 0) * (1 - coalesce(r.discount, 0))) as effective_units,
    sum(coalesce(r.qty, 0)) as total_qty,
    count(*)::integer as row_count
  from public.source_of_sales_import_rows r
  join public.source_of_sales_import_batches b
    on b.id = r.batch_id
   and b.status = 'validated'
  where r.batch_id = p_batch_id
    and nullif(btrim(r.client_code), '') is not null
  group by
    r.batch_id,
    coalesce(nullif(btrim(r.invoice_period), ''), ''),
    coalesce(nullif(btrim(r.distributor_code), ''), b.distributor_code, ''),
    nullif(btrim(r.client_code), ''),
    coalesce(nullif(upper(btrim(r.product_code)), ''), '');
end;
$function$;

revoke all on function public.phx_refresh_sos_customer_directory_rollup(uuid) from public, anon, authenticated;
grant execute on function public.phx_refresh_sos_customer_directory_rollup(uuid) to service_role;

create or replace function public.phx_backfill_sos_customer_directory_rollup()
returns void
language plpgsql
security definer
set search_path to 'public'
set statement_timeout to '120s'
as $function$
begin
  delete from public.source_of_sales_customer_directory_rollup;

  insert into public.source_of_sales_customer_directory_rollup (
    batch_id,
    period,
    distributor_code,
    client_code,
    product_code,
    client_name,
    client_address,
    brick_id,
    area_code,
    region_code,
    latest_row_created_at,
    effective_units,
    total_qty,
    row_count
  )
  select
    r.batch_id,
    coalesce(nullif(btrim(r.invoice_period), ''), '') as period,
    coalesce(nullif(btrim(r.distributor_code), ''), b.distributor_code, '') as distributor_code,
    nullif(btrim(r.client_code), '') as client_code,
    coalesce(nullif(upper(btrim(r.product_code)), ''), '') as product_code,
    (array_agg(nullif(btrim(r.client_name), '') order by (nullif(btrim(r.client_name), '') is null), r.created_at desc nulls last))[1] as client_name,
    (array_agg(nullif(btrim(r.client_address), '') order by (nullif(btrim(r.client_address), '') is null), r.created_at desc nulls last))[1] as client_address,
    (array_agg(nullif(btrim(r.brick_id), '') order by (nullif(btrim(r.brick_id), '') is null), r.created_at desc nulls last))[1] as brick_id,
    (array_agg(nullif(btrim(r.area_code), '') order by (nullif(btrim(r.area_code), '') is null), r.created_at desc nulls last))[1] as area_code,
    (array_agg(nullif(btrim(r.region_code), '') order by (nullif(btrim(r.region_code), '') is null), r.created_at desc nulls last))[1] as region_code,
    max(coalesce(r.created_at, b.created_at, 'epoch'::timestamptz)) as latest_row_created_at,
    sum(coalesce(r.qty, 0) * (1 - coalesce(r.discount, 0))) as effective_units,
    sum(coalesce(r.qty, 0)) as total_qty,
    count(*)::integer as row_count
  from public.source_of_sales_import_rows r
  join public.source_of_sales_import_batches b
    on b.id = r.batch_id
   and b.status = 'validated'
  where nullif(btrim(r.client_code), '') is not null
  group by
    r.batch_id,
    coalesce(nullif(btrim(r.invoice_period), ''), ''),
    coalesce(nullif(btrim(r.distributor_code), ''), b.distributor_code, ''),
    nullif(btrim(r.client_code), ''),
    coalesce(nullif(upper(btrim(r.product_code)), ''), '');
end;
$function$;

revoke all on function public.phx_backfill_sos_customer_directory_rollup() from public, anon, authenticated;
grant execute on function public.phx_backfill_sos_customer_directory_rollup() to service_role;

create or replace function public.phx_customer_directory(
  p_region_codes text[] default null,
  p_area_codes text[] default null,
  p_brick_codes text[] default null,
  p_distributor_codes text[] default null,
  p_from_period text default null,
  p_to_period text default null
)
returns table (
  client_code text,
  client_name text,
  client_address text,
  distributor_code text,
  brick_id text,
  area_code text,
  region_code text,
  total_units numeric,
  total_value numeric
)
language sql
stable
security definer
set search_path = public
set statement_timeout = '45s'
as $$
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
      c.effective_units * coalesce(p.factory_price, 0) as line_value
    from public.source_of_sales_customer_directory_rollup c
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = c.product_code
    where (p_distributor_codes is null or cardinality(p_distributor_codes) = 0 or c.distributor_code = any(p_distributor_codes))
      and (p_region_codes is null or cardinality(p_region_codes) = 0 or c.region_code = any(p_region_codes))
      and (p_area_codes is null or cardinality(p_area_codes) = 0 or c.area_code = any(p_area_codes))
      and (p_brick_codes is null or cardinality(p_brick_codes) = 0 or c.brick_id = any(p_brick_codes))
      and (p_from_period is null or c.period >= p_from_period)
      and (p_to_period is null or c.period <= p_to_period)
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
    l.client_address,
    a.distributor_code,
    l.brick_id,
    l.area_code,
    l.region_code,
    a.total_units,
    a.total_value
  from agg a
  join latest l using (client_code, distributor_code);
$$;

revoke all on function public.phx_customer_directory(text[], text[], text[], text[], text, text) from public, anon, authenticated;
grant execute on function public.phx_customer_directory(text[], text[], text[], text[], text, text) to service_role;

create or replace function public.phx_customer_directory_json(
  p_region_codes text[] default null,
  p_area_codes text[] default null,
  p_brick_codes text[] default null,
  p_distributor_codes text[] default null,
  p_from_period text default null,
  p_to_period text default null
)
returns jsonb
language sql
stable
security definer
set search_path = public
set statement_timeout = '45s'
as $$
  select coalesce(jsonb_agg(to_jsonb(row)), '[]'::jsonb)
  from (
    select *
    from public.phx_customer_directory(
      p_region_codes,
      p_area_codes,
      p_brick_codes,
      p_distributor_codes,
      p_from_period,
      p_to_period
    )
  ) row;
$$;

revoke all on function public.phx_customer_directory_json(text[], text[], text[], text[], text, text) from public, anon, authenticated;
grant execute on function public.phx_customer_directory_json(text[], text[], text[], text[], text, text) to service_role;

select public.phx_backfill_sos_customer_directory_rollup();

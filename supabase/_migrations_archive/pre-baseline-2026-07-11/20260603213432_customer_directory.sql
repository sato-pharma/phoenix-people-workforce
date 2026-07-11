alter table public.source_of_sales_import_rows
  add column if not exists client_code text,
  add column if not exists client_name text,
  add column if not exists client_address text;

update public.source_of_sales_import_rows set
  client_code = nullif(btrim(raw_row->>'Customer'), ''),
  client_name = nullif(btrim(raw_row->>'Customer Name'), ''),
  client_address = nullif(btrim(raw_row->>'Customer Address'), '')
 where distributor_code = 'PS' and client_code is null;

update public.source_of_sales_import_rows set
  client_code = nullif(btrim(raw_row->>'Client Code'), ''),
  client_name = nullif(btrim(raw_row->>'Client Name'), ''),
  client_address = nullif(btrim(raw_row->>'Address_En'), '')
 where distributor_code in ('IS', 'IS-S') and client_code is null;

update public.source_of_sales_import_rows set
  client_address = coalesce(client_address, nullif(btrim(raw_row->>'Address_Ar'), ''))
 where distributor_code = 'IS-S' and client_address is null;

create index if not exists sos_rows_dist_client_idx
  on public.source_of_sales_import_rows (distributor_code, client_code);
create index if not exists sos_rows_region_area_brick_idx
  on public.source_of_sales_import_rows (region_code, area_code, brick_id);
create index if not exists sos_rows_period_idx
  on public.source_of_sales_import_rows (invoice_period);

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
as $$
  with scoped as (
    select
      r.client_code, r.distributor_code, r.client_name, r.client_address,
      r.brick_id, r.area_code, r.region_code, r.qty, r.created_at,
      r.qty * (1 - coalesce(r.discount, 0)) * coalesce(p.factory_price, 0) as line_value
    from public.source_of_sales_import_rows r
    join public.source_of_sales_import_batches b on b.id = r.batch_id
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(r.product_code))
    where b.status = 'validated'
      and r.client_code is not null
      and (p_distributor_codes is null or cardinality(p_distributor_codes) = 0 or r.distributor_code = any(p_distributor_codes))
      and (p_region_codes is null or cardinality(p_region_codes) = 0 or r.region_code = any(p_region_codes))
      and (p_area_codes is null or cardinality(p_area_codes) = 0 or r.area_code = any(p_area_codes))
      and (p_brick_codes is null or cardinality(p_brick_codes) = 0 or r.brick_id = any(p_brick_codes))
      and (p_from_period is null or r.invoice_period >= p_from_period)
      and (p_to_period is null or r.invoice_period <= p_to_period)
  ),
  latest as (
    select distinct on (client_code, distributor_code)
      client_code, distributor_code, client_name, client_address, brick_id, area_code, region_code
    from scoped
    order by client_code, distributor_code, created_at desc
  ),
  agg as (
    select client_code, distributor_code, sum(qty) as total_units, sum(line_value) as total_value
    from scoped
    group by client_code, distributor_code
  )
  select a.client_code, l.client_name, l.client_address, a.distributor_code,
         l.brick_id, l.area_code, l.region_code, a.total_units, a.total_value
  from agg a
  join latest l using (client_code, distributor_code);
$$;

revoke all on function public.phx_customer_directory(text[], text[], text[], text[], text, text) from public, anon, authenticated;
grant execute on function public.phx_customer_directory(text[], text[], text[], text[], text, text) to service_role;

create or replace function public.phx_customer_sales(
  p_distributor_code text,
  p_client_code text,
  p_from_period text default null,
  p_to_period text default null
)
returns table (
  invoice_period text,
  product_code text,
  product_name text,
  official_line text,
  brick_id text,
  area_code text,
  region_code text,
  client_name text,
  client_address text,
  qty numeric,
  line_value numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select
    r.invoice_period, r.product_code, r.product_name, r.official_line, r.brick_id,
    r.area_code, r.region_code, r.client_name, r.client_address, r.qty,
    r.qty * (1 - coalesce(r.discount, 0)) * coalesce(p.factory_price, 0) as line_value
  from public.source_of_sales_import_rows r
  join public.source_of_sales_import_batches b on b.id = r.batch_id
  left join public.source_of_sales_products p
    on upper(btrim(p.product_code)) = upper(btrim(r.product_code))
  where b.status = 'validated'
    and r.distributor_code = p_distributor_code
    and r.client_code = p_client_code
    and (p_from_period is null or r.invoice_period >= p_from_period)
    and (p_to_period is null or r.invoice_period <= p_to_period)
  order by r.invoice_period, r.product_name;
$$;

revoke all on function public.phx_customer_sales(text, text, text, text) from public, anon, authenticated;
grant execute on function public.phx_customer_sales(text, text, text, text) to service_role;;

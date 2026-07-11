-- Performance fix for Customer Directory (was timing out / rendering in ~40s).
--
-- Two root causes were addressed:
--   1. Covering index so the aggregation reads ~19 MB instead of seq-scanning the
--      full 234 MB source_of_sales_import_rows heap.
--   2. The page re-ran the aggregation ~28 times per render (PostgREST caps RPC results
--      at 1000 rows, so fetching all ~28k directory rows paged 28x). The single-execution
--      jsonb variant that fixes this lives in the next migration
--      (20260614200001_customer_directory_json_single_exec.sql).
--
-- NOTE: on production this index was built with CREATE INDEX CONCURRENTLY outside a
-- migration transaction (CONCURRENTLY cannot run inside the migration's tx). The
-- IF NOT EXISTS guard makes this statement a no-op there; on a fresh rebuild it builds
-- the index normally.
create index if not exists sos_rows_directory_covering_idx
  on public.source_of_sales_import_rows (batch_id)
  include (client_code, distributor_code, client_name, client_address,
           brick_id, area_code, region_code, qty, discount, product_code,
           created_at, invoice_period)
  where client_code is not null;

-- Recreate the function (body unchanged) to invalidate PostgreSQL's cached plan so it
-- picks up the new index. Retained for the XLSX export path and period-filtered reads.
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

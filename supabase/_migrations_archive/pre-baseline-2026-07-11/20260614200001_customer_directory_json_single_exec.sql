-- Single-execution variant of phx_customer_directory: returns the entire result set as
-- one jsonb array in ONE row. This avoids PostgREST's 1000-row page cap, which was forcing
-- the directory aggregation to re-run ~28 times (once per page) on every render (~43s of
-- the ~40s page load). With this, the aggregation runs exactly once per render.
--
-- The query body/output is identical to phx_customer_directory; only the return shape
-- differs (jsonb array instead of a row set). The app's customer-directory service calls
-- this for both the page list and the XLSX export.
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
  select coalesce(jsonb_agg(to_jsonb(row)), '[]'::jsonb)
  from (
    select a.client_code, l.client_name, l.client_address, a.distributor_code,
           l.brick_id, l.area_code, l.region_code, a.total_units, a.total_value
    from agg a
    join latest l using (client_code, distributor_code)
  ) row;
$$;

revoke all on function public.phx_customer_directory_json(text[], text[], text[], text[], text, text) from public, anon, authenticated;
grant execute on function public.phx_customer_directory_json(text[], text[], text[], text[], text, text) to service_role;

-- Customer Directory: fill the Address column from the customer master.
--
-- The Address column downloaded EMPTY in every Customers-tab export. The cause was not the export:
-- buildNormalizedImportRows in src/lib/sales/normalizer/service.ts persisted a literal
-- `client_address: null`, so all 294,445 rows in source_of_sales_import_rows — and therefore the
-- directory rollup built from them — carry no address at all, even though every distributor file
-- has a "Customer Address" column that is ~100% populated. That code path is fixed separately, but
-- it only helps rows imported FROM NOW ON.
--
-- source_of_sales_customer_map (the customer master) already holds the address for 44,810 of its
-- 51,193 active customers. Coalescing from it here fixes the column for ALL existing history with
-- no re-import. Measured on production before writing this migration:
--   * 50,209 directory customers, 50,106 (99.8%) match the master on (distributor_code, customer_code)
--   * 44,148 (87.9%) gain a real address
--   * 0 duplicate active (distributor_code, customer_code) keys, so the LEFT JOIN cannot fan out
--     rows and cannot change total_units / total_value. This function's numbers are unchanged.
--
-- Only the client_address expression and the new LEFT JOIN differ from the previous definition.

create or replace function public.phx_customer_directory(
  p_region_codes text[] default null::text[],
  p_area_codes text[] default null::text[],
  p_brick_codes text[] default null::text[],
  p_distributor_codes text[] default null::text[],
  p_from_period text default null::text,
  p_to_period text default null::text,
  p_exclude_codes text[] default array['LA003'::text, 'LA004'::text, 'SS001'::text]
)
returns table(
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
set search_path to 'public'
set statement_timeout to '45s'
set work_mem to '128MB'
as $function$
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
      and upper(btrim(coalesce(c.product_code, ''))) <> all (
        select upper(btrim(x)) from unnest(coalesce(p_exclude_codes, '{}'::text[])) as x
      )
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
    -- The sales row's own address wins when it has one (post-fix imports); otherwise fall back to
    -- the customer master. Empty string rather than null so the export renders a blank cell, not
    -- the literal "null".
    coalesce(
      nullif(btrim(l.client_address), ''),
      nullif(btrim(m.address), ''),
      ''
    ) as client_address,
    a.distributor_code,
    l.brick_id,
    l.area_code,
    l.region_code,
    a.total_units,
    a.total_value
  from agg a
  join latest l using (client_code, distributor_code)
  left join public.source_of_sales_customer_map m
    on m.distributor_code = a.distributor_code
   and m.customer_code = a.client_code
   and m.active;
$function$;

revoke execute on function public.phx_customer_directory(text[], text[], text[], text[], text, text, text[]) from public, anon, authenticated;
grant execute on function public.phx_customer_directory(text[], text[], text[], text[], text, text, text[]) to service_role;

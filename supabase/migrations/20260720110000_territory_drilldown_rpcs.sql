-- Territory & Sales Drilldown module.
--
-- Two new, narrowly-scoped RPCs, both service_role-only (never exposed to
-- anon/authenticated), modeled directly on the existing, working
-- phx_exec_customers (see 20260717134435_phx_exec_rpc_period_branch_rewrite.sql)
-- rather than the au.f_sales_source_breakdown_detail family, which was
-- deliberately NOT reused here: it hardcodes `not f.is_direct` (would
-- silently hide direct-channel pharmacy sales) and returns brick_name with
-- no brick_id/block_code (insufficient to group into the Block tier).
--
-- 1) phx_territory_resolve_sos_area_codes — the only bridge from the HR-side
--    area assignment (public.areas.code, what employees.area_id ultimately
--    resolves to) into the Source-of-Sales geography master
--    (public.source_of_sales_areas.area_code). au.* tables are not exposed
--    to PostgREST (supabase/config.toml schemas = ["public","graphql_public"]),
--    so this thin public-schema wrapper is required, matching how every
--    existing au.* consumer already does this.
--
-- 2) phx_territory_area_pharmacies — the one genuine data gap: brick-level,
--    line-filtered, name-resolved, month-grained pharmacy sales for a set of
--    Source-of-Sales area codes. Returns SUM(...) OVER() reconciliation
--    totals alongside the per-row data so the caller can verify its own
--    client-side re-aggregation independently, in the same scan.

create or replace function public.phx_territory_resolve_sos_area_codes(
  p_canonical_area_code text
)
returns table (sos_area_code text)
language sql
stable security definer
set search_path to 'au', 'public'
as $$
  select cw.sos_area_code
  from au.sos_area_crosswalk cw
  where cw.canonical_area_code = upper(btrim(p_canonical_area_code));
$$;

revoke execute on function public.phx_territory_resolve_sos_area_codes(text) from public, anon, authenticated;
grant execute on function public.phx_territory_resolve_sos_area_codes(text) to service_role;

create or replace function public.phx_territory_area_pharmacies(
  p_area_codes text[],
  p_periods    text[],
  p_lines      text[]
)
returns table (
  brick_id          text,
  client_code       text,
  client_name       text,
  official_line     text,
  product_code      text,
  product_name      text,
  period            text,
  units             numeric,
  value             numeric,
  scope_total_units numeric,
  scope_total_value numeric
)
language plpgsql
stable security definer
set search_path to 'public'
set statement_timeout to '30s'
as $function$
#variable_conflict use_column
begin
  return query
  with filtered as (
    select
      coalesce(nullif(btrim(r.brick_id), ''), '(unmapped)') as brick_id,
      r.client_code,
      r.client_name,
      coalesce(nullif(btrim(r.official_line), ''), 'Unknown') as official_line,
      coalesce(nullif(btrim(r.product_code), ''), '') as product_code,
      coalesce(nullif(btrim(p.product_name), ''), 'Unknown product') as product_name,
      r.period,
      r.latest_row_created_at,
      r.total_qty,
      r.effective_units * coalesce(p.factory_price, 0) as row_value
    from public.source_of_sales_customer_directory_rollup r
    join public.source_of_sales_import_batches b
      on b.id = r.batch_id and b.status = 'validated'
    left join public.source_of_sales_products p
      on p.product_code = r.product_code
    where upper(btrim(coalesce(r.area_code, ''))) in (
        select upper(btrim(x)) from unnest(p_area_codes) as x
      )
      and r.period = any (p_periods)
      and r.client_code is not null
      and (
        cardinality(p_lines) = 0
        or lower(btrim(coalesce(r.official_line, ''))) in (
          select lower(btrim(x)) from unnest(p_lines) as x
        )
      )
      and upper(btrim(coalesce(r.product_code, ''))) not in ('LA003', 'LA004', 'SS001')
  ),
  latest_name as (
    select distinct on (client_code) client_code, client_name
    from filtered
    where client_name is not null
    order by client_code, latest_row_created_at desc
  ),
  agg as (
    select brick_id, client_code, official_line, product_code, product_name, period,
           sum(total_qty) as units, sum(row_value) as value
    from filtered
    group by brick_id, client_code, official_line, product_code, product_name, period
  )
  select
    a.brick_id,
    a.client_code,
    coalesce(ln.client_name, 'Unknown'),
    a.official_line,
    a.product_code,
    a.product_name,
    a.period,
    a.units,
    a.value,
    sum(a.units) over (),
    sum(a.value) over ()
  from agg a
  left join latest_name ln using (client_code);
end;
$function$;

revoke execute on function public.phx_territory_area_pharmacies(text[], text[], text[]) from public, anon, authenticated;
grant execute on function public.phx_territory_area_pharmacies(text[], text[], text[]) to service_role;

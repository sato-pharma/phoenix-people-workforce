-- Source-of-Sales dashboard performance fix.
--
-- The SoS dashboard previously drew its 6-month trend by calling the heavy per-distributor/product
-- aggregate `phx_exec_distributor_product` once for EACH window month (≈6 concurrent calls), each of
-- which re-scans + re-aggregates the full invoice table. Under that concurrent burst every call ballooned
-- to 16–26s on production, saturating the database and timing the dashboard out ("Could not load
-- source-of-sales data" — the server component catches the throw and returns 200, so it never logged 5xx).
--
-- This lightweight RPC returns ONLY per-period totals (units + value) for a set of periods, so the trend
-- costs one cheap query instead of six heavy ones. Value semantics mirror phx_exec_distributor_product:
--   distributor rows = qty*(1-discount)*factory_price ; Direct rows = stored sheet value ; bonus excluded.
-- Optional filter arrays mirror the dashboard's in-app filters (line / distributor / region / area /
-- product); p_exclude_codes strips confidential products (LA003/LA004/SS001) for non-CEO callers, so the
-- trend stays filter-aware and never leaks restricted value. Empty array = no filter on that axis.
--
-- Implementation notes:
--  * The covering index lets the per-period aggregate run as an index-only scan instead of a ~143k-row
--    heap scan (the measured 16–26s bottleneck).
--  * The body is PL/pgSQL dynamic SQL: a plain LANGUAGE sql / SECURITY DEFINER function plans its body
--    ONCE with the period array as a bind parameter (a generic plan that ignores the covering index, ~17s
--    on prod). Building the statement with the period values inlined as literals (format %L, injection-safe)
--    re-plans per call and picks the index-only scan (~1.3s on prod). %L safely escapes all array values.
--  * SECURITY DEFINER + 45s statement_timeout + service_role-only execute, matching the sibling phx_exec_* RPCs.

create index if not exists sos_rows_period_value_cover_idx
  on public.source_of_sales_import_rows (invoice_period)
  include (batch_id, qty, discount, value, is_direct, product_code);

create or replace function public.phx_exec_sos_trend(
  p_periods text[] default '{}'::text[],
  p_lines text[] default '{}'::text[],
  p_distributors text[] default '{}'::text[],
  p_regions text[] default '{}'::text[],
  p_areas text[] default '{}'::text[],
  p_products text[] default '{}'::text[],
  p_exclude_codes text[] default '{}'::text[]
)
returns table(period text, units numeric, value numeric)
language plpgsql
stable
security definer
set search_path to 'public'
set statement_timeout to '45s'
as $function$
begin
  return query execute format($q$
    select r.invoice_period as period,
      sum(r.qty) as units,
      sum(case when coalesce(r.is_direct, false) then r.value
               else r.qty * (1 - coalesce(r.discount, 0)) * coalesce(p.factory_price, 0) end) as value
    from public.source_of_sales_import_rows r
    join public.source_of_sales_import_batches b
      on b.id = r.batch_id and b.status = 'validated' and b.period = r.invoice_period
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(r.product_code))
    where (cardinality(%1$L::text[]) = 0 or r.invoice_period = any (%1$L::text[]))
      and (cardinality(%2$L::text[]) = 0 or lower(btrim(coalesce(r.official_line, ''))) = any (select lower(btrim(x)) from unnest(%2$L::text[]) as x))
      and (cardinality(%3$L::text[]) = 0 or upper(btrim(coalesce(r.distributor_code, ''))) = any (select upper(btrim(x)) from unnest(%3$L::text[]) as x))
      and (cardinality(%4$L::text[]) = 0 or upper(btrim(coalesce(r.region_code, ''))) = any (select upper(btrim(x)) from unnest(%4$L::text[]) as x))
      and (cardinality(%5$L::text[]) = 0 or upper(btrim(coalesce(nullif(r.area_code, ''), 'DIRECT'))) = any (select upper(btrim(x)) from unnest(%5$L::text[]) as x))
      and (cardinality(%6$L::text[]) = 0 or upper(btrim(coalesce(r.product_code, ''))) = any (select upper(btrim(x)) from unnest(%6$L::text[]) as x))
      and (cardinality(%7$L::text[]) = 0 or upper(btrim(coalesce(r.product_code, ''))) <> all (select upper(btrim(x)) from unnest(%7$L::text[]) as x))
    group by r.invoice_period
  $q$, p_periods, p_lines, p_distributors, p_regions, p_areas, p_products, p_exclude_codes);
end
$function$;

revoke all on function public.phx_exec_sos_trend(text[],text[],text[],text[],text[],text[],text[]) from public, anon, authenticated;
grant execute on function public.phx_exec_sos_trend(text[],text[],text[],text[],text[],text[],text[]) to service_role;

notify pgrst, 'reload schema';

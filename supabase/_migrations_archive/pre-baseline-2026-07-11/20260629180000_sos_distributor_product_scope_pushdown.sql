-- Source-of-Sales performance: push scope + filter selection INTO the
-- phx_exec_distributor_product RPC instead of returning the whole company's leaf
-- rows for the period and filtering them in TypeScript afterwards.
--
-- Why: getSosDashboard called phx_exec_distributor_product(p_period) — which returns
-- every distributor/line/region/area/product leaf row for the month — and then dropped
-- out-of-scope / out-of-filter rows in TS (keepExec). For a scoped caller (a District
-- Manager, a Product Manager bounded to a few products, …) that means transferring and
-- aggregating the full company table just to keep a small slice. This migration adds
-- optional filter arrays so the database only aggregates + returns the rows the caller
-- can actually see.
--
-- Semantics are UNCHANGED. The new params are an additive, conservative PRE-filter:
--   * Every array defaults to '{}' = "no filter on that axis", so the existing
--     single-arg call site (and monthly-sales-run.ts) behaves exactly as before.
--   * The matching rules mirror the TS keepExec predicates byte-for-byte
--     (normalizeLineKey = trim+lower = lower(btrim); region/area/distributor/product
--     compared upper(btrim); restricted codes excluded by product_code). keepExec is
--     KEPT in TS as the authoritative backstop, so this pushdown can only ever remove
--     rows TS would have removed anyway — it can never widen visibility.
--   * Head Office line stripping is intentionally NOT pushed here; it stays in keepExec
--     (by official_line) to avoid any product-master vs rollup label divergence.
--
-- Signature change: adding parameters to a LANGUAGE sql function via CREATE OR REPLACE
-- would create a SECOND overload and make the single-arg call ambiguous in PostgREST.
-- So we DROP the old one-arg function first, then create the expanded one (all new
-- params defaulted, so old-style calls still resolve unambiguously). DROP also clears
-- the previous grants, so they are re-applied below: service_role (the app's admin
-- client) and analytics_readonly (granted in 20260625155000_analytics_schema_views.sql).
--
-- DEPLOY ORDER: apply this migration to a target BEFORE deploying the code that passes
-- the new params. The currently-deployed code only sends p_period, which keeps working
-- after this migration (defaults), so there is no window where prod breaks.

drop function if exists public.phx_exec_distributor_product(text);

create or replace function public.phx_exec_distributor_product(
  p_period text default null::text,
  p_lines text[] default '{}'::text[],
  p_distributors text[] default '{}'::text[],
  p_regions text[] default '{}'::text[],
  p_areas text[] default '{}'::text[],
  p_products text[] default '{}'::text[],
  p_exclude_codes text[] default '{}'::text[]
)
 returns table(distributor_code text, official_line text, region_code text, area_code text, product_code text, product_name text, units numeric, value numeric)
 language sql
 stable security definer
 set search_path to 'public'
 set statement_timeout to '45s'
as $function$
  select
    f.distributor_code,
    f.official_line,
    f.region_code,
    coalesce(nullif(f.area_code, ''), 'DIRECT') as area_code,
    f.product_code,
    max(f.product_name) as product_name,
    sum(f.total_qty) as units,
    sum(case when f.is_direct
             then f.direct_value
             else f.effective_units * coalesce(p.factory_price, 0) end) as value
  from public.source_of_sales_fact_rollup f
  left join public.source_of_sales_products p
    on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
  where (p_period is null or f.period = p_period)
    and (
      cardinality(p_lines) = 0
      or lower(btrim(coalesce(f.official_line, ''))) in (select lower(btrim(x)) from unnest(p_lines) as x)
    )
    and (
      cardinality(p_distributors) = 0
      or upper(btrim(coalesce(f.distributor_code, ''))) in (select upper(btrim(x)) from unnest(p_distributors) as x)
    )
    and (
      cardinality(p_regions) = 0
      or upper(btrim(coalesce(f.region_code, ''))) in (select upper(btrim(x)) from unnest(p_regions) as x)
    )
    and (
      cardinality(p_areas) = 0
      or upper(btrim(coalesce(nullif(f.area_code, ''), 'DIRECT'))) in (select upper(btrim(x)) from unnest(p_areas) as x)
    )
    and (
      cardinality(p_products) = 0
      or upper(btrim(coalesce(f.product_code, ''))) in (select upper(btrim(x)) from unnest(p_products) as x)
    )
    and (
      cardinality(p_exclude_codes) = 0
      or upper(btrim(coalesce(f.product_code, ''))) <> all (select upper(btrim(x)) from unnest(p_exclude_codes) as x)
    )
  group by f.distributor_code, f.official_line, f.region_code,
           coalesce(nullif(f.area_code, ''), 'DIRECT'), f.product_code;
$function$;

-- Restore grants dropped along with the old function.
revoke all on function public.phx_exec_distributor_product(text, text[], text[], text[], text[], text[], text[])
  from public, anon, authenticated;
grant execute on function public.phx_exec_distributor_product(text, text[], text[], text[], text[], text[], text[])
  to service_role;

-- analytics_readonly was granted execute in 20260625155000_analytics_schema_views.sql.
-- Re-grant it (guarded, in case the role is absent in a given environment).
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'analytics_readonly') then
    grant execute on function public.phx_exec_distributor_product(text, text[], text[], text[], text[], text[], text[])
      to analytics_readonly;
  end if;
end
$$;

notify pgrst, 'reload schema';

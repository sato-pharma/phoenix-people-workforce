-- Source-of-Sales: scope-stable distributor lookup for the portal filter dropdown.
--
-- Why: the portal Source-of-Sales wrapper (getPortalSosDashboard /
-- resolvePortalSosScope in portal-sos-dashboard.ts) already trims the lines/regions/
-- areas/products filter option lists to each viewer's line/region/product scope, but
-- the distributor dropdown was left unscoped — it came straight from the full company
-- master list (loadSalesReferenceData().distributors), so a line/region-locked viewer
-- (District/Regional/National Sales Manager, Product/Group Product Manager, Marketing
-- Manager) could see every nationwide distributor's name regardless of scope. This is
-- metadata only (the actual byDistributor sales VALUES are already correctly scoped via
-- phx_exec_distributor_product's line/region/product params) — but it's still a leak of
-- reference data outside the viewer's authorized visibility.
--
-- A distributor is not naturally 1:1 with a single region/line the way an area or a
-- product is (one distributor's invoices can span many regions/lines), so it cannot be
-- tagged with a single scalar region/line the way `areas`/`products` filter options are.
-- This function instead returns the set of distributor codes that have ANY row within
-- the given region/line scope, independent of period — so the resolved set is stable
-- across the viewer's period/filter selections, matching how the other four dimensions
-- are already scoped (fixed sets resolved once per viewer, not recomputed per filter).
--
-- Verified against staging (izhmxvgiktiafqusolot, 336 rows) and production
-- (ozucdzovmcqvepbozvqf, 69,765 rows / 19 distributors): the existing
-- source_of_sales_fact_rollup_grain_uniq index already satisfies this query via an
-- index-only scan (sub-millisecond on staging) — no additional index required.

create or replace function public.phx_sos_distinct_distributors(
  p_lines text[] default '{}'::text[],
  p_regions text[] default '{}'::text[]
)
 returns table(distributor_code text)
 language sql
 stable security definer
 set search_path to 'public'
 set statement_timeout to '10s'
as $function$
  select distinct f.distributor_code
  from public.source_of_sales_fact_rollup f
  where (
      cardinality(p_lines) = 0
      or lower(btrim(coalesce(f.official_line, ''))) in (select lower(btrim(x)) from unnest(p_lines) as x)
    )
    and (
      cardinality(p_regions) = 0
      or upper(btrim(coalesce(f.region_code, ''))) in (select upper(btrim(x)) from unnest(p_regions) as x)
    );
$function$;

revoke all on function public.phx_sos_distinct_distributors(text[], text[])
  from public, anon, authenticated;
grant execute on function public.phx_sos_distinct_distributors(text[], text[])
  to service_role;

-- analytics_readonly is granted execute on the sibling SoS RPCs (see
-- 20260625155000_analytics_schema_views.sql, 20260629180000_sos_distributor_product_scope_pushdown.sql).
-- Re-grant it here too (guarded, in case the role is absent in a given environment).
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'analytics_readonly') then
    grant execute on function public.phx_sos_distinct_distributors(text[], text[])
      to analytics_readonly;
  end if;
end
$$;

notify pgrst, 'reload schema';

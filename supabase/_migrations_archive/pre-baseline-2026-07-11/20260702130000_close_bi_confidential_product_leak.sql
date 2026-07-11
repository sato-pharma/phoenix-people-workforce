-- Security fix: analytics_readonly (Metabase) currently has EXECUTE on 5 phx_* RPCs
-- granted in 20260625155000_analytics_schema_views.sql with a comment claiming they
-- "handle confidential filtering internally". Verified false against the live bodies
-- (confirmed in production via information_schema.role_routine_grants -- all 5 are
-- still granted to analytics_readonly today):
--   * phx_exec_brick / phx_exec_customers / phx_monthly_closing_matrix /
--     phx_monthly_closing_direct have NO product filter at all (LA003/LA004/SS001
--     included in every aggregate since they were first written).
--   * phx_exec_distributor_product accepts p_exclude_codes but DEFAULTS to '{}' —
--     a caller that doesn't pass it (any Metabase question) gets everything.
-- A login role `metabase` (rolinherit = true) is a member of analytics_readonly in
-- production, so every grant above is reachable today by whoever holds the Metabase
-- connection credentials.
--
-- (The sibling issue from the same review -- analytics.sos_fact_all / dim_products_all
-- granted to analytics_readonly -- was already fixed the next day by
-- 20260626130000_analytics_views_client_code_and_grants.sql, which revoked both.
-- Confirmed in production: analytics_readonly has no grant on either view today.)
--
-- Fix:
--   1. Hard-code the LA003/LA004/SS001 exclusion directly into the 4 RPC bodies that
--      never had any filter param — non-optional, no caller override possible.
--   2. Replace analytics_readonly's access to phx_exec_distributor_product with a
--      new phx_exec_distributor_product_bi wrapper that has no p_exclude_codes
--      parameter at all (it always passes the confidential set) and revoke
--      analytics_readonly's execute on the original parametrized function — the app
--      (service_role) keeps using the original directly for the CEO/Super-Admin
--      in-app path (src/lib/sales/sos-dashboard.ts), which is unaffected.
--   3. Defensive only, no live gap today: guarded re-revoke of sos_fact_all /
--      dim_products_all from analytics_readonly (no-op in production, protects any
--      environment where the 20260626130000 revoke was skipped) plus a new, unused
--      analytics_privileged role as opt-in scaffolding for a future CEO-only Metabase
--      connection. Nothing is granted to the `metabase` login role by this migration.

begin;

-- ── 1. Hard-code confidential exclusion into the 4 unfiltered RPCs ─────────────

create or replace function public.phx_exec_brick(p_period text default null::text)
 returns table(distributor_code text, region_code text, area_code text, brick_id text, units numeric, value numeric)
 language sql
 stable security definer
 set search_path to 'public'
 set statement_timeout to '45s'
as $function$
  select
    f.distributor_code,
    f.region_code,
    f.area_code,
    f.brick_id,
    sum(f.total_qty) as units,
    sum(f.effective_units * coalesce(p.factory_price, 0)) as value
  from public.source_of_sales_fact_rollup f
  left join public.source_of_sales_products p
    on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
  where (p_period is null or f.period = p_period)
    and f.is_direct = false
    and upper(btrim(coalesce(f.product_code, ''))) not in ('LA003', 'LA004', 'SS001')
  group by f.distributor_code, f.region_code, f.area_code, f.brick_id;
$function$;

create or replace function public.phx_exec_customers(p_period text default null)
returns table (
  client_code    text,
  client_name    text,
  distributor_code text,
  region_code    text,
  area_code      text,
  brick_id       text,
  units          numeric,
  value          numeric
)
language sql
stable
security definer
set search_path = public
set statement_timeout = '45s'
as $$
  with filtered as (
    select
      r.client_code,
      r.client_name,
      r.distributor_code,
      r.region_code,
      r.area_code,
      r.brick_id,
      r.latest_row_created_at,
      r.total_qty,
      r.effective_units * coalesce(p.factory_price, 0) as line_value
    from public.source_of_sales_customer_directory_rollup r
    join public.source_of_sales_import_batches b
      on b.id = r.batch_id and b.status = 'validated'
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = r.product_code
    where (p_period is null or r.period = p_period)
      and r.client_code is not null
      and upper(btrim(coalesce(r.product_code, ''))) not in ('LA003', 'LA004', 'SS001')
  ),
  latest as (
    select distinct on (client_code, distributor_code)
      client_code, distributor_code, client_name, region_code, area_code, brick_id
    from filtered
    order by client_code, distributor_code, latest_row_created_at desc
  ),
  agg as (
    select
      client_code,
      distributor_code,
      sum(total_qty)    as units,
      sum(line_value)   as value
    from filtered
    group by client_code, distributor_code
  )
  select a.client_code, l.client_name, a.distributor_code,
         l.region_code, l.area_code, l.brick_id, a.units, a.value
  from agg a
  join latest l using (client_code, distributor_code);
$$;

create or replace function public.phx_monthly_closing_matrix(p_line text, p_period text)
returns table (
  area_code    text,
  product_code text,
  sales_units  numeric,
  sales_value  numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select
    f.area_code, f.product_code,
    sum(f.total_qty)                                       as sales_units,
    sum(f.effective_units * coalesce(p.factory_price, 0)) as sales_value
  from public.source_of_sales_fact_rollup f
  join public.source_of_sales_import_batches b
    on b.id = f.batch_id and b.status = 'validated'
  left join public.source_of_sales_products p
    on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
  where f.period = p_period
    and lower(btrim(f.official_line)) = lower(btrim(p_line))
    and not f.is_direct
    and upper(btrim(coalesce(f.product_code, ''))) not in ('LA003', 'LA004', 'SS001')
  group by f.area_code, f.product_code;
$$;

create or replace function public.phx_monthly_closing_direct(p_line text, p_period text)
returns table (
  region_code  text,
  product_code text,
  sales_units  numeric,
  sales_value  numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select
    f.region_code, f.product_code,
    sum(f.total_qty)   as sales_units,
    sum(f.direct_value) as sales_value
  from public.source_of_sales_fact_rollup f
  join public.source_of_sales_import_batches b
    on b.id = f.batch_id and b.status = 'validated'
  where f.period = p_period
    and lower(btrim(f.official_line)) = lower(btrim(p_line))
    and f.is_direct
    and upper(btrim(coalesce(f.product_code, ''))) not in ('LA003', 'LA004', 'SS001')
  group by f.region_code, f.product_code;
$$;

-- CREATE OR REPLACE with an unchanged signature preserves existing grants, so
-- analytics_readonly's/service_role's EXECUTE on these 4 functions carries over
-- unchanged — only the returned rows are now confidential-filtered.

-- ── 2. BI-only wrapper for phx_exec_distributor_product (no override possible) ──

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'analytics_readonly') then
    revoke execute on function public.phx_exec_distributor_product(
      text, text[], text[], text[], text[], text[], text[]
    ) from analytics_readonly;
  end if;
end $$;

create or replace function public.phx_exec_distributor_product_bi(
  p_period text default null::text,
  p_lines text[] default '{}'::text[],
  p_distributors text[] default '{}'::text[],
  p_regions text[] default '{}'::text[],
  p_areas text[] default '{}'::text[],
  p_products text[] default '{}'::text[]
)
 returns table(distributor_code text, official_line text, region_code text, area_code text, product_code text, product_name text, units numeric, value numeric)
 language sql
 stable security definer
 set search_path to 'public'
 set statement_timeout to '45s'
as $function$
  select *
  from public.phx_exec_distributor_product(
    p_period, p_lines, p_distributors, p_regions, p_areas, p_products,
    array['LA003', 'LA004', 'SS001']
  );
$function$;

revoke all on function public.phx_exec_distributor_product_bi(text, text[], text[], text[], text[], text[])
  from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'analytics_readonly') then
    grant execute on function public.phx_exec_distributor_product_bi(text, text[], text[], text[], text[], text[])
      to analytics_readonly;
  end if;
end $$;

-- ── 3. Defensive re-revoke + scaffolding for a future CEO-only BI role ─────────

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'analytics_privileged') then
    create role analytics_privileged nologin noinherit;
  end if;
end $$;

grant usage on schema analytics to analytics_privileged;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'analytics_readonly') then
    revoke select on analytics.sos_fact_all      from analytics_readonly;
    revoke select on analytics.dim_products_all  from analytics_readonly;
  end if;
end $$;

grant select on analytics.sos_fact_all      to analytics_privileged;
grant select on analytics.dim_products_all  to analytics_privileged;

comment on role analytics_privileged is
  'CEO/admin-only Metabase access to confidential-inclusive views (sos_fact_all, dim_products_all). '
  'Deliberately NOT granted to the metabase login role by this migration -- wire it to a separate, '
  'dedicated login role for a CEO-only Metabase connection as an explicit follow-up.';

notify pgrst, 'reload schema';

commit;

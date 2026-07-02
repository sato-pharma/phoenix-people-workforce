-- Close the remaining Head-Office half of the SoS geography confidentiality gap.
--
-- 20260702130000_close_bi_confidential_product_leak.sql hard-coded the LA003/LA004/SS001
-- exclusion into phx_exec_brick / phx_exec_customers (non-optional, applies to every caller).
-- But the SAME structural gap has a second component: the confidential Head Office LINE.
-- These two RPCs aggregate away product/line before returning, so the TypeScript backstop
-- (keepExec strips Head Office by official_line for the detail RPC) cannot reach them —
-- a company-scope viewer who may not see Head Office (e.g. SFE Manager) still receives
-- brick/customer totals with Head-Office product revenue mixed in.
--
-- Head-Office product codes are a DYNAMIC set (products whose master line is Head Office),
-- so they cannot be hard-coded here. Instead this migration adds the same additive
-- p_exclude_codes pre-filter that phx_exec_distributor_product already has
-- (20260629180000_sos_distributor_product_scope_pushdown.sql):
--   * The hard-coded LA003/LA004/SS001 exclusion from 20260702130000 is KEPT verbatim in
--     both bodies — the new parameter can only ever exclude MORE, never re-include.
--   * p_exclude_codes defaults to '{}' = no extra filter, so a caller that passes nothing
--     (Metabase via analytics_readonly, currently-deployed app code) is byte-identical to
--     the 20260702130000 behavior.
--   * The app (src/lib/sales/sos-dashboard.ts) passes its already-computed exclusion set
--     (restricted + Head-Office product codes) for viewers who may not see Head Office;
--     CEO / Super Admin resolve to an empty set and keep today's numbers exactly.
--
-- Signature change: adding a parameter to a LANGUAGE sql function via CREATE OR REPLACE
-- would create a SECOND overload and make single-arg calls ambiguous in PostgREST. So the
-- one-arg functions are DROPped first, then recreated with the new defaulted parameter.
-- DROP also clears grants; both current grantees are re-applied below: service_role (the
-- app's admin client) and analytics_readonly (Metabase — granted in 20260625155000 and
-- deliberately retained by 20260702130000 because the hard-coded filter makes the
-- functions safe for BI).
--
-- DEPLOY ORDER: apply this migration BEFORE deploying the code that passes the new
-- parameter. The currently-deployed code only sends p_period, which keeps resolving after
-- this migration (default), so there is no window where prod breaks. The new app code
-- additionally omits p_exclude_codes whenever the set is empty, so CEO/Super-Admin calls
-- remain valid even against a database that has not run this migration yet.

drop function if exists public.phx_exec_brick(text);

create or replace function public.phx_exec_brick(
  p_period text default null::text,
  p_exclude_codes text[] default '{}'::text[]
)
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
    and (
      cardinality(p_exclude_codes) = 0
      or upper(btrim(coalesce(f.product_code, ''))) <> all (select upper(btrim(x)) from unnest(p_exclude_codes) as x)
    )
  group by f.distributor_code, f.region_code, f.area_code, f.brick_id;
$function$;

revoke all on function public.phx_exec_brick(text, text[]) from public, anon, authenticated;
grant execute on function public.phx_exec_brick(text, text[]) to service_role;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'analytics_readonly') then
    grant execute on function public.phx_exec_brick(text, text[]) to analytics_readonly;
  end if;
end $$;


drop function if exists public.phx_exec_customers(text);

create or replace function public.phx_exec_customers(
  p_period text default null::text,
  p_exclude_codes text[] default '{}'::text[]
)
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
      and (
        cardinality(p_exclude_codes) = 0
        or upper(btrim(coalesce(r.product_code, ''))) <> all (select upper(btrim(x)) from unnest(p_exclude_codes) as x)
      )
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

revoke all on function public.phx_exec_customers(text, text[]) from public, anon, authenticated;
grant execute on function public.phx_exec_customers(text, text[]) to service_role;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'analytics_readonly') then
    grant execute on function public.phx_exec_customers(text, text[]) to analytics_readonly;
  end if;
end $$;

notify pgrst, 'reload schema';

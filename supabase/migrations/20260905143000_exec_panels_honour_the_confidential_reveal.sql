-- The confidential-product reveal never reached Top Customers or Top Bricks, under a footer that
-- said it did.
--
-- Both functions carried an UNCONDITIONAL predicate:
--
--     and upper(btrim(coalesce(f.product_code, ''))) not in ('LA003', 'LA004', 'SS001')
--
-- sitting immediately above a correct, parameterised one that already honours p_exclude_codes. So
-- no argument could ever reveal those products: the caller's choice was overridden by a literal.
-- `phx_exec_sos_trend` has no such line, which is exactly what produced the asymmetry — the
-- headline Total Value obeyed the reveal while the two panels beside it did not.
--
-- Measured on production 2026-09-05 for 2026-07: total value 61,635,361.30 EGP, of which the three
-- restricted products are 50,960,162.88 EGP — 82.7%. So a CEO ticking "include confidential
-- products" saw the headline quintuple while Top Customers, Top/Lowest Bricks, customerCount,
-- bricksReached and customerTop10Share stayed on the remaining ~9%. April 82.3%, May 70.5%,
-- June 82.6%. The same defect fired on every automated monthly executive email, whose Report Info
-- sheet writes "REVEALED — explicitly opted in for this report".
--
-- DEFAULT BEHAVIOUR IS UNCHANGED. p_exclude_codes still DEFAULTS to
-- ARRAY['LA003','LA004','SS001'], so every caller that does not pass the argument keeps excluding
-- exactly the same three products. Only a caller that explicitly passes a different set — which is
-- what the reveal does — can now see them. Nothing is revealed to anyone who was not already
-- entitled to ask.
--
-- Everything else in both bodies is byte-identical to what pg_get_functiondef returned before this
-- migration, including SECURITY DEFINER, search_path, the timeouts and work_mem. The Head Office
-- lock is untouched: the caller adds head-office product codes to p_exclude_codes for viewers who
-- may not see them, and that path still works because it goes through the parameterised clause.

create or replace function public.phx_exec_brick(
  p_period text default null::text,
  p_exclude_codes text[] default array['LA003'::text, 'LA004'::text, 'SS001'::text],
  p_lines text[] default null::text[],
  p_products text[] default null::text[],
  p_regions text[] default null::text[],
  p_areas text[] default null::text[]
)
returns table(distributor_code text, region_code text, area_code text, brick_id text, units numeric, value numeric)
language plpgsql
stable security definer
set search_path to 'public'
set statement_timeout to '45s'
as $function$
#variable_conflict use_column
begin
  return query
  select
    f.distributor_code,
    f.region_code,
    f.area_code,
    f.brick_id,
    sum(f.total_qty) as units,
    sum(f.effective_units * coalesce(p.factory_price, 0)) as value
  from public.source_of_sales_fact_rollup f
  join public.source_of_sales_import_batches b
    on b.id = f.batch_id and b.status = 'validated'
  left join public.source_of_sales_products p
    on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
  where (p_period is null or f.period = p_period)
    and f.is_direct = false
    and (
      cardinality(p_exclude_codes) = 0
      or upper(btrim(coalesce(f.product_code, ''))) <> all (
           select upper(btrim(x)) from unnest(p_exclude_codes) as x)
    )
    and (p_lines    is null or f.official_line = any(p_lines))
    and (p_products is null or f.product_code  = any(p_products))
    and (p_regions  is null or f.region_code   = any(p_regions))
    and (p_areas    is null or f.area_code     = any(p_areas))
  group by f.distributor_code, f.region_code, f.area_code, f.brick_id;
end;
$function$;

create or replace function public.phx_exec_customers(
  p_period text default null::text,
  p_exclude_codes text[] default array['LA003'::text, 'LA004'::text, 'SS001'::text],
  p_lines text[] default null::text[],
  p_products text[] default null::text[],
  p_regions text[] default null::text[],
  p_areas text[] default null::text[]
)
returns table(client_code text, client_name text, distributor_code text, region_code text, area_code text, brick_id text, units numeric, value numeric)
language plpgsql
stable security definer
set search_path to 'public'
set statement_timeout to '45s'
set work_mem to '96MB'
as $function$
#variable_conflict use_column
begin
  return query
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
      case when r.is_direct
           then coalesce(r.direct_value, 0)
           else r.effective_units * coalesce(p.factory_price, 0)
      end as line_value
    from public.source_of_sales_customer_directory_rollup r
    join public.source_of_sales_import_batches b
      on b.id = r.batch_id and b.status = 'validated'
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(r.product_code))
    where (p_period is null or r.period = p_period)
      and r.client_code is not null
      and (
        cardinality(p_exclude_codes) = 0
        or upper(btrim(coalesce(r.product_code, ''))) <> all (
             select upper(btrim(x)) from unnest(p_exclude_codes) as x)
      )
      and (p_lines    is null or r.official_line = any(p_lines))
      and (p_products is null or r.product_code  = any(p_products))
      and (p_regions  is null or r.region_code   = any(p_regions))
      and (p_areas    is null or r.area_code     = any(p_areas))
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
      sum(total_qty)  as units,
      sum(line_value) as value
    from filtered
    group by client_code, distributor_code
  )
  select a.client_code, l.client_name, a.distributor_code,
         l.region_code, l.area_code, l.brick_id, a.units, a.value
  from agg a
  join latest l using (client_code, distributor_code);
end;
$function$;

-- Both functions are SECURITY DEFINER, so EXECUTE must not sit with PUBLIC: anon and authenticated
-- inherit it through PUBLIC membership, which makes revoking only those two a no-op. Revoking
-- PUBLIC on a default ACL also strips service_role, so it is re-granted explicitly.
--
-- This REPRODUCES the live ACL rather than changing it. Measured on production before writing:
-- both functions already read `postgres=X/postgres | service_role=X/postgres` — CREATE OR REPLACE
-- preserves privileges, so the replacement above did not widen anything. These statements make the
-- file honest about the state it leaves behind, and make a fresh environment match production.

revoke execute on function public.phx_exec_brick(text, text[], text[], text[], text[], text[]) from public, anon, authenticated;
grant  execute on function public.phx_exec_brick(text, text[], text[], text[], text[], text[]) to service_role;

revoke execute on function public.phx_exec_customers(text, text[], text[], text[], text[], text[]) from public, anon, authenticated;
grant  execute on function public.phx_exec_customers(text, text[], text[], text[], text[], text[]) to service_role;

-- NOTE — `r.client_code is not null` above is a SEPARATE, still-open defect: Office invoices carry
-- no client code, so Office contributes zero customer-directory rows and Top Customers omits
-- 3,930,227.33 EGP (41.8% of 2026-07 distributor value) with no visible gap. It is deliberately NOT
-- changed here, because deciding how Office should appear in a customer list is the owner's call,
-- not a mechanical fix. Tracked separately.

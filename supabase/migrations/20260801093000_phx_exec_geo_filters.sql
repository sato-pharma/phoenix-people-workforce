-- The SoS dashboard's Top Bricks / Top Customers panels ignore the filters above them.
--
-- phx_exec_brick and phx_exec_customers accept only (p_period, p_exclude_codes). They never receive
-- the line, product, region or area the viewer selected, so src/lib/sales/sos-dashboard.ts can only
-- post-filter on the few dimensions the RPC happens to return — and it cannot post-filter on line or
-- product at all, because neither is in the result set. The result is a company-wide brick and
-- customer list rendered directly beneath a line-scoped headline total.
--
-- This cannot be fixed in TypeScript; the data never leaves Postgres in a filterable shape.
--
-- Three defects are closed here:
--
--  1. FILTERS. p_lines / p_products / p_regions / p_areas are added to both functions. Both rollups
--     already carry official_line, product_code, region_code and area_code, so no view changes.
--
--  2. BATCH STATUS. phx_exec_brick reads source_of_sales_fact_rollup with NO join to
--     source_of_sales_import_batches, so a draft, pending or superseded batch would count as real
--     sales. Its sibling phx_exec_customers already joins and filters on status='validated'; every
--     analytics.* view does too. Currently 0 fact rows sit outside a validated batch, so this is
--     latent — but it is one predicate, and the next re-upload is what would make it live.
--
--  3. ASYMMETRIC NORMALISATION in the caller-supplied exclusion. Both functions wrote:
--         coalesce(f.product_code, '') <> all (select upper(btrim(x)) from unnest(p_exclude_codes) x)
--     normalising the RIGHT side only. A stored 'la003' or ' LA003' would therefore slip past a
--     caller-supplied exclusion, even though the hardcoded exclusion two lines above it normalises
--     BOTH sides. Production has 0 unnormalised product codes today, so again latent — but this is
--     the exact class of bug 20260719153000 exists to prevent, and it sits on a confidentiality path.
--
-- The hardcoded LA003/LA004/SS001 exclusion is deliberately LEFT IN PLACE: these two panels stay
-- confidential-free regardless of caller, which is fail-closed. Making them honour a reveal belongs
-- with the reveal wiring, not here.
--
-- Adding parameters creates an OVERLOAD rather than replacing the function, so each is dropped at
-- its exact current signature first. Both re-declare SET statement_timeout / search_path (and
-- work_mem for phx_exec_customers) — CREATE OR REPLACE silently drops those, which is the exact
-- regression 20260728100500 exists to repair.

begin;

-- ── phx_exec_brick ───────────────────────────────────────────────────────────
drop function if exists public.phx_exec_brick(text, text[]);

create function public.phx_exec_brick(
  p_period        text   default null,
  p_exclude_codes text[] default '{}'::text[],
  p_lines         text[] default null,
  p_products      text[] default null,
  p_regions       text[] default null,
  p_areas         text[] default null
)
returns table(distributor_code text, region_code text, area_code text, brick_id text,
              units numeric, value numeric)
language plpgsql
stable
security definer
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
    on p.product_code = f.product_code
  where (p_period is null or f.period = p_period)
    and f.is_direct = false
    and upper(btrim(coalesce(f.product_code, ''))) not in ('LA003', 'LA004', 'SS001')
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

-- ── phx_exec_customers ───────────────────────────────────────────────────────
drop function if exists public.phx_exec_customers(text, text[]);

create function public.phx_exec_customers(
  p_period        text   default null,
  p_exclude_codes text[] default '{}'::text[],
  p_lines         text[] default null,
  p_products      text[] default null,
  p_regions       text[] default null,
  p_areas         text[] default null
)
returns table(client_code text, client_name text, distributor_code text, region_code text,
              area_code text, brick_id text, units numeric, value numeric)
language plpgsql
stable
security definer
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
      r.effective_units * coalesce(p.factory_price, 0) as line_value
    from public.source_of_sales_customer_directory_rollup r
    join public.source_of_sales_import_batches b
      on b.id = r.batch_id and b.status = 'validated'
    left join public.source_of_sales_products p
      on p.product_code = r.product_code
    where (p_period is null or r.period = p_period)
      and r.client_code is not null
      and upper(btrim(coalesce(r.product_code, ''))) not in ('LA003', 'LA004', 'SS001')
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

-- ── ACLs ─────────────────────────────────────────────────────────────────────
revoke execute on function public.phx_exec_brick(text, text[], text[], text[], text[], text[])
  from public, anon, authenticated;
revoke execute on function public.phx_exec_customers(text, text[], text[], text[], text[], text[])
  from public, anon, authenticated;

grant execute on function public.phx_exec_brick(text, text[], text[], text[], text[], text[])
  to service_role;
grant execute on function public.phx_exec_customers(text, text[], text[], text[], text[], text[])
  to service_role;

commit;

notify pgrst, 'reload schema';

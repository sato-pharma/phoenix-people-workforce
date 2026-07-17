-- ============================================================================
-- E-1: phx_exec_* RPC period-branch rewrite (STAGING migration)
-- Migration name: phx_exec_rpc_period_branch_rewrite
-- Target project: cifwmndunmlxjhyjugxa (Phoenix-HR-Staging) ONLY
--
-- What changes (per validated diagnosis, preconditions re-verified on staging):
--   1. LANGUAGE sql -> plpgsql with an IF branch on the period parameter, so
--      single-period calls plan `period = $1` (period index) instead of the
--      un-indexable `(p_period is null OR period = p_period)` OR-pattern.
--   2. Column-side upper(btrim(...)) on product_code is dropped (verified: 0
--      unnormalized / 0 null product_code rows in source_of_sales_fact_rollup,
--      source_of_sales_customer_directory_rollup, source_of_sales_products on
--      staging). Parameter-side normalization (upper(btrim(x)) on unnest) is
--      KEPT everywhere.
--   3. official_line / distributor_code / region_code / area_code column
--      normalizations are KEPT verbatim (those columns are NOT normalized).
--   4. The confidential LA003/LA004/SS001 exclusion in phx_exec_brick and
--      phx_exec_customers is kept VERBATIM (including its upper(btrim())
--      defense-in-depth) and appears in BOTH branches.
--   5. Signatures, parameter names/defaults, RETURNS TABLE column lists,
--      STABLE SECURITY DEFINER, search_path, statement_timeout (and work_mem
--      for customers) are identical to the originals.
--   #variable_conflict use_column reproduces SQL-function name resolution for
--   the unqualified column references inside phx_exec_customers' CTEs.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) phx_exec_sos_trend
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.phx_exec_sos_trend(
  p_periods text[] DEFAULT '{}'::text[],
  p_lines text[] DEFAULT '{}'::text[],
  p_distributors text[] DEFAULT '{}'::text[],
  p_regions text[] DEFAULT '{}'::text[],
  p_areas text[] DEFAULT '{}'::text[],
  p_products text[] DEFAULT '{}'::text[],
  p_exclude_codes text[] DEFAULT '{}'::text[]
)
 RETURNS TABLE(period text, units numeric, value numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '45s'
AS $function$
#variable_conflict use_column
begin
  if cardinality(p_periods) = 0 then
    -- all-periods branch (empty array). NULL p_periods falls to ELSE and
    -- yields 0 rows, exactly like the original OR-pattern.
    return query
    select
      f.period,
      sum(f.total_qty) as units,
      sum(case when f.is_direct
               then f.direct_value
               else f.effective_units * coalesce(p.factory_price, 0) end) as value
    from public.source_of_sales_fact_rollup f
    left join public.source_of_sales_products p
      on p.product_code = f.product_code
    where (
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
        or coalesce(f.product_code, '') in (select upper(btrim(x)) from unnest(p_products) as x)
      )
      and (
        cardinality(p_exclude_codes) = 0
        or coalesce(f.product_code, '') <> all (select upper(btrim(x)) from unnest(p_exclude_codes) as x)
      )
    group by f.period;
  else
    return query
    select
      f.period,
      sum(f.total_qty) as units,
      sum(case when f.is_direct
               then f.direct_value
               else f.effective_units * coalesce(p.factory_price, 0) end) as value
    from public.source_of_sales_fact_rollup f
    left join public.source_of_sales_products p
      on p.product_code = f.product_code
    where f.period = any (p_periods)
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
        or coalesce(f.product_code, '') in (select upper(btrim(x)) from unnest(p_products) as x)
      )
      and (
        cardinality(p_exclude_codes) = 0
        or coalesce(f.product_code, '') <> all (select upper(btrim(x)) from unnest(p_exclude_codes) as x)
      )
    group by f.period;
  end if;
end;
$function$;

-- ----------------------------------------------------------------------------
-- 2) phx_exec_customers  (DISTINCT ON / CTE shape preserved per diagnosis (c))
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.phx_exec_customers(
  p_period text DEFAULT NULL::text,
  p_exclude_codes text[] DEFAULT '{}'::text[]
)
 RETURNS TABLE(client_code text, client_name text, distributor_code text, region_code text, area_code text, brick_id text, units numeric, value numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '45s'
 SET work_mem TO '96MB'
AS $function$
#variable_conflict use_column
begin
  if p_period is null then
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
      where r.client_code is not null
        and upper(btrim(coalesce(r.product_code, ''))) not in ('LA003', 'LA004', 'SS001')
        and (
          cardinality(p_exclude_codes) = 0
          or coalesce(r.product_code, '') <> all (select upper(btrim(x)) from unnest(p_exclude_codes) as x)
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
  else
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
      where r.period = p_period
        and r.client_code is not null
        and upper(btrim(coalesce(r.product_code, ''))) not in ('LA003', 'LA004', 'SS001')
        and (
          cardinality(p_exclude_codes) = 0
          or coalesce(r.product_code, '') <> all (select upper(btrim(x)) from unnest(p_exclude_codes) as x)
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
  end if;
end;
$function$;

-- ----------------------------------------------------------------------------
-- 3) phx_exec_brick
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.phx_exec_brick(
  p_period text DEFAULT NULL::text,
  p_exclude_codes text[] DEFAULT '{}'::text[]
)
 RETURNS TABLE(distributor_code text, region_code text, area_code text, brick_id text, units numeric, value numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '45s'
AS $function$
#variable_conflict use_column
begin
  if p_period is null then
    return query
    select
      f.distributor_code,
      f.region_code,
      f.area_code,
      f.brick_id,
      sum(f.total_qty) as units,
      sum(f.effective_units * coalesce(p.factory_price, 0)) as value
    from public.source_of_sales_fact_rollup f
    left join public.source_of_sales_products p
      on p.product_code = f.product_code
    where f.is_direct = false
      and upper(btrim(coalesce(f.product_code, ''))) not in ('LA003', 'LA004', 'SS001')
      and (
        cardinality(p_exclude_codes) = 0
        or coalesce(f.product_code, '') <> all (select upper(btrim(x)) from unnest(p_exclude_codes) as x)
      )
    group by f.distributor_code, f.region_code, f.area_code, f.brick_id;
  else
    return query
    select
      f.distributor_code,
      f.region_code,
      f.area_code,
      f.brick_id,
      sum(f.total_qty) as units,
      sum(f.effective_units * coalesce(p.factory_price, 0)) as value
    from public.source_of_sales_fact_rollup f
    left join public.source_of_sales_products p
      on p.product_code = f.product_code
    where f.period = p_period
      and f.is_direct = false
      and upper(btrim(coalesce(f.product_code, ''))) not in ('LA003', 'LA004', 'SS001')
      and (
        cardinality(p_exclude_codes) = 0
        or coalesce(f.product_code, '') <> all (select upper(btrim(x)) from unnest(p_exclude_codes) as x)
      )
    group by f.distributor_code, f.region_code, f.area_code, f.brick_id;
  end if;
end;
$function$;

-- ----------------------------------------------------------------------------
-- 4) phx_exec_distributor_product
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.phx_exec_distributor_product(
  p_period text DEFAULT NULL::text,
  p_lines text[] DEFAULT '{}'::text[],
  p_distributors text[] DEFAULT '{}'::text[],
  p_regions text[] DEFAULT '{}'::text[],
  p_areas text[] DEFAULT '{}'::text[],
  p_products text[] DEFAULT '{}'::text[],
  p_exclude_codes text[] DEFAULT '{}'::text[]
)
 RETURNS TABLE(distributor_code text, official_line text, region_code text, area_code text, product_code text, product_name text, units numeric, value numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '45s'
AS $function$
#variable_conflict use_column
begin
  if p_period is null then
    return query
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
      on p.product_code = f.product_code
    where (
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
        or coalesce(f.product_code, '') in (select upper(btrim(x)) from unnest(p_products) as x)
      )
      and (
        cardinality(p_exclude_codes) = 0
        or coalesce(f.product_code, '') <> all (select upper(btrim(x)) from unnest(p_exclude_codes) as x)
      )
    group by f.distributor_code, f.official_line, f.region_code,
             coalesce(nullif(f.area_code, ''), 'DIRECT'), f.product_code;
  else
    return query
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
      on p.product_code = f.product_code
    where f.period = p_period
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
        or coalesce(f.product_code, '') in (select upper(btrim(x)) from unnest(p_products) as x)
      )
      and (
        cardinality(p_exclude_codes) = 0
        or coalesce(f.product_code, '') <> all (select upper(btrim(x)) from unnest(p_exclude_codes) as x)
      )
    group by f.distributor_code, f.official_line, f.region_code,
             coalesce(nullif(f.area_code, ''), 'DIRECT'), f.product_code;
  end if;
end;
$function$;

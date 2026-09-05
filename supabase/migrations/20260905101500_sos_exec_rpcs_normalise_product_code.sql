-- Source of Sales exec RPCs: match product_code case-insensitively, on BOTH sides.
--
-- From the 2026-08-09 SoS audit, findings `db:public.phx_exec_distributor_product:21` and `:48`,
-- both re-verified against production on 2026-09-05 and both still live.
--
-- TWO DEFECTS, three functions:
--
--   1. The product-master join was raw:  `on p.product_code = f.product_code`
--      in phx_exec_brick, phx_exec_distributor_product and phx_exec_sos_trend. A fact row whose
--      code differs only in case or padding misses the master, so `coalesce(p.factory_price, 0)`
--      resolves to 0 and that row's VALUE silently becomes zero while its units still count.
--
--   2. The product filters normalised only the PARAMETER side:
--      `coalesce(f.product_code,'') in (select upper(btrim(x)) ...)` in
--      phx_exec_distributor_product and phx_exec_sos_trend, in both of their branches.
--
-- Defect 2 is the one that matters most, and it is not a reporting bug. The same one-sided pattern
-- guards `p_exclude_codes`, whose default is the CONFIDENTIAL set ARRAY['LA003','LA004','SS001'].
-- A fact row carrying `la003` satisfies `coalesce(f.product_code,'') <> all (…'LA003'…)`, so the
-- confidential product PASSES the exclusion and reaches the caller. The lock fails OPEN on a case
-- variant. phx_exec_brick already normalised both sides of its own exclude filter, which is what
-- made the inconsistency visible.
--
-- MEASURED ON PRODUCTION (ozucdzovmcqvepbozvqf) BEFORE WRITING THIS, 2026-09-05:
--   · 25 distinct fact codes, 30 master codes; 0 match only when normalised; 0 unmastered either way
--   · 0 codes on either side are not already upper+trimmed — so the data is clean TODAY
--   · 30 master rows, 30 distinct raw codes, 30 distinct normalised codes, 0 fan-out risk
--     (a case-duplicate in the master would make the normalised join multiply rows — this repo has
--      already had a case-duplicate line_area_map row DOUBLE a whole line, so it was checked first)
--   · raw join vs normalised join over the whole fact rollup: 3,026 groups each,
--     408,384,879.84 EGP each, 0 rows differing
--
-- So this changes NO number today. It is a latent trap being closed, not a restatement — and that
-- was proven before the migration rather than asserted after it.
--
-- Every function below is reproduced from `pg_get_functiondef` on production and changed ONLY at
-- the join and the two product filters; signatures, volatility, security, search_path and the
-- statement timeouts are byte-identical to what is live.

-- ── phx_exec_brick ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.phx_exec_brick(p_period text DEFAULT NULL::text, p_exclude_codes text[] DEFAULT ARRAY['LA003'::text, 'LA004'::text, 'SS001'::text], p_lines text[] DEFAULT NULL::text[], p_products text[] DEFAULT NULL::text[], p_regions text[] DEFAULT NULL::text[], p_areas text[] DEFAULT NULL::text[])
 RETURNS TABLE(distributor_code text, region_code text, area_code text, brick_id text, units numeric, value numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '45s'
AS $function$
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

-- ── phx_exec_distributor_product ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.phx_exec_distributor_product(p_period text DEFAULT NULL::text, p_lines text[] DEFAULT '{}'::text[], p_distributors text[] DEFAULT '{}'::text[], p_regions text[] DEFAULT '{}'::text[], p_areas text[] DEFAULT '{}'::text[], p_products text[] DEFAULT '{}'::text[], p_exclude_codes text[] DEFAULT ARRAY['LA003'::text, 'LA004'::text, 'SS001'::text])
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
      on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
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
        or upper(btrim(coalesce(f.product_code, ''))) in (select upper(btrim(x)) from unnest(p_products) as x)
      )
      and (
        cardinality(p_exclude_codes) = 0
        or upper(btrim(coalesce(f.product_code, ''))) <> all (select upper(btrim(x)) from unnest(p_exclude_codes) as x)
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
      on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
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
        or upper(btrim(coalesce(f.product_code, ''))) in (select upper(btrim(x)) from unnest(p_products) as x)
      )
      and (
        cardinality(p_exclude_codes) = 0
        or upper(btrim(coalesce(f.product_code, ''))) <> all (select upper(btrim(x)) from unnest(p_exclude_codes) as x)
      )
    group by f.distributor_code, f.official_line, f.region_code,
             coalesce(nullif(f.area_code, ''), 'DIRECT'), f.product_code;
  end if;
end;
$function$;

-- ── phx_exec_sos_trend ───────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.phx_exec_sos_trend(p_periods text[] DEFAULT '{}'::text[], p_lines text[] DEFAULT '{}'::text[], p_distributors text[] DEFAULT '{}'::text[], p_regions text[] DEFAULT '{}'::text[], p_areas text[] DEFAULT '{}'::text[], p_products text[] DEFAULT '{}'::text[], p_exclude_codes text[] DEFAULT ARRAY['LA003'::text, 'LA004'::text, 'SS001'::text])
 RETURNS TABLE(period text, units numeric, value numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '45s'
AS $function$
#variable_conflict use_column
begin
  if cardinality(p_periods) = 0 then
    return query
    select
      f.period,
      sum(f.total_qty) as units,
      sum(case when f.is_direct
               then f.direct_value
               else f.effective_units * coalesce(p.factory_price, 0) end) as value
    from public.source_of_sales_fact_rollup f
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
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
        or upper(btrim(coalesce(f.product_code, ''))) in (select upper(btrim(x)) from unnest(p_products) as x)
      )
      and (
        cardinality(p_exclude_codes) = 0
        or upper(btrim(coalesce(f.product_code, ''))) <> all (select upper(btrim(x)) from unnest(p_exclude_codes) as x)
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
      on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
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
        or upper(btrim(coalesce(f.product_code, ''))) in (select upper(btrim(x)) from unnest(p_products) as x)
      )
      and (
        cardinality(p_exclude_codes) = 0
        or upper(btrim(coalesce(f.product_code, ''))) <> all (select upper(btrim(x)) from unnest(p_exclude_codes) as x)
      )
    group by f.period;
  end if;
end;
$function$;

-- ── Re-assert the SECURITY DEFINER grants ────────────────────────────────────────────────────
-- CREATE OR REPLACE keeps the existing ACL, so on production these statements change NOTHING:
-- measured 2026-09-05, all three already read `postgres=X/postgres | service_role=X/postgres`,
-- with no PUBLIC, anon or authenticated entry.
--
-- They are here for REPLAY. On a fresh database the CREATE above would take the default ACL, which
-- grants EXECUTE to PUBLIC — and these are SECURITY DEFINER functions reading the whole fact
-- rollup, so that would hand every role the confidential-product data the exclude filter above
-- exists to withhold. Revoking anon/authenticated alone is a no-op because both inherit through
-- PUBLIC membership; and revoking PUBLIC on a default ACL also strips service_role, which is why
-- each grant is re-stated explicitly.
revoke execute on function public.phx_exec_brick(text, text[], text[], text[], text[], text[]) from public, anon, authenticated;
grant  execute on function public.phx_exec_brick(text, text[], text[], text[], text[], text[]) to service_role;

revoke execute on function public.phx_exec_distributor_product(text, text[], text[], text[], text[], text[], text[]) from public, anon, authenticated;
grant  execute on function public.phx_exec_distributor_product(text, text[], text[], text[], text[], text[], text[]) to service_role;

revoke execute on function public.phx_exec_sos_trend(text[], text[], text[], text[], text[], text[], text[]) from public, anon, authenticated;
grant  execute on function public.phx_exec_sos_trend(text[], text[], text[], text[], text[], text[], text[]) to service_role;

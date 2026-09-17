-- Source of Sales database load: two indexes and two leaner read functions. NO figure changes.
--
-- WHY. pg_stat_statements on production (ozucdzovmcqvepbozvqf), stats reset 2026-09-09 00:59 Cairo,
-- read 2026-09-17 19:10 Cairo: Source of Sales reads were ~22% of all database execution time. The
-- heaviest paths and what each costs today:
--
--   1. Monthly Closing details, the import-row page reads (src/lib/sales/monthly-closing-details.ts)
--        first page 1,383.8 ms mean · later pages 65.4 ms mean over 61,738 calls
--      Fixed in the APP, not here: it now pages each batch on the table's own unique
--      (batch_id, row_number) index instead of walking the primary key from the first row ever
--      imported. No schema change is needed for it.
--
--   2. Direct-order submitters (loadDirectSubmitters, src/lib/sales/closing-organogram-regions.ts)
--        454.2 ms mean. Asks `batch_id IN (…) AND is_direct AND official_line = <line>`; the only
--        usable index is batch_id alone, so it fetched every row of the month to keep ~24.
--        EXPLAIN on production: 8,920 heap blocks for 24 rows.
--      → INDEX sos_rows_batch_direct_line_idx (batch_id, is_direct, official_line).
--        Plain columns, not partial: PostgREST binds its filter values as parameters, so a generic
--        plan cannot prove a partial index's predicate. Staging, same month: 1,587 ms → 4.8 ms.
--
--   3. phx_exec_sos_trend (sos-dashboard.ts, the trend chart)
--        1,022 ms mean. Per ROW it evaluated upper()/lower() under the ICU collation six times and
--        re-ran each `IN (select … unnest)` / `<> all (select … unnest)` sub-select.
--      → REWRITTEN below: normalise the parameters ONCE, group the rollup by its raw columns first
--        (nulling a column whose filter is off), then apply the SAME predicates to the few thousand
--        groups instead of the quarter-million rows.
--
--   4. phx_sos_distinct_distributors (portal-sos-dashboard.ts, the distributor dropdown scope)
--        1,084.5 ms mean, 564 ms warm. A full parallel scan of the rollup to find ~20 codes.
--      → INDEX sos_fact_rollup_distributor_line_region_idx on (distributor_code, the SAME line
--        expression, the SAME region expression), and the body REWRITTEN below to step through the
--        ~20 codes on it and ask one index probe each. Staging: 248 ms → 1.1 ms.
--
-- EXACTNESS — "do not change any sales figure". Each rewrite returns exactly what the old body did,
-- and that was PROVEN, not argued: on staging (Phoenix-HR-Staging, cifwmndunmlxjhyjugxa, whose two
-- function definitions are byte-identical to production's — same md5), the old functions' outputs
-- were captured as TEXT for 39 trend parameter sets and 56 distributor parameter sets (NULL and
-- empty arrays, a blank line, `{NULL}` elements, case and space variants, several lines, regions,
-- areas incl. DIRECT and blank, products, the confidential exclusions, a far-future period), then
-- compared both ways after this migration: trend 162 = 162 rows, distributors 206 = 206 rows,
-- 0 rows differing in either direction (2026-09-17). The same bodies, run read-only beside the live
-- functions on PRODUCTION data, also matched: trend all-lines and Pedia × three regions 0 differing,
-- distributors 56 = 56 rows.
--
-- Staging timings, median of 5, old and new alternating in one session:
--   trend all lines, 8 months      1,410 ms → 174 ms      distributors, Pedia            248 ms → 2.3 ms
--   trend Pedia, 8 months            353 ms →  19.5 ms    distributors, 3 lines × 2 regions  387 ms → 2.6 ms
--   trend CNS, 8 months            1,250 ms → 318 ms      direct submitters, July      1,587 ms → 4.8 ms
--   trend CNS × Giza, 8 months       500 ms → 414 ms  (CNS is half the rollup; that call is now a
--                                                      scan-and-group floor, not a per-row cost)
--
-- Why the rewrites are exact, rule by rule:
--   · `x IN (select f(e) from unnest(p))`  ≡  `x = any(array(select f(e) from unnest(p)))`, and
--     `x <> ALL (select …)`  ≡  `x <> all(array(select …))` — same TRUE / FALSE / NULL in every case,
--     including a NULL element and a NULL array (unnest(NULL) is empty in both). Every
--     `cardinality(p_x) = 0` guard still reads the ORIGINAL parameter, so a NULL array still empties
--     the result exactly as before, and a NULL p_exclude_codes still excludes nothing.
--   · Grouping before filtering: every filter and the product join read only columns that are in the
--     group key, and all rows of a group share those raw values, so a group passes exactly when each
--     of its rows would have. A column is nulled out of the key only while its filter is OFF
--     (`cardinality = 0`, which is TRUE for any value). numeric sums and products are exact, so
--     Σ(units × price) = (Σ units) × price to the last digit and scale; `is_direct` is in the key,
--     so the direct/priced split is untouched.
--   · The line pre-filter `lower(btrim(official_line)) = any(lines)` (it matches the existing
--     sos_fact_rollup_line_period_idx) is used ONLY when no requested line is blank: a NULL line then
--     fails both it and the original `coalesce(…,'')` test. The original predicate is still applied
--     afterwards, unchanged.
--   · Distinct distributors: stepping through the index yields each non-NULL code once, in the same
--     equality the old DISTINCT used; a NULL code (none today on production) keeps its own branch.
--
-- PRODUCTION APPLY — no PITR there, so both indexes are announced to the owner first. They are
-- built by hand with CREATE INDEX CONCURRENTLY (no write lock on tables imports write to):
-- source_of_sales_import_rows 362,338 rows / 165 MB heap; source_of_sales_fact_rollup 263,473 rows /
-- 65 MB heap (measured 2026-09-17). Staging built them plainly in 1.25 s and 1.04 s (2.2 MB and
-- 1.6 MB). The IF NOT EXISTS below then makes the index half a no-op there, while staging and a
-- fresh replay build them here.
set lock_timeout = '5s';
set statement_timeout = '120s';

create index if not exists sos_rows_batch_direct_line_idx
  on public.source_of_sales_import_rows (batch_id, is_direct, official_line);

create index if not exists sos_fact_rollup_distributor_line_region_idx
  on public.source_of_sales_fact_rollup (
    distributor_code,
    (lower(btrim(coalesce(official_line, '')))),
    (upper(btrim(coalesce(region_code, ''))))
  );

-- An EXPRESSION index gets planner statistics only from ANALYZE.
analyze public.source_of_sales_fact_rollup;

reset statement_timeout;
reset lock_timeout;

-- ── phx_exec_sos_trend ───────────────────────────────────────────────────────────────────────
-- Signature, defaults, return type, volatility, security, search_path and timeout are unchanged.
CREATE OR REPLACE FUNCTION public.phx_exec_sos_trend(p_periods text[] DEFAULT '{}'::text[], p_lines text[] DEFAULT '{}'::text[], p_distributors text[] DEFAULT '{}'::text[], p_regions text[] DEFAULT '{}'::text[], p_areas text[] DEFAULT '{}'::text[], p_products text[] DEFAULT '{}'::text[], p_exclude_codes text[] DEFAULT ARRAY['LA003'::text, 'LA004'::text, 'SS001'::text])
 RETURNS TABLE(period text, units numeric, value numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '45s'
AS $function$
#variable_conflict use_column
declare
  -- Normalised ONCE, exactly as the old per-row sub-selects normalised them.
  v_lines         text[] := array(select lower(btrim(x)) from unnest(p_lines) as x);
  v_distributors  text[] := array(select upper(btrim(x)) from unnest(p_distributors) as x);
  v_regions       text[] := array(select upper(btrim(x)) from unnest(p_regions) as x);
  v_areas         text[] := array(select upper(btrim(x)) from unnest(p_areas) as x);
  v_products      text[] := array(select upper(btrim(x)) from unnest(p_products) as x);
  v_exclude_codes text[] := array(select upper(btrim(x)) from unnest(p_exclude_codes) as x);
begin
  if cardinality(p_lines) > 0 and not coalesce('' = any(v_lines), false) then
    -- Line-scoped and no blank line asked for: read only those lines' rows, on the line index.
    return query
    select
      g.period,
      sum(g.q) as units,
      sum(case when g.is_direct
               then g.dv
               else g.eu * coalesce(p.factory_price, 0) end) as value
    from (
      select
        f.period,
        f.official_line,
        case when cardinality(p_distributors) = 0 then null else f.distributor_code end as distributor_code,
        case when cardinality(p_regions) = 0 then null else f.region_code end as region_code,
        case when cardinality(p_areas) = 0 then null else f.area_code end as area_code,
        f.product_code,
        f.is_direct,
        sum(f.total_qty) as q,
        sum(f.effective_units) as eu,
        sum(f.direct_value) as dv
      from public.source_of_sales_fact_rollup f
      where lower(btrim(f.official_line)) = any (v_lines)
        and (cardinality(p_periods) = 0 or f.period = any (p_periods))
      group by 1, 2, 3, 4, 5, 6, 7
      offset 0 -- keeps the per-group predicates below from being pushed back down onto every row
    ) g
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(g.product_code))
    where (
        cardinality(p_lines) = 0
        or lower(btrim(coalesce(g.official_line, ''))) = any (v_lines)
      )
      and (
        cardinality(p_distributors) = 0
        or upper(btrim(coalesce(g.distributor_code, ''))) = any (v_distributors)
      )
      and (
        cardinality(p_regions) = 0
        or upper(btrim(coalesce(g.region_code, ''))) = any (v_regions)
      )
      and (
        cardinality(p_areas) = 0
        or upper(btrim(coalesce(nullif(g.area_code, ''), 'DIRECT'))) = any (v_areas)
      )
      and (
        cardinality(p_products) = 0
        or upper(btrim(coalesce(g.product_code, ''))) = any (v_products)
      )
      and (
        cardinality(p_exclude_codes) = 0
        or upper(btrim(coalesce(g.product_code, ''))) <> all (v_exclude_codes)
      )
    group by g.period;
  else
    return query
    select
      g.period,
      sum(g.q) as units,
      sum(case when g.is_direct
               then g.dv
               else g.eu * coalesce(p.factory_price, 0) end) as value
    from (
      select
        f.period,
        case when cardinality(p_lines) = 0 then null else f.official_line end as official_line,
        case when cardinality(p_distributors) = 0 then null else f.distributor_code end as distributor_code,
        case when cardinality(p_regions) = 0 then null else f.region_code end as region_code,
        case when cardinality(p_areas) = 0 then null else f.area_code end as area_code,
        f.product_code,
        f.is_direct,
        sum(f.total_qty) as q,
        sum(f.effective_units) as eu,
        sum(f.direct_value) as dv
      from public.source_of_sales_fact_rollup f
      where (cardinality(p_periods) = 0 or f.period = any (p_periods))
      group by 1, 2, 3, 4, 5, 6, 7
      offset 0 -- keeps the per-group predicates below from being pushed back down onto every row
    ) g
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(g.product_code))
    where (
        cardinality(p_lines) = 0
        or lower(btrim(coalesce(g.official_line, ''))) = any (v_lines)
      )
      and (
        cardinality(p_distributors) = 0
        or upper(btrim(coalesce(g.distributor_code, ''))) = any (v_distributors)
      )
      and (
        cardinality(p_regions) = 0
        or upper(btrim(coalesce(g.region_code, ''))) = any (v_regions)
      )
      and (
        cardinality(p_areas) = 0
        or upper(btrim(coalesce(nullif(g.area_code, ''), 'DIRECT'))) = any (v_areas)
      )
      and (
        cardinality(p_products) = 0
        or upper(btrim(coalesce(g.product_code, ''))) = any (v_products)
      )
      and (
        cardinality(p_exclude_codes) = 0
        or upper(btrim(coalesce(g.product_code, ''))) <> all (v_exclude_codes)
      )
    group by g.period;
  end if;
end;
$function$;

-- ── phx_sos_distinct_distributors ────────────────────────────────────────────────────────────
-- Signature, defaults, return type, volatility, security, search_path and timeout are unchanged.
-- `codes` steps through sos_fact_rollup_distributor_line_region_idx one distinct code at a time;
-- each code then costs one index probe whose conditions are the old predicates, chosen by which
-- filters are on (a CASE, so every branch stays an index condition even in a generic plan).
CREATE OR REPLACE FUNCTION public.phx_sos_distinct_distributors(p_lines text[] DEFAULT '{}'::text[], p_regions text[] DEFAULT '{}'::text[])
 RETURNS TABLE(distributor_code text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '10s'
AS $function$
  with recursive codes(code) as (
    (
      select f.distributor_code
      from public.source_of_sales_fact_rollup f
      where f.distributor_code is not null
      order by f.distributor_code
      limit 1
    )
    union all
    select (
      select f.distributor_code
      from public.source_of_sales_fact_rollup f
      where f.distributor_code > c.code
      order by f.distributor_code
      limit 1
    )
    from codes c
    where c.code is not null
  ),
  wanted as (
    select array(select lower(btrim(x)) from unnest(p_lines) as x) as lines,
           array(select upper(btrim(x)) from unnest(p_regions) as x) as regions
  )
  select c.code
  from codes c
  cross join wanted w
  -- A NULL array matched nothing before (NULL OR false), so it still returns nothing.
  where c.code is not null
    and p_lines is not null
    and p_regions is not null
    and case
      when cardinality(p_lines) > 0 and cardinality(p_regions) > 0 then exists (
        select 1 from public.source_of_sales_fact_rollup f
        where f.distributor_code = c.code
          and lower(btrim(coalesce(f.official_line, ''))) = any (w.lines)
          and upper(btrim(coalesce(f.region_code, ''))) = any (w.regions))
      when cardinality(p_lines) > 0 then exists (
        select 1 from public.source_of_sales_fact_rollup f
        where f.distributor_code = c.code
          and lower(btrim(coalesce(f.official_line, ''))) = any (w.lines))
      when cardinality(p_regions) > 0 then exists (
        select 1 from public.source_of_sales_fact_rollup f
        where f.distributor_code = c.code
          and upper(btrim(coalesce(f.region_code, ''))) = any (w.regions))
      else true
    end
  union all
  -- The old DISTINCT also returned one NULL code when a matching row had none (0 such rows on
  -- production, 2026-09-17); kept so the two bodies agree on every table, not just today's.
  select null::text
  from wanted w
  where p_lines is not null
    and p_regions is not null
    and exists (
      select 1 from public.source_of_sales_fact_rollup f
      where f.distributor_code is null
        and (cardinality(p_lines) = 0 or lower(btrim(coalesce(f.official_line, ''))) = any (w.lines))
        and (cardinality(p_regions) = 0 or upper(btrim(coalesce(f.region_code, ''))) = any (w.regions)));
$function$;

-- ── Re-assert the SECURITY DEFINER grants ────────────────────────────────────────────────────
-- CREATE OR REPLACE keeps the existing ACL, so on production these change NOTHING (measured
-- 2026-09-17: trend `postgres, service_role`; distributors `postgres, service_role,
-- analytics_readonly`). They are here for REPLAY, where the default ACL would grant PUBLIC.
revoke execute on function public.phx_exec_sos_trend(text[], text[], text[], text[], text[], text[], text[]) from public, anon, authenticated;
grant  execute on function public.phx_exec_sos_trend(text[], text[], text[], text[], text[], text[], text[]) to service_role;

revoke execute on function public.phx_sos_distinct_distributors(text[], text[]) from public, anon, authenticated;
grant  execute on function public.phx_sos_distinct_distributors(text[], text[]) to service_role;
do $acl$
begin
  if exists (select 1 from pg_roles where rolname = 'analytics_readonly') then
    execute 'grant execute on function public.phx_sos_distinct_distributors(text[], text[]) to analytics_readonly';
  end if;
end
$acl$;

-- phx_exec_sos_trend asks for each product's period price ONCE per (product, period), not per row.
-- SPEED ONLY — the answer is unchanged, and that was proven before this was written.
--
-- WHY. `public.phx_factory_price(code, period)` is SECURITY DEFINER and carries a `SET search_path`;
-- Postgres inlines a SQL function with NEITHER of those, so every mention in a row-level expression
-- is a real invocation with two correlated subqueries of its own. Both branches of this function
-- call it once per row of the grouped set `g`, which is the whole fact rollup grouped by seven
-- columns — far more rows than there are distinct (product, period) pairs to resolve.
--
-- 🔴 DROPPING SECURITY DEFINER WOULD NOT HAVE DONE THIS. Measured on the sibling closing matrix on
-- 2026-10-23: the resolver's body written out inline — exactly what the planner substitutes when it
-- may inline a scalar SQL function — still showed `SubPlan 1` and `SubPlan 2` at one loop per row,
-- 1,193 ms against 2,278 ms, where hoisting gave 202 ms. Inlining leaves the correlated subqueries
-- where they are; only hoisting them out of the row loop works. The same conclusion was reached
-- independently on 2026-09-28 and is recorded in tests/factory-price-resolved-once.test.ts.
--
-- WHY THE TWO BODIES ARE EQUIVALENT:
--
--   1. THE KEY IS (product_code, period). `g.period` and `g.product_code` are exactly the two
--      arguments the live body passes, so resolving once per DISTINCT pair hands every row the
--      argument pair it passed before. `phx_factory_price` is STABLE, so one pair cannot resolve to
--      two different numbers inside one call.
--   2. THE LEFT JOIN CANNOT CHANGE MULTIPLICITY. `select distinct` makes `period_price` hold at
--      most one row per pair, so the join adds exactly one row per `g` row.
--   3. THE NULL BRANCHES AGREE. `period` is NOT NULL on `source_of_sales_fact_rollup` by column
--      constraint. A NULL product_code fails the equality join and falls to `coalesce(..., 0)` —
--      which is what the resolver itself returns for an unknown product.
--   4. `g` KEEPS ITS `offset 0`. It is there to stop the outer per-group predicates being pushed
--      back down onto every row, and it is still the first thing inside the CTE. Moving the
--      subquery into a CTE referenced twice also makes Postgres materialise it, so the grouped set
--      is built once and read twice rather than rescanned.
--   5. THE DIRECT BRANCH IS UNTOUCHED. `case when g.is_direct then g.dv …` still takes the stored
--      direct value and never prices it; only the non-direct arm reads the resolved price. Every
--      filter, every `v_*` normalisation and both branch conditions move across verbatim.
--   6. RESOLVING BEFORE THE OUTER FILTERS IS SAFE. `period_price` is built over all of `g`, so it
--      may hold pairs the outer `where` later discards. An unused row in a left-joined lookup
--      changes no output; it is at most a handful of extra resolutions (225 distinct pairs exist in
--      the whole table) against one per grouped row.
--
-- PROVEN IDENTICAL ON PRODUCTION, 2026-10-23, against the live function: both branches — the
-- line-scoped branch and the default branch — 20 rows out, compared as TEXT, `(row)::text` through
-- `EXCEPT ALL` in BOTH directions, which pins each numeric's scale as well as its value. 0 rows in
-- both directions. The hoisting rule itself was additionally proven over the whole relation: all
-- 295,418 rows of `source_of_sales_fact_rollup`, 225 distinct (product_code, period) keys, 0
-- mismatches — which covers the Saginko override (SA001, 111.15 through 2026-09 and 170.52 from
-- 2026-10) on every row carrying it, on both sides of the boundary.
--
-- A published month is never changed (owner, 2026-10-09), which is why the proof above is a text
-- comparison run BEFORE this file was written, not a sanity check run after.
--
-- ROLLBACK: re-apply supabase/migrations/20260928190019_phx_exec_sos_trend_reads_the_period_price.sql,
-- which holds the previous body. Nothing is dropped, renamed or written here, no row is touched,
-- and `create or replace` keeps the existing ACL. This replaces one read-only function body and is
-- neither destructive nor bulk.

begin;

create or replace function public.phx_exec_sos_trend(p_periods text[] default '{}'::text[], p_lines text[] default '{}'::text[], p_distributors text[] default '{}'::text[], p_regions text[] default '{}'::text[], p_areas text[] default '{}'::text[], p_products text[] default '{}'::text[], p_exclude_codes text[] default array['LA003'::text, 'LA004'::text, 'SS001'::text])
 returns table(period text, units numeric, value numeric)
 language plpgsql
 stable security definer
 set search_path to 'public'
 set statement_timeout to '45s'
as $function$
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
    with g as (
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
    ),
    period_price as (
      select d.product_code, d.period,
             public.phx_factory_price(d.product_code, d.period) as period_price
      from (select distinct g.product_code, g.period from g) d
    )
    select
      g.period,
      sum(g.q) as units,
      sum(case when g.is_direct
               then g.dv
               else g.eu * coalesce(pp.period_price, 0) end) as value
    from g
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(g.product_code))
    left join period_price pp
      on pp.product_code = g.product_code and pp.period = g.period
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
    with g as (
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
    ),
    period_price as (
      select d.product_code, d.period,
             public.phx_factory_price(d.product_code, d.period) as period_price
      from (select distinct g.product_code, g.period from g) d
    )
    select
      g.period,
      sum(g.q) as units,
      sum(case when g.is_direct
               then g.dv
               else g.eu * coalesce(pp.period_price, 0) end) as value
    from g
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(g.product_code))
    left join period_price pp
      on pp.product_code = g.product_code and pp.period = g.period
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

revoke execute on function public.phx_exec_sos_trend(text[], text[], text[], text[], text[], text[], text[]) from public, anon, authenticated;
grant execute on function public.phx_exec_sos_trend(text[], text[], text[], text[], text[], text[], text[]) to service_role;

commit;

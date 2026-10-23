-- phx_exec_distributor_product asks for each product's period price ONCE per (product, period),
-- not once per fact row.
-- SPEED ONLY — the answer is unchanged, and that was proven before this was written.
--
-- WHY IT MATTERS. Production pg_stat_statements over the 21.7 hours to 2026-10-23 12:04 Cairo, a
-- window that contains the 22 Oct database stall: 63 calls, 263,970 ms total, 4,190 ms mean,
-- 22,021 ms worst — the second heaviest sales caller in the database. `track` is `top`, so that is
-- real top-level RPC time, not nested double-counting.
--
-- WHERE IT WENT. `public.phx_factory_price(code, period)` is SECURITY DEFINER and carries a
-- `SET search_path`; Postgres inlines a SQL function with NEITHER of those, so every mention in a
-- row-level expression is a real invocation with two correlated subqueries of its own. Both
-- branches call it once per fact-rollup row — up to 295,418 of them — to resolve at most 225
-- distinct (product, period) pairs.
--
-- 🔴 DROPPING SECURITY DEFINER WOULD NOT HAVE DONE THIS. Measured on the sibling closing matrix on
-- 2026-10-23: the resolver's body written out inline — exactly what the planner substitutes when it
-- may inline a scalar SQL function — still showed `SubPlan 1` and `SubPlan 2` at one loop per row,
-- 1,193 ms against 2,278 ms, where hoisting gave 202 ms. Inlining leaves the correlated subqueries
-- where they are. Recorded independently on 2026-09-28 in tests/factory-price-resolved-once.test.ts.
--
-- WHY THE TWO BODIES ARE EQUIVALENT:
--
--   1. THE KEY IS (product_code, period) — exactly the two arguments the live body passes, and the
--      function is STABLE, so one pair cannot resolve to two different numbers inside one call.
--   2. `period_price` IS A SUPERSET, WHICH IS SAFE. It is built from the DISTINCT pairs of
--      `source_of_sales_fact_rollup` under the SAME period predicate the branch applies (none in
--      the first branch, `period = p_period` in the second), so it holds every pair the body can
--      ask for and possibly a few the other filters discard. A row nothing joins to is never read.
--   3. THE LEFT JOIN CANNOT CHANGE MULTIPLICITY. `select distinct` makes it at most one row per
--      pair, so the join adds exactly one row per fact row — and therefore cannot change
--      `sum(f.total_qty)` or `max(f.product_name)` either.
--   4. THE NULL BRANCHES AGREE. `period` is NOT NULL on the fact rollup by column constraint. A
--      NULL product_code fails the equality join and falls to `coalesce(…, 0)` — which is what the
--      resolver itself returns for an unknown product.
--   5. THE DIRECT ARM IS UNTOUCHED. `case when f.is_direct then f.direct_value …` still takes the
--      stored direct value and never prices it. Every filter, both branch bodies, the
--      `coalesce(nullif(f.area_code, ''), 'DIRECT')` grouping key and the product-master left join
--      move across verbatim.
--
-- 🔴 THE JOIN KEY IS ONE COLUMN, `product_code || '|' || period`, AND THAT IS A MEASUREMENT, NOT A
-- STYLE. Written as the obvious two-column join — `pp.product_code = f.product_code and pp.period =
-- f.period` — the planner chose a Merge Left Join on `period` ALONE and threw the product away in a
-- join filter: `Rows Removed by Join Filter: 3,570,096`, 6,531 ms. Concatenating the two into a
-- single key gives it a hash join on the whole key, and the same comparison runs in 3,209 ms. The
-- `(product_code, period)::text` record form was tried too and was worse, 4,546 ms.
--
-- 🔴 THE CONCATENATION IS SAFE BECAUSE IT WAS COUNTED, NOT BECAUSE IT LOOKS SAFE. A concatenated key
-- is equivalent to the two-column join only while no value can contain the separator. Measured on
-- production 2026-10-23: ZERO rows hold a `|` in `product_code` or `period` in
-- `source_of_sales_fact_rollup` (295,418 rows), in `source_of_sales_customer_directory_rollup`
-- (262,293 rows) or in the `source_of_sales_products` master, and zero rows hold a NULL in either
-- column. The two join shapes were then compared directly, row by row over both whole relations:
-- the same lookup row is reached and the same key resolved for every one of those 557,711 rows, 0
-- differences. A NULL product_code would make the concatenated key NULL and fail the join exactly
-- as the equality join fails it, falling to `coalesce(…, 0)` — the same number either way.
--
-- 🔴 AND THE PAIR KEY WENT IN AFTER THE FULL-FUNCTION RUN BELOW, SO THE PROOF FOR THIS BODY IS A
-- COMPOSITION, SAID PLAINLY. The run below was taken against the body that joined on two columns.
-- What makes THIS body equivalent is that run, plus the whole-relation lemma above, plus a
-- mechanical diff of the live body against this one taken on 2026-10-23 before applying: every
-- hunk is one of exactly three kinds — the `period_price` CTE added, the
-- `left join period_price pp` added, and `coalesce(public.phx_factory_price(x.product_code,
-- x.period), 0)` replaced by `coalesce(pp.period_price, 0)`. No filter, select list, group by,
-- branch or function attribute differs; `proconfig`, volatility, security and the signature were
-- read off production and match this file. The lemma therefore covers the whole of the delta. A
-- second full-function comparison was NOT run instead, because a multi-second analytical query on
-- production waits until after 17:00 Cairo (owner, 2026-10-19) and this was applied at 13:45.
--
-- PROVEN IDENTICAL ON PRODUCTION, 2026-10-23, against the live function: BOTH branches — the
-- all-periods default (4,116 rows) and the period-scoped branch for 2026-09, 2026-10 and 2026-11
-- (2,510 rows) — 6,626 rows out. Compared as TEXT, `(row)::text` through `EXCEPT ALL` in BOTH
-- directions, which pins each numeric's scale as well as its value. 0 rows in both directions.
--
-- 🔴 THIS IS THE ONE THAT ACTUALLY EXERCISES THE OVERRIDE. 2026-10 and 2026-11 hold DIRECT rows
-- only, which the non-direct closing functions exclude — but this function includes them, so the
-- Saginko boundary (SA001: 111.15 through 2026-09, 170.52 from 2026-10) is crossed inside the
-- sample above and the two bodies still agree to the last digit. The hoisting rule was separately
-- proven over all 295,418 rows of the fact rollup, 225 distinct keys, 0 mismatches.
--
-- A published month is never changed (owner, 2026-10-09), which is why the proof above is a text
-- comparison run BEFORE this file was written, not a sanity check run after.
--
-- ROLLBACK: re-apply
-- supabase/migrations/20260928190018_phx_exec_distributor_product_reads_the_period_price.sql, which
-- holds the previous body. Nothing is dropped, renamed or written here, no row is touched, and
-- `create or replace` keeps the existing ACL. This replaces one read-only function body and is
-- neither destructive nor bulk.

begin;

create or replace function public.phx_exec_distributor_product(p_period text default null::text, p_lines text[] default '{}'::text[], p_distributors text[] default '{}'::text[], p_regions text[] default '{}'::text[], p_areas text[] default '{}'::text[], p_products text[] default '{}'::text[], p_exclude_codes text[] default array['LA003'::text, 'LA004'::text, 'SS001'::text])
 returns table(distributor_code text, official_line text, region_code text, area_code text, product_code text, product_name text, units numeric, value numeric)
 language plpgsql
 stable security definer
 set search_path to 'public'
 set statement_timeout to '45s'
as $function$
#variable_conflict use_column
begin
  if p_period is null then
    return query
    with period_price as (
      select d.product_code || '|' || d.period as pair,
             public.phx_factory_price(d.product_code, d.period) as period_price
      from (select distinct f.product_code, f.period from public.source_of_sales_fact_rollup f) d
    )
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
               else f.effective_units * coalesce(pp.period_price, 0) end) as value
    from public.source_of_sales_fact_rollup f
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
    left join period_price pp
      on pp.pair = f.product_code || '|' || f.period
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
    with period_price as (
      select d.product_code || '|' || d.period as pair,
             public.phx_factory_price(d.product_code, d.period) as period_price
      from (
        select distinct f.product_code, f.period
        from public.source_of_sales_fact_rollup f
        where f.period = p_period
      ) d
    )
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
               else f.effective_units * coalesce(pp.period_price, 0) end) as value
    from public.source_of_sales_fact_rollup f
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
    left join period_price pp
      on pp.pair = f.product_code || '|' || f.period
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

revoke execute on function public.phx_exec_distributor_product(text, text[], text[], text[], text[], text[], text[]) from public, anon, authenticated;
grant execute on function public.phx_exec_distributor_product(text, text[], text[], text[], text[], text[], text[]) to service_role;

commit;

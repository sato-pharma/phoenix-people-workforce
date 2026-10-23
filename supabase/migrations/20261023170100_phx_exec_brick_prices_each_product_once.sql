-- phx_exec_brick asks for each product's period price ONCE per (product, period), not once per row.
-- SPEED ONLY — the answer is unchanged, and that was proven before this was written.
--
-- WHY THIS ONE MATTERS MOST. Read from production's own pg_stat_statements over the 21.7 hours to
-- 2026-10-23 12:04 Cairo — a window that contains the 22 Oct database stall — the three executive
-- reads were the heaviest sales callers in the database:
--
--     phx_exec_customers              35 calls   305,933 ms total   8,741 ms mean   24,113 ms max
--     phx_exec_distributor_product    63 calls   263,970 ms total   4,190 ms mean   22,021 ms max
--     phx_exec_brick                  35 calls   259,659 ms total   7,419 ms mean   22,010 ms max
--
-- 13.8 minutes of database time across 133 calls. `pg_stat_statements.track` is `top`, so these are
-- real top-level RPC costs and not nested double-counting.
--
-- WHERE IT WENT. `public.phx_factory_price(code, period)` is SECURITY DEFINER and carries a
-- `SET search_path`; Postgres inlines a SQL function with NEITHER of those, so every mention in a
-- row-level expression is a real invocation with its own two correlated subqueries. With no period
-- argument this function scans the whole fact rollup: 185,282 rows to resolve 193 distinct
-- (product, period) pairs.
--
-- MEASURED ON PRODUCTION 2026-10-23, the default all-periods call:
--
--     live function, resolver called per row     7,419 ms (production mean, 35 calls)
--     this body, resolved once per pair          3,212 ms   8,795 shared buffers
--
-- 🔴 DROPPING SECURITY DEFINER WOULD NOT HAVE DONE THIS. Measured on the sibling closing matrix the
-- same day: the resolver's body written out inline — exactly what the planner substitutes when it
-- is allowed to inline a scalar SQL function — still showed `SubPlan 1` and `SubPlan 2` at one loop
-- per row in the plan, 1,193 ms against 2,278 ms, where hoisting gave 202 ms. Inlining does not turn
-- the lookup into a join. The same conclusion was reached on 2026-09-28 and is recorded in
-- tests/factory-price-resolved-once.test.ts.
--
-- WHY THE TWO BODIES ARE EQUIVALENT:
--
--   1. THE KEY IS (product_code, period), NOT product_code ALONE. This function's `p_period` is
--      optional, so unlike the closing matrix the resolver's second argument genuinely varies row
--      to row — it is `f.period`. Resolving once per DISTINCT (product_code, period) therefore
--      gives every row exactly the argument pair it passed before.
--   2. THE LEFT JOIN CANNOT CHANGE MULTIPLICITY. `select distinct` makes `period_price` hold at most
--      one row per pair, so the join adds exactly one row per base row.
--   3. THE NULL BRANCHES AGREE. `period` is NOT NULL on `source_of_sales_fact_rollup` by column
--      constraint, so the period half of the join key can never be NULL. A NULL product_code would
--      fail the equality join and fall to `coalesce(..., 0)` — which is what the resolver itself
--      returns for an unknown product — and production holds 0 such rows anyway.
--   4. THE PRODUCT-MASTER LEFT JOIN AND EVERY FILTER MOVE UNCHANGED into `base`. The master join has
--      had no consumer since 2026-09-28 but a left join fans out on duplicates, so it is kept here
--      rather than removed in the same migration.
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
-- PROVEN IDENTICAL ON PRODUCTION, 2026-10-23, against the live function: the all-periods default
-- call (3,757 rows) and each of the 11 periods the fact rollup holds, separately (18,311 rows) —
-- 22,068 rows in all. Compared as TEXT, `(row)::text` through `EXCEPT ALL` in BOTH directions,
-- which pins each numeric's scale as well as its value. Every call returned 0 rows in both
-- directions.
--
-- The hoisting rule itself was additionally proven over the WHOLE relation: for all 295,418 rows of
-- `source_of_sales_fact_rollup`, `coalesce(phx_factory_price(f.product_code, f.period), 0)::text`
-- equals the hoisted CTE's value, 0 mismatches, over 225 distinct (product_code, period) keys. That
-- covers the Saginko override (SA001, 111.15 through 2026-09 and 170.52 from 2026-10) on every row
-- that carries it, in both directions across the boundary.
--
-- ROLLBACK: re-apply supabase/migrations/20260928190016_phx_exec_brick_reads_the_period_price.sql,
-- which holds the previous body. Nothing is dropped, renamed or written here, no row is touched,
-- and `create or replace` keeps the existing ACL. This replaces one read-only function body and is
-- neither destructive nor bulk.

begin;

create or replace function public.phx_exec_brick(p_period text default null::text, p_exclude_codes text[] default array['LA003'::text, 'LA004'::text, 'SS001'::text], p_lines text[] default null::text[], p_products text[] default null::text[], p_regions text[] default null::text[], p_areas text[] default null::text[])
 returns table(distributor_code text, region_code text, area_code text, brick_id text, units numeric, value numeric)
 language plpgsql
 stable security definer
 set search_path to 'public'
 set statement_timeout to '45s'
as $function$
#variable_conflict use_column
begin
  return query
  with period_price as (
    select d.product_code || '|' || d.period as pair,
           public.phx_factory_price(d.product_code, d.period) as period_price
    from (
      select distinct f.product_code, f.period
      from public.source_of_sales_fact_rollup f
      where (p_period is null or f.period = p_period)
    ) d
  )
  select
    f.distributor_code,
    f.region_code,
    f.area_code,
    f.brick_id,
    sum(f.total_qty)                                      as units,
    sum(f.effective_units * coalesce(pp.period_price, 0)) as value
  from public.source_of_sales_fact_rollup f
  join public.source_of_sales_import_batches b
    on b.id = f.batch_id and b.status = 'validated'
  left join public.source_of_sales_products p
    on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
  left join period_price pp
    on pp.pair = f.product_code || '|' || f.period
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

revoke execute on function public.phx_exec_brick(text, text[], text[], text[], text[], text[]) from public, anon, authenticated;
grant execute on function public.phx_exec_brick(text, text[], text[], text[], text[], text[]) to service_role;

commit;

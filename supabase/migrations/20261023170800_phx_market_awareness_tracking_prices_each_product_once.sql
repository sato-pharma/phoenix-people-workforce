-- phx_market_awareness_tracking asks for each product's period price ONCE per (product, period),
-- not once per fact row.
-- SPEED ONLY — the answer is unchanged, and that was proven before this was written.
--
-- WHY. `public.phx_factory_price(code, period)` is SECURITY DEFINER and carries a `SET search_path`;
-- Postgres inlines a SQL function with NEITHER of those, so every mention in a row-level expression
-- is a real invocation with two correlated subqueries of its own. The `priced` CTE prices every row
-- of the window, and `scoped` then reads `priced` THREE times (brick, area, area_bricked) — so the
-- work the resolver does is the one thing in this function worth doing once.
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
--      `source_of_sales_fact_rollup` under the SAME window predicate
--      (`period between p_from_period and p_to_period`), so it holds every pair `priced` can ask
--      for and possibly a few the line/product/direct filters discard. A row nothing joins to is
--      never read.
--   3. THE LEFT JOIN CANNOT CHANGE MULTIPLICITY. `select distinct` makes it at most one row per
--      pair, so the join adds exactly one row — which is why the three `scoped` arms and every
--      `sum(...) filter (...)` are untouched.
--   4. THE NULL BRANCHES AGREE. `period` is NOT NULL on the fact rollup by column constraint. A
--      NULL product_code fails the equality join and falls to `coalesce(…, 0)` — which is what the
--      resolver itself returns for an unknown product.
--   5. THE DIRECT SIDE IS UNTOUCHED. `direct_value` is summed straight from the row and never
--      priced; only `indirect_value` reads the resolved price. The line map, the product filter,
--      the `not (f.is_direct and f.period = '2026-07')` carve-out and all three scope arms move
--      across verbatim.
--
-- PROVEN IDENTICAL ON PRODUCTION, 2026-10-23, against the live function: three official lines
-- against two areas over the 2026-01 → 2026-12 window — 6 argument sets, 108 rows out, compared as
-- TEXT, `(row)::text` through `EXCEPT ALL` in BOTH directions, which pins each numeric's scale as
-- well as its value. 0 rows in both directions. The hoisting rule itself was proven over the WHOLE
-- relation: all 295,418 rows of `source_of_sales_fact_rollup`, 225 distinct (product_code, period)
-- keys, 0 mismatches — which covers the Saginko override (SA001, 111.15 through 2026-09, 170.52
-- from 2026-10) on every row carrying it, on both sides of the boundary.
--
-- A published month is never changed (owner, 2026-10-09), which is why the proof above is a text
-- comparison run BEFORE this file was written, not a sanity check run after.
--
-- ROLLBACK: re-apply
-- supabase/migrations/20260928190025_phx_market_awareness_tracking_reads_the_period_price.sql,
-- which holds the previous body. Nothing is dropped, renamed or written here, no row is touched,
-- and `create or replace` keeps the existing ACL. This replaces one read-only function body and is
-- neither destructive nor bulk.

begin;

create or replace function public.phx_market_awareness_tracking(p_line_code text, p_from_period text, p_to_period text, p_area_code text, p_brick_ids text[], p_product_codes text[])
 returns table(period text, scope text, indirect_units numeric, indirect_value numeric, direct_units numeric, direct_value numeric)
 language sql
 stable security definer
 set search_path to 'public'
 set statement_timeout to '45s'
as $function$
  with period_price as (
    select d.product_code, d.period,
           public.phx_factory_price(d.product_code, d.period) as period_price
    from (
      select distinct f.product_code, f.period
      from public.source_of_sales_fact_rollup f
      where f.period between p_from_period and p_to_period
    ) d
  ),
  rows_in_window as (
    select
      f.period,
      f.area_code,
      f.brick_id,
      f.is_direct,
      f.total_qty,
      f.effective_units,
      f.direct_value,
      f.product_code
    from public.source_of_sales_fact_rollup f
    join public.source_of_sales_import_batches b
      on b.id = f.batch_id and b.status = 'validated'
    where f.period between p_from_period and p_to_period
      and lower(btrim(f.official_line)) in (
        select lower(btrim(m.official_line))
        from au.sos_official_line_map m
        where lower(btrim(m.line_code)) = lower(btrim(p_line_code))
      )
      and upper(btrim(f.product_code)) = any (
        select upper(btrim(code)) from unnest(p_product_codes) as code
      )
      and (
        not f.is_direct
        or upper(btrim(coalesce(f.product_code, ''))) not in ('LA003', 'LA004', 'SS001')
      )
      and not (f.is_direct and f.period = '2026-07')
  ),
  priced as (
    select
      r.*,
      r.effective_units * coalesce(pp.period_price, 0) as indirect_value
    from rows_in_window r
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(r.product_code))
    left join period_price pp
      on pp.product_code = r.product_code and pp.period = r.period
  ),
  scoped as (
    select 'brick'::text as scope, * from priced
     where brick_id = any (p_brick_ids)
    union all
    select 'area'::text, * from priced
     where btrim(area_code) = btrim(p_area_code)
    union all
    select 'area_bricked'::text, * from priced
     where btrim(area_code) = btrim(p_area_code)
       and brick_id is not null
       and btrim(brick_id) <> ''
  )
  select
    s.period,
    s.scope,
    coalesce(sum(s.total_qty)      filter (where not s.is_direct), 0) as indirect_units,
    coalesce(sum(s.indirect_value) filter (where not s.is_direct), 0) as indirect_value,
    coalesce(sum(s.total_qty)      filter (where s.is_direct), 0)     as direct_units,
    coalesce(sum(s.direct_value)   filter (where s.is_direct), 0)     as direct_value
  from scoped s
  group by s.period, s.scope;
$function$;

revoke execute on function public.phx_market_awareness_tracking(text, text, text, text, text[], text[]) from public, anon, authenticated;
grant execute on function public.phx_market_awareness_tracking(text, text, text, text, text[], text[]) to service_role;

commit;

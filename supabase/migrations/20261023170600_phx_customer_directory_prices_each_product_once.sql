-- phx_customer_directory asks for each product's period price ONCE per (product, period), not once
-- per customer-directory row.
-- SPEED ONLY — the answer is unchanged, and that was proven before this was written.
--
-- WHY. `public.phx_factory_price(code, period)` is SECURITY DEFINER and carries a `SET search_path`;
-- Postgres inlines a SQL function with NEITHER of those, so every mention in a row-level expression
-- is a real invocation with two correlated subqueries of its own. This function's `filtered` CTE
-- walks `source_of_sales_customer_directory_rollup` — 262,293 rows — and prices each one, to
-- resolve at most 223 distinct (product, period) pairs.
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
--   2. `period_price` IS A SUPERSET, WHICH IS SAFE. It is built from the DISTINCT pairs of the same
--      table under the SAME two period predicates (`>= p_from_period`, `<= p_to_period`), so it
--      holds every pair `filtered` can ask for and possibly a few the region/area/brick/
--      distributor/exclude filters discard. A row nothing joins to is never read.
--   3. THE LEFT JOIN CANNOT CHANGE MULTIPLICITY. `select distinct` makes it at most one row per
--      pair, so the join adds exactly one row — which is why `sum(total_qty)` and the
--      `distinct on (client_code, distributor_code) … order by latest_row_created_at desc` pick in
--      `latest` are untouched.
--   4. THE NULL BRANCHES AGREE. `period` is NOT NULL on the rollup by column constraint. A NULL
--      product_code fails the equality join and falls to `coalesce(…, 0)` — which is what the
--      resolver itself returns for an unknown product.
--   5. EVERYTHING ELSE IS THE OLD BODY VERBATIM, `filtered as materialized` included, down to the
--      product-master join written `upper(btrim(p.product_code)) = c.product_code` (no normalisation
--      on the right-hand side) and the three-way `coalesce` that fills the address from
--      `source_of_sales_customer_map`.
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
-- PROVEN IDENTICAL ON PRODUCTION, 2026-10-23, against the live function: the 2026-08 → 2026-09
-- window — 20,479 rows out. Compared as TEXT, `(row)::text` through `EXCEPT ALL` in BOTH
-- directions, which pins each numeric's scale as well as its value. 0 rows in both directions.
-- The hoisting rule itself was proven over the WHOLE relation: all 262,293 rows of
-- `source_of_sales_customer_directory_rollup`, 223 distinct (product_code, period) keys, 0
-- mismatches — which covers the Saginko override (SA001, 111.15 through 2026-09, 170.52 from
-- 2026-10) on every row carrying it, on both sides of the boundary.
--
-- A published month is never changed (owner, 2026-10-09), which is why the proof above is a text
-- comparison run BEFORE this file was written, not a sanity check run after.
--
-- ROLLBACK: re-apply
-- supabase/migrations/20260928190020_phx_customer_directory_reads_the_period_price.sql, which holds
-- the previous body. Nothing is dropped, renamed or written here, no row is touched, and
-- `create or replace` keeps the existing ACL. This replaces one read-only function body and is
-- neither destructive nor bulk.

begin;

create or replace function public.phx_customer_directory(p_region_codes text[] default null::text[], p_area_codes text[] default null::text[], p_brick_codes text[] default null::text[], p_distributor_codes text[] default null::text[], p_from_period text default null::text, p_to_period text default null::text, p_exclude_codes text[] default array['LA003'::text, 'LA004'::text, 'SS001'::text])
 returns table(client_code text, client_name text, client_address text, distributor_code text, brick_id text, area_code text, region_code text, total_units numeric, total_value numeric)
 language sql
 stable security definer
 set search_path to 'public'
 set statement_timeout to '45s'
 set work_mem to '128MB'
as $function$
  with period_price as (
    select d.product_code || '|' || d.period as pair,
           public.phx_factory_price(d.product_code, d.period) as period_price
    from (
      select distinct c.product_code, c.period
      from public.source_of_sales_customer_directory_rollup c
      where (p_from_period is null or c.period >= p_from_period)
        and (p_to_period is null or c.period <= p_to_period)
    ) d
  ),
  filtered as materialized (
    select
      c.client_code,
      c.client_name,
      c.client_address,
      c.distributor_code,
      c.brick_id,
      c.area_code,
      c.region_code,
      c.latest_row_created_at,
      c.total_qty,
      c.effective_units * coalesce(pp.period_price, 0) as line_value
    from public.source_of_sales_customer_directory_rollup c
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = c.product_code
    left join period_price pp
      on pp.pair = c.product_code || '|' || c.period
    where (p_distributor_codes is null or cardinality(p_distributor_codes) = 0 or c.distributor_code = any(p_distributor_codes))
      and (p_region_codes is null or cardinality(p_region_codes) = 0 or c.region_code = any(p_region_codes))
      and (p_area_codes is null or cardinality(p_area_codes) = 0 or c.area_code = any(p_area_codes))
      and (p_brick_codes is null or cardinality(p_brick_codes) = 0 or c.brick_id = any(p_brick_codes))
      and (p_from_period is null or c.period >= p_from_period)
      and (p_to_period is null or c.period <= p_to_period)
      and upper(btrim(coalesce(c.product_code, ''))) <> all (
        select upper(btrim(x)) from unnest(coalesce(p_exclude_codes, '{}'::text[])) as x
      )
  ),
  latest as (
    select distinct on (client_code, distributor_code)
      client_code,
      distributor_code,
      client_name,
      client_address,
      brick_id,
      area_code,
      region_code
    from filtered
    order by client_code, distributor_code, latest_row_created_at desc
  ),
  agg as (
    select
      client_code,
      distributor_code,
      sum(total_qty) as total_units,
      sum(line_value) as total_value
    from filtered
    group by client_code, distributor_code
  )
  select
    a.client_code,
    l.client_name,
    coalesce(
      nullif(btrim(l.client_address), ''),
      nullif(btrim(m.address), ''),
      ''
    ) as client_address,
    a.distributor_code,
    l.brick_id,
    l.area_code,
    l.region_code,
    a.total_units,
    a.total_value
  from agg a
  join latest l using (client_code, distributor_code)
  left join public.source_of_sales_customer_map m
    on m.distributor_code = a.distributor_code
   and m.customer_code = a.client_code
   and m.active;
$function$;

revoke execute on function public.phx_customer_directory(text[], text[], text[], text[], text, text, text[]) from public, anon, authenticated;
grant execute on function public.phx_customer_directory(text[], text[], text[], text[], text, text, text[]) to service_role;

commit;

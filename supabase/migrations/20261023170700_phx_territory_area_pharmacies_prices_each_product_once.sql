-- phx_territory_area_pharmacies asks for each product's period price ONCE per (product, period),
-- not once per customer-directory row.
-- SPEED ONLY — the answer is unchanged, and that was proven before this was written.
--
-- WHY. `public.phx_factory_price(code, period)` is SECURITY DEFINER and carries a `SET search_path`;
-- Postgres inlines a SQL function with NEITHER of those, so every mention in a row-level expression
-- is a real invocation with two correlated subqueries of its own. This function's `filtered` CTE
-- prices one row at a time, and it carries a 30-second `statement_timeout` — the tightest of the
-- sales reads — so the per-row cost is what decides whether a wide area selection answers at all.
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
--      🔴 Note the resolver takes `r.product_code` RAW, not the `coalesce(nullif(btrim(…)), '')`
--      the output column uses, so the join is on the raw column too.
--   2. `period_price` IS A SUPERSET, WHICH IS SAFE. It is built from the DISTINCT pairs of the same
--      table under the SAME period predicate (`period = any (p_periods)`), so it holds every pair
--      `filtered` can ask for and possibly a few the area/line/exclude filters discard. A row
--      nothing joins to is never read.
--   3. THE LEFT JOIN CANNOT CHANGE MULTIPLICITY. `select distinct` makes it at most one row per
--      pair, so the join adds exactly one row — which is why `sum(row_units)`, the
--      `distinct on (client_code) … order by latest_row_created_at desc` name pick and the two
--      `sum(…) over ()` scope totals are all untouched.
--   4. THE NULL BRANCHES AGREE. `period` is NOT NULL on the rollup by column constraint. A NULL
--      product_code fails the equality join and falls to `coalesce(…, 0)` — which is what the
--      resolver itself returns for an unknown product.
--   5. THE DIRECT ARM IS UNTOUCHED. `case when r.is_direct then coalesce(r.direct_value, 0) …`
--      still takes the stored direct value and never prices it, and the priced arm still multiplies
--      `r.total_qty` (not `effective_units`) — this function's own convention, left exactly as it
--      was. Every filter and both downstream CTEs move across verbatim.
--
-- PROVEN IDENTICAL ON PRODUCTION, 2026-10-23, against the live function: area AB5 across every
-- period in the rollup — 6,746 rows out. Compared as TEXT, `(row)::text` through `EXCEPT ALL` in
-- BOTH directions, which pins each numeric's scale as well as its value. 0 rows in both directions.
-- The hoisting rule itself was proven over the WHOLE relation: all 262,293 rows of
-- `source_of_sales_customer_directory_rollup`, 223 distinct (product_code, period) keys, 0
-- mismatches — which covers the Saginko override (SA001, 111.15 through 2026-09, 170.52 from
-- 2026-10) on every row carrying it, on both sides of the boundary.
--
-- A published month is never changed (owner, 2026-10-09), which is why the proof above is a text
-- comparison run BEFORE this file was written, not a sanity check run after.
--
-- ROLLBACK: re-apply
-- supabase/migrations/20261002191500_territory_area_pharmacies_reads_total_qty.sql, which holds the
-- previous body. Nothing is dropped, renamed or written here, no row is touched, and
-- `create or replace` keeps the existing ACL. This replaces one read-only function body and is
-- neither destructive nor bulk.

begin;

create or replace function public.phx_territory_area_pharmacies(p_area_codes text[], p_periods text[], p_lines text[])
 returns table(brick_id text, client_code text, client_name text, official_line text, product_code text, product_name text, period text, units numeric, value numeric, scope_total_units numeric, scope_total_value numeric)
 language plpgsql
 stable security definer
 set search_path to 'public'
 set statement_timeout to '30s'
as $function$
#variable_conflict use_column
begin
  return query
  with period_price as (
    select d.product_code, d.period,
           public.phx_factory_price(d.product_code, d.period) as period_price
    from (
      select distinct r.product_code, r.period
      from public.source_of_sales_customer_directory_rollup r
      where r.period = any (p_periods)
    ) d
  ),
  filtered as (
    select
      coalesce(nullif(btrim(r.brick_id), ''), '(unmapped)') as brick_id,
      r.client_code,
      r.client_name,
      coalesce(nullif(btrim(r.official_line), ''), 'Unknown') as official_line,
      coalesce(nullif(btrim(r.product_code), ''), '') as product_code,
      coalesce(nullif(btrim(p.product_name), ''), 'Unknown product') as product_name,
      r.period,
      r.latest_row_created_at,
      r.total_qty as row_units,
      case when r.is_direct then coalesce(r.direct_value, 0)
           else r.total_qty * coalesce(pp.period_price, 0) end as row_value
    from public.source_of_sales_customer_directory_rollup r
    join public.source_of_sales_import_batches b
      on b.id = r.batch_id and b.status = 'validated'
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(r.product_code))
    left join period_price pp
      on pp.product_code = r.product_code and pp.period = r.period
    where upper(btrim(coalesce(r.area_code, ''))) in (
        select upper(btrim(x)) from unnest(p_area_codes) as x
      )
      and r.period = any (p_periods)
      and r.client_code is not null
      and (
        cardinality(p_lines) = 0
        or lower(btrim(coalesce(r.official_line, ''))) in (
          select lower(btrim(x)) from unnest(p_lines) as x
        )
      )
      and upper(btrim(coalesce(r.product_code, ''))) not in ('LA003', 'LA004', 'SS001')
  ),
  latest_name as (
    select distinct on (client_code) client_code, client_name
    from filtered
    where client_name is not null
    order by client_code, latest_row_created_at desc
  ),
  agg as (
    select brick_id, client_code, official_line, product_code, product_name, period,
           sum(row_units) as units, sum(row_value) as value
    from filtered
    group by brick_id, client_code, official_line, product_code, product_name, period
  )
  select
    a.brick_id,
    a.client_code,
    coalesce(ln.client_name, 'Unknown'),
    a.official_line,
    a.product_code,
    a.product_name,
    a.period,
    a.units,
    a.value,
    sum(a.units) over (),
    sum(a.value) over ()
  from agg a
  left join latest_name ln using (client_code);
end;
$function$;

revoke execute on function public.phx_territory_area_pharmacies(text[], text[], text[]) from public, anon, authenticated;
grant execute on function public.phx_territory_area_pharmacies(text[], text[], text[]) to service_role;

commit;

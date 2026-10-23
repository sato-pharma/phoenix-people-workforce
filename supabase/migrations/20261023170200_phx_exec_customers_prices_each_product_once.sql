-- phx_exec_customers asks for each product's period price ONCE per (product, period), not per row.
-- SPEED ONLY — the answer is unchanged, and that was proven before this was written.
--
-- THE HEAVIEST SALES CALLER IN THE DATABASE. Production pg_stat_statements over the 21.7 hours to
-- 2026-10-23 12:04 Cairo, a window that contains the 22 Oct stall: 35 calls, 305,933 ms total,
-- 8,741 ms mean, 24,113 ms worst. `track` is `top`, so that is real top-level RPC time.
--
-- WHERE IT WENT. `public.phx_factory_price(code, period)` is SECURITY DEFINER and carries a
-- `SET search_path`; Postgres inlines a SQL function with NEITHER of those, so every mention in a
-- row-level expression is a real invocation with two correlated subqueries of its own. This
-- function calls it in TWO places — once per customer-directory rollup row and once per Office
-- fact row — and the default all-periods call walks 262,293 directory rows to resolve 193 distinct
-- (product, period) pairs.
--
-- 🔴 DROPPING SECURITY DEFINER WOULD NOT HAVE DONE THIS. Measured on the sibling closing matrix the
-- same day: the resolver's body written out inline — exactly what the planner substitutes when it
-- may inline a scalar SQL function — still showed `SubPlan 1` and `SubPlan 2` at one loop per row,
-- 1,193 ms against 2,278 ms, where hoisting gave 202 ms. Inlining leaves the correlated subqueries
-- where they are; only hoisting them out of the row loop works. Recorded independently on
-- 2026-09-28 in tests/factory-price-resolved-once.test.ts.
--
-- WHY THE TWO BODIES ARE EQUIVALENT:
--
--   1. ONE LOOKUP SERVES BOTH CALL SITES. Both pass the row's own (product_code, period) and
--      `phx_factory_price` is STABLE, so one pair cannot resolve to two different numbers inside
--      one call. `period_price` is built from the DISTINCT pairs of both source tables under the
--      SAME period predicate the body applies, `union`-ed — a SUPERSET of the pairs either site
--      can ask for. A superset is safe in a left-joined lookup: a row nothing joins to is never
--      read, and it costs at most a handful of extra resolutions (the whole database holds 225
--      distinct pairs) against one per source row.
--   2. THE LEFT JOIN CANNOT CHANGE MULTIPLICITY. `select distinct` plus `union` makes
--      `period_price` hold at most one row per pair, so each join adds exactly one row.
--   3. THE NULL BRANCHES AGREE. `period` is NOT NULL on both source tables by column constraint. A
--      NULL product_code fails the equality join and falls to `coalesce(…, 0)` — which is what the
--      resolver itself returns for an unknown product.
--   4. EVERYTHING ELSE IS BYTE-FOR-BYTE THE OLD BODY. `filtered`, `latest`, `agg` and `office` keep
--      their exact text apart from the added join and the swapped expression, so the `distinct on
--      (…) order by … latest_row_created_at desc` pick, the `having sum(f.total_qty) is not null`
--      guard and the `union all` are untouched. The `case when r.is_direct then
--      coalesce(r.direct_value, 0)` arm still never prices a direct row. The product-master left
--      joins stay: they lost their consumer on 2026-09-28, but a left join fans out on duplicates,
--      so removing them is a separate change.
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
-- PROVEN IDENTICAL ON PRODUCTION, 2026-10-23, against the live function: the all-periods default
-- (46,984 rows) and the '2026-09' call (13,100 rows) — 60,084 rows out. Compared as TEXT,
-- `(row)::text` through `EXCEPT ALL` in BOTH directions, which pins each numeric's scale as well as
-- its value. 0 rows both ways, both calls. The hoisting rule was additionally proven over the whole
-- relation: all 262,293 rows of `source_of_sales_customer_directory_rollup`, 223 distinct keys, 0
-- mismatches — and separately over all 295,418 rows of `source_of_sales_fact_rollup`, 225 keys, 0
-- mismatches. That covers the Saginko override (SA001, 111.15 through 2026-09 and 170.52 from
-- 2026-10) on every row carrying it, on both sides of the boundary.
--
-- A published month is never changed (owner, 2026-10-09), which is why the proof above is a text
-- comparison run BEFORE this file was written, not a sanity check run after.
--
-- ROLLBACK: re-apply supabase/migrations/20260928190017_phx_exec_customers_reads_the_period_price.sql,
-- which holds the previous body. Nothing is dropped, renamed or written here, no row is touched,
-- and `create or replace` keeps the existing ACL. This replaces one read-only function body and is
-- neither destructive nor bulk.

begin;

create or replace function public.phx_exec_customers(p_period text default null::text, p_exclude_codes text[] default array['LA003'::text, 'LA004'::text, 'SS001'::text], p_lines text[] default null::text[], p_products text[] default null::text[], p_regions text[] default null::text[], p_areas text[] default null::text[])
 returns table(client_code text, client_name text, distributor_code text, region_code text, area_code text, brick_id text, units numeric, value numeric)
 language plpgsql
 stable security definer
 set search_path to 'public'
 set statement_timeout to '45s'
 set work_mem to '96MB'
as $function$
#variable_conflict use_column
begin
  return query
  with period_price as (
    select d.product_code || '|' || d.period as pair,
           public.phx_factory_price(d.product_code, d.period) as period_price
    from (
      select distinct r.product_code, r.period
      from public.source_of_sales_customer_directory_rollup r
      where (p_period is null or r.period = p_period)
      union
      select distinct f.product_code, f.period
      from public.source_of_sales_fact_rollup f
      where (p_period is null or f.period = p_period)
    ) d
  ),
  filtered as (
    select
      r.client_code, r.client_name, r.distributor_code, r.region_code, r.area_code, r.brick_id,
      r.latest_row_created_at, r.total_qty,
      case when r.is_direct then coalesce(r.direct_value, 0)
           else r.effective_units * coalesce(pp.period_price, 0) end as line_value
    from public.source_of_sales_customer_directory_rollup r
    join public.source_of_sales_import_batches b on b.id = r.batch_id and b.status = 'validated'
    left join public.source_of_sales_products p on upper(btrim(p.product_code)) = upper(btrim(r.product_code))
    left join period_price pp on pp.pair = r.product_code || '|' || r.period
    where (p_period is null or r.period = p_period)
      and r.client_code is not null
      and (cardinality(p_exclude_codes) = 0
           or upper(btrim(coalesce(r.product_code, ''))) <> all (select upper(btrim(x)) from unnest(p_exclude_codes) as x))
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
    select client_code, distributor_code, sum(total_qty) as units, sum(line_value) as value
    from filtered group by client_code, distributor_code
  ),
  office as (
    select
      'OFFICE'::text as client_code,
      'Office'::text as client_name,
      'Office'::text as distributor_code,
      null::text as region_code,
      null::text as area_code,
      null::text as brick_id,
      sum(f.total_qty) as units,
      sum(f.effective_units * coalesce(pp.period_price, 0)) as value
    from public.source_of_sales_fact_rollup f
    join public.source_of_sales_import_batches b on b.id = f.batch_id and b.status = 'validated'
    left join public.source_of_sales_products p on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
    left join period_price pp on pp.pair = f.product_code || '|' || f.period
    where (p_period is null or f.period = p_period)
      and f.is_direct = false
      and upper(btrim(coalesce(f.distributor_code, ''))) = 'OFFICE'
      and (cardinality(p_exclude_codes) = 0
           or upper(btrim(coalesce(f.product_code, ''))) <> all (select upper(btrim(x)) from unnest(p_exclude_codes) as x))
      and (p_lines    is null or f.official_line = any(p_lines))
      and (p_products is null or f.product_code  = any(p_products))
      and (p_regions  is null or f.region_code   = any(p_regions))
      and (p_areas    is null or f.area_code     = any(p_areas))
    having sum(f.total_qty) is not null
  )
  select a.client_code, l.client_name, a.distributor_code,
         l.region_code, l.area_code, l.brick_id, a.units, a.value
  from agg a join latest l using (client_code, distributor_code)
  union all
  select o.client_code, o.client_name, o.distributor_code,
         o.region_code, o.area_code, o.brick_id, o.units, o.value
  from office o;
end;
$function$;

revoke execute on function public.phx_exec_customers(text, text[], text[], text[], text[], text[]) from public, anon, authenticated;
grant execute on function public.phx_exec_customers(text, text[], text[], text[], text[], text[]) to service_role;

commit;

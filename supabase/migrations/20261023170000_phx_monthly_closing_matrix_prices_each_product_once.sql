-- phx_monthly_closing_matrix asks for each product's period price ONCE, not once per rollup row.
-- SPEED ONLY — the answer is unchanged, and that was proven before this was written.
--
-- WHY. `public.phx_factory_price(code, period)` is SECURITY DEFINER and carries a `SET search_path`,
-- and Postgres inlines a SQL function with NEITHER of those. So every mention of it in a row-level
-- expression is a real function invocation with its own two correlated subqueries, one page each.
-- This is the Monthly Closing's own matrix — the source of truth for every sales figure on the
-- screen — and it was paying that price on all 18,558 CNS September rows to resolve 15 products.
--
-- MEASURED ON PRODUCTION 2026-10-23, phx_monthly_closing_matrix('CNS','2026-09'):
--
--     live function, resolver called per row        2,278 ms   40,088 shared buffers
--     this body, resolved once per product            202 ms      851 shared buffers
--
-- 11.3x faster, 47x fewer pages.
--
-- 🔴 DROPPING SECURITY DEFINER WOULD NOT HAVE DONE THIS, AND IT WAS MEASURED RATHER THAN ASSUMED.
-- The same query with the resolver's body written out inline — exactly what the planner substitutes
-- when it is allowed to inline a scalar SQL function — ran in 1,193 ms over 37,840 buffers, with
-- `SubPlan 1` and `SubPlan 2` each at 18,558 loops in the plan. Inlining does not turn the lookup
-- into a join; it leaves the correlated subqueries where they were. Only hoisting them out of the
-- row loop works, which is this. (The same conclusion was reached independently on 2026-09-28 and
-- is recorded in tests/factory-price-resolved-once.test.ts.)
--
-- WHY THE TWO BODIES ARE EQUIVALENT, not merely measured to agree:
--
--   1. PRICE PER PRODUCT, NOT PER ROW. Every row the scan returns satisfies `f.period = p_period`
--      by the WHERE clause, so the resolver's second argument was already a constant across the
--      whole call. `phx_factory_price` is STABLE and reads nothing else, so within one call its
--      value is a pure function of the product code — and resolving it once per DISTINCT code gives
--      every row carrying that code the same number it had before.
--   2. THE LEFT JOIN CANNOT CHANGE MULTIPLICITY. `select distinct` makes `period_price` hold at most
--      one row per product code, so the join adds exactly one row per base row. A code that matched
--      nothing and a code whose resolved price was NULL both fall to `coalesce(..., 0)` — which is
--      what the function itself returned for an unknown product, so the NULL branch is identical.
--      Production holds 0 rollup rows with a null product_code, and `period` is NOT NULL on
--      `source_of_sales_fact_rollup` by column constraint.
--   3. THE PRODUCT-MASTER LEFT JOIN STAYS. It lost its only consumer on 2026-09-28 when
--      `p.factory_price` was replaced by the resolver, but a left join fans out on duplicates, so
--      removing it is only safe while no two master rows differ by case or padding alone. It is
--      kept here so this migration changes one thing.
--
-- PROVEN IDENTICAL ON PRODUCTION, 2026-10-23, against the live function: all four official lines
-- (CNS, Head Office, Anti Infective, Pedia) against every period each of them actually holds rows
-- in — 39 line x period pairs, 7,697 rows out. Compared as TEXT, not as numerics: `(row)::text`
-- through `EXCEPT ALL` in BOTH directions, which pins each numeric's scale as well as its value.
-- Every pair returned 0 rows in both directions.
--
-- 🔴 THE PRICE OVERRIDE IS CARRIED BY ARGUMENT IDENTITY, NOT BY THE SAMPLE. Saginko (SA001) is
-- 111.15 through 2026-09 and 170.52 from 2026-10, and the sample above prices 1,105 non-direct
-- SA001 rows in Anti Infective 2026-09 identically. It cannot exercise 2026-10 or 2026-11, because
-- those two periods hold DIRECT rows only and this function excludes direct rows — so it returns
-- nothing there, before and after alike. What guarantees the override is that the resolver is
-- called with `p_period`, the same value `f.period` is pinned to by the WHERE clause, so the
-- argument is unchanged; the rule itself stays pinned by tests/product-period-price.test.ts.
--
-- A published month is never changed (owner, 2026-10-09). This function feeds the closing screen,
-- so a body that merely rounded differently would restate announced money — which is why the proof
-- above is a text comparison run before this file was written, not a sanity check run after.
--
-- ROLLBACK: re-apply supabase/migrations/20260928190008_phx_monthly_closing_matrix_reads_the_period_price.sql,
-- which holds the previous body. Nothing is dropped, renamed or written here, no row is touched,
-- and `create or replace` keeps the existing ACL. Production has NO point-in-time recovery, so note
-- that this replaces one read-only function body and is neither destructive nor bulk.

begin;

create or replace function public.phx_monthly_closing_matrix(p_line text, p_period text)
 returns table(area_code text, product_code text, sales_units numeric, sales_value numeric)
 language sql
 stable parallel safe security definer
 set search_path to 'public'
 set statement_timeout to '45s'
as $function$
  with base as (
    select f.area_code, f.product_code, f.total_qty, f.effective_units
    from public.source_of_sales_fact_rollup f
    join public.source_of_sales_import_batches b
      on b.id = f.batch_id and b.status = 'validated'
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
    where f.period = p_period
      and lower(btrim(f.official_line)) = lower(btrim(p_line))
      and not f.is_direct
      and upper(btrim(coalesce(f.product_code, ''))) not in ('LA003', 'LA004', 'SS001')
  ),
  period_price as (
    select d.product_code, public.phx_factory_price(d.product_code, p_period) as period_price
    from (select distinct base.product_code from base) d
  )
  select
    b.area_code,
    b.product_code,
    sum(b.total_qty)                                      as sales_units,
    sum(b.effective_units * coalesce(pp.period_price, 0)) as sales_value
  from base b
  left join period_price pp on pp.product_code = b.product_code
  group by b.area_code, b.product_code;
$function$;

revoke execute on function public.phx_monthly_closing_matrix(text, text) from public, anon, authenticated;
grant execute on function public.phx_monthly_closing_matrix(text, text) to service_role;
grant execute on function public.phx_monthly_closing_matrix(text, text) to analytics_readonly;

commit;

-- phx_customer_sales asks for each product's period price ONCE per (product, invoice period),
-- not once per invoice line.
-- SPEED ONLY — the answer is unchanged, and that was proven before this was written.
--
-- WHY. `public.phx_factory_price(code, period)` is SECURITY DEFINER and carries a `SET search_path`;
-- Postgres inlines a SQL function with NEITHER of those, so every mention in a row-level expression
-- is a real invocation with two correlated subqueries of its own. This one runs over
-- `source_of_sales_import_rows` — the 405,724-row invoice table — and prices every returned line
-- one at a time, although one customer's whole history spans only a handful of distinct
-- (product, period) pairs.
--
-- 🔴 DROPPING SECURITY DEFINER WOULD NOT HAVE DONE THIS. Measured on the sibling closing matrix on
-- 2026-10-23: the resolver's body written out inline — exactly what the planner substitutes when it
-- may inline a scalar SQL function — still showed `SubPlan 1` and `SubPlan 2` at one loop per row,
-- 1,193 ms against 2,278 ms, where hoisting gave 202 ms. Inlining leaves the correlated subqueries
-- where they are. Recorded independently on 2026-09-28 in tests/factory-price-resolved-once.test.ts.
--
-- WHY THE TWO BODIES ARE EQUIVALENT:
--
--   1. THE KEY IS (product_code, invoice_period) — exactly the two arguments the live body passes.
--      `phx_factory_price` is STABLE, so one pair cannot resolve to two different numbers inside
--      one call, and resolving once per DISTINCT pair hands every row the value it had before.
--   2. 🔴 THE JOIN IS `is not distinct from`, NOT `=`, BECAUSE `invoice_period` IS NULLABLE. It is
--      declared nullable on `source_of_sales_import_rows` (0 such rows today, but the column allows
--      them). `select distinct` treats NULLs as equal, so the CTE holds exactly one row for a
--      (code, NULL) pair and `is not distinct from` matches it — giving `phx_factory_price(code,
--      NULL)`, the same call the live body makes. A plain `=` would silently fall to
--      `coalesce(…, 0)` instead, which is why it is not used here.
--   3. THE LEFT JOIN CANNOT CHANGE MULTIPLICITY. `select distinct` makes `period_price` hold at
--      most one row per pair, so the join adds exactly one row per base row.
--   4. EVERY FILTER AND THE `order by` MOVE ACROSS VERBATIM. The product-master left join stays in
--      `base`: it lost its consumer on 2026-09-28, but a left join fans out on duplicates, so
--      removing it is a separate change. Rows tying on (invoice_period, product_name) were never
--      ordered against each other before and still are not.
--
-- PROVEN IDENTICAL ON PRODUCTION, 2026-10-23, against the live function: the 150 customers with the
-- most import rows, each over every period — 5,445 rows out, compared as TEXT, `(row)::text`
-- through `EXCEPT ALL` in BOTH directions, which pins each numeric's scale as well as its value. 0
-- rows both ways, every customer. The hoisting rule itself was additionally proven over the WHOLE
-- relation: all 405,724 rows of `source_of_sales_import_rows`, 225 distinct
-- (product_code, invoice_period) keys, 0 mismatches — which covers the Saginko override (SA001,
-- 111.15 through 2026-09, 170.52 from 2026-10) on every row carrying it, on both sides of the
-- boundary, including the direct rows that are the only thing 2026-10 and 2026-11 hold.
--
-- A published month is never changed (owner, 2026-10-09), which is why the proof above is a text
-- comparison run BEFORE this file was written, not a sanity check run after.
--
-- ROLLBACK: re-apply supabase/migrations/20260928190021_phx_customer_sales_reads_the_period_price.sql,
-- which holds the previous body. Nothing is dropped, renamed or written here, no row is touched,
-- and `create or replace` keeps the existing ACL. This replaces one read-only function body and is
-- neither destructive nor bulk.

begin;

create or replace function public.phx_customer_sales(p_distributor_code text, p_client_code text, p_from_period text default null::text, p_to_period text default null::text, p_exclude_codes text[] default array['LA003'::text, 'LA004'::text, 'SS001'::text])
 returns table(invoice_period text, product_code text, product_name text, official_line text, brick_id text, area_code text, region_code text, client_name text, client_address text, qty numeric, line_value numeric)
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  with base as (
    select
      r.invoice_period, r.product_code, r.product_name, r.official_line, r.brick_id,
      r.area_code, r.region_code, r.client_name, r.client_address, r.qty
    from public.source_of_sales_import_rows r
    join public.source_of_sales_import_batches b on b.id = r.batch_id
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(r.product_code))
    where b.status = 'validated'
      and r.distributor_code = p_distributor_code
      and r.client_code = p_client_code
      and (p_from_period is null or r.invoice_period >= p_from_period)
      and (p_to_period is null or r.invoice_period <= p_to_period)
      and upper(btrim(coalesce(r.product_code, ''))) <> all (
        select upper(btrim(x)) from unnest(coalesce(p_exclude_codes, '{}'::text[])) as x
      )
  ),
  period_price as (
    select d.product_code, d.invoice_period,
           public.phx_factory_price(d.product_code, d.invoice_period) as period_price
    from (select distinct base.product_code, base.invoice_period from base) d
  )
  select
    b.invoice_period, b.product_code, b.product_name, b.official_line, b.brick_id,
    b.area_code, b.region_code, b.client_name, b.client_address, b.qty,
    b.qty * coalesce(pp.period_price, 0) as line_value
  from base b
  left join period_price pp
    on pp.product_code is not distinct from b.product_code
   and pp.invoice_period is not distinct from b.invoice_period
  order by b.invoice_period, b.product_name;
$function$;

revoke execute on function public.phx_customer_sales(text, text, text, text, text[]) from public, anon, authenticated;
grant execute on function public.phx_customer_sales(text, text, text, text, text[]) to service_role;

commit;

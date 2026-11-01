-- phx_customer_directory_never_nests_its_price_join
--
-- WHAT THIS CHANGES: two things in public.phx_customer_directory, and nothing else. The function
-- gains `set enable_nestloop to 'off'`, and its exclude-codes test is wrapped in array( … ). No
-- filter, select list, group by, signature, grant or row is touched. SPEED ONLY.
--
-- WHY. /sales/customer-directory answered "Failed to load Customer Directory." on 2026-11-01. One
-- uncontended call on production took 24,622 ms for 48,937 customers, and the app's Supabase client
-- gives up at 15,000 ms. Five attempts failed between 14:17 and 14:19 Cairo: three finished in the
-- database at 20.5 s, 26.2 s and 27.7 s after the page had already given up, and two reached this
-- function's own 45 s limit and were cancelled.
--
-- WHAT IS SLOW. A SQL function is planned once with its parameters unknown, and seven
-- `(p_x is null or …)` predicates multiply the estimate down to 24 rows out of about 118,000 real
-- ones. Believing 24, the planner joins the price lookup with a nested loop, so every row walks the
-- whole list of (product, period) prices. Staging, the same 205,892-row table with this exact plan:
-- `Rows Removed by Join Filter: 20,384,417`, 10.9 s of 11.9 s. The cost is rows × (products ×
-- periods), so it grows with the square of the months held, which is why the page reached the limit
-- on its own: one month takes 0.68 s and two take 1.82 s on production.
--
-- 🔴 20261023170600 RECORDS A HASH JOIN ON THE PAIR KEY, AND THAT IS TRUE ONLY WITH THE PARAMETERS
-- KNOWN. Written out with literals the query runs in 3.9 s, which is why the slow plan is invisible
-- to a hand-run EXPLAIN. To see the plan the function really gets, PREPARE the body and set
-- plan_cache_mode = force_generic_plan.
--
-- WHY THE PLANNER SWITCH AND NOT A BETTER ESTIMATE. The estimate is wrong because the filters are
-- optional, and they have to stay optional. With nested loops off the joins hash: staging went from
-- 11,953 ms to 1,383 ms on the same 41,248 rows. It binds this function's own planning alone, and it
-- also reaches phx_factory_price, whose two single-table lookups have no join to change.
--
-- WHY THE ANSWER IS UNCHANGED. A join method cannot change a join's result. The array( … ) wrap is
-- the one tests/sales-reads-exclude-codes-once.test.ts already pins elsewhere, and `coalesce` still
-- turns a NULL list into an empty one, so a caller excluding nothing still keeps every row.
-- Compared against the live function before this was applied. Staging, the whole table, as text
-- through EXCEPT ALL: 41,248 rows and 0 differences with the three confidential products excluded.
-- Production, 2026-09: 13,099 rows and 0 differences, and with nothing excluded 18,677 rows, the
-- value sum equal to the last decimal (45323924.767515) and 0 customers differing in units, value or
-- geography. The whole production table was not compared: a multi-second check there waits until
-- after 17:00 Cairo (owner, 2026-10-19), and this was applied at 14:29.
--
-- 🔴 WITH NOTHING EXCLUDED A HANDFUL OF ROWS DIFFER IN NAME OR ADDRESS, AND THAT IS NOT THIS CHANGE.
-- `latest` picks with `distinct on … order by latest_row_created_at desc`, and rows tied on that
-- timestamp can spell a customer's name differently, so the pick is arbitrary. The OLD function
-- disagreed with ITSELF on 10 and 11 of 51,569 rows across three runs on staging; old against new
-- disagreed on 7, and on 0 in units, value, geography or which customers appear.
--
-- ROLLBACK: re-apply
-- supabase/migrations/20261023170600_phx_customer_directory_prices_each_product_once.sql, which
-- holds the previous body. Nothing is dropped or written here, and `create or replace` keeps the
-- existing ACL. This replaces one read-only function and is neither destructive nor bulk.

begin;

create or replace function public.phx_customer_directory(p_region_codes text[] default null::text[], p_area_codes text[] default null::text[], p_brick_codes text[] default null::text[], p_distributor_codes text[] default null::text[], p_from_period text default null::text, p_to_period text default null::text, p_exclude_codes text[] default array['LA003'::text, 'LA004'::text, 'SS001'::text])
 returns table(client_code text, client_name text, client_address text, distributor_code text, brick_id text, area_code text, region_code text, total_units numeric, total_value numeric)
 language sql
 stable security definer
 set search_path to 'public'
 set statement_timeout to '45s'
 set work_mem to '128MB'
 set enable_nestloop to 'off'
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
      and upper(btrim(coalesce(c.product_code, ''))) <> all (array(
        select upper(btrim(x)) from unnest(coalesce(p_exclude_codes, '{}'::text[])) as x
      ))
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

-- phx_sales_channels_by_rep asks for each product's period price ONCE per (product, invoice
-- period), not once per invoice line.
-- SPEED ONLY — the answer is unchanged, and that was proven before this was written.
--
-- WHY. `public.phx_factory_price(code, period)` is SECURITY DEFINER and carries a `SET search_path`;
-- Postgres inlines a SQL function with NEITHER of those, so every mention in a row-level expression
-- is a real invocation with two correlated subqueries of its own. `rows_in_scope` reads
-- `source_of_sales_import_rows` — 405,724 rows — and with no period argument it prices all of them
-- to resolve 225 distinct (product, period) pairs.
--
-- 🔴 DROPPING SECURITY DEFINER WOULD NOT HAVE DONE THIS. Measured on the sibling closing matrix on
-- 2026-10-23: the resolver's body written out inline — exactly what the planner substitutes when it
-- may inline a scalar SQL function — still showed `SubPlan 1` and `SubPlan 2` at one loop per row,
-- 1,193 ms against 2,278 ms, where hoisting gave 202 ms. Inlining leaves the correlated subqueries
-- where they are. Recorded independently on 2026-09-28 in tests/factory-price-resolved-once.test.ts.
--
-- WHY THE TWO BODIES ARE EQUIVALENT:
--
--   1. THE KEY IS (product_code, invoice_period) — exactly the two arguments the live body passes,
--      and the function is STABLE, so one pair cannot resolve to two different numbers inside one
--      call.
--   2. 🔴 THE JOIN IS `is not distinct from`, NOT `=`, BECAUSE `invoice_period` IS NULLABLE on
--      `source_of_sales_import_rows`. `select distinct` treats NULLs as equal, so the lookup holds
--      exactly one row for a (code, NULL) pair and `is not distinct from` matches it — giving
--      `phx_factory_price(code, NULL)`, the same call the live body makes. A plain `=` would
--      silently fall to `coalesce(…, 0)` instead, which is why it is not used here.
--   3. `period_price` IS A SUPERSET, WHICH IS SAFE. It is built from the distinct pairs of the same
--      table under the SAME period predicate (`p_period is null or invoice_period = p_period`), so
--      it holds every pair `rows_in_scope` can ask for and possibly a few the excluded-product
--      filter discards. A row nothing joins to is never read.
--   4. THE LEFT JOIN CANNOT CHANGE MULTIPLICITY. `select distinct` makes it at most one row per
--      pair, so the join adds exactly one row per invoice line — which is why `tagged`, `seated`,
--      `repped`, every `sum(…) filter (…)` and the three
--      `count(distinct concat_ws('|', distributor_code, client_code))` customer counts see exactly
--      what they saw before.
--   5. THE DIRECT ARM IS UNTOUCHED: `case when coalesce(r.is_direct, false) then coalesce(r.value,
--      0)` still takes the order's own value and never prices it. The comment above it — that the
--      sheet's typed value is never read for a distributor row — still describes the code.
--      `phx_customer_channel`, the seat crosswalk and the occupancy join move across verbatim.
--
-- PROVEN IDENTICAL ON PRODUCTION, 2026-10-23, AT THE CTE AND NOT AT THE FUNCTION — say so plainly.
-- The whole function could not be compared: it calls `phx_customer_channel` once per row, which is
-- slow enough that running the live function twice over a meaningful window times out. So the proof
-- was taken one level in, at `rows_in_scope` — the ONLY CTE this migration changes, and the only
-- place the resolver is mentioned. Its output was computed both ways over EVERY period, 218,302
-- rows, and compared as TEXT, `(row)::text` through `EXCEPT ALL` in BOTH directions: 0 differences
-- either way. Every statement downstream of `rows_in_scope` is identical text in the two bodies, so
-- a `rows_in_scope` that matches row for row makes the function's own output identical. The
-- hoisting rule itself was proven over the WHOLE relation: all 405,724 rows of
-- `source_of_sales_import_rows`, 225 distinct (product_code, invoice_period) keys, 0 mismatches —
-- which covers the Saginko override (SA001, 111.15 through 2026-09, 170.52 from 2026-10) on every
-- row carrying it, on both sides of the boundary, direct rows included.
--
-- A published month is never changed (owner, 2026-10-09), which is why the proof above is a text
-- comparison run BEFORE this file was written, not a sanity check run after.
--
-- ROLLBACK: re-apply
-- supabase/migrations/20260928190023_phx_sales_channels_by_rep_reads_the_period_price.sql, which
-- holds the previous body. Nothing is dropped, renamed or written here, no row is touched, and
-- `create or replace` keeps the existing ACL. This replaces one read-only function body and is
-- neither destructive nor bulk.

begin;

create or replace function public.phx_sales_channels_by_rep(p_store_stems text[], p_hospital_stems text[], p_excluded_product_codes text[], p_period text default null::text, p_store_override_keys text[] default '{}'::text[], p_pharmacy_override_codes text[] default '{}'::text[], p_rule jsonb default '{}'::jsonb)
 returns table(seat_id text, rep_hr_id text, rep_name text, line_code text, area_code text, area_name text, hospital_value numeric, store_value numeric, pharmacy_value numeric, total_value numeric, hospital_customers bigint, store_customers bigint, pharmacy_customers bigint)
 language sql
 stable security definer
 set search_path to 'public', 'au'
 set statement_timeout to '60s'
as $function$
  with rule as (
    select case
             when p_rule is null or p_rule = '{}'::jsonb then jsonb_build_object(
               'hospitalStems', to_jsonb(coalesce(p_hospital_stems, '{}'::text[])),
               'storeStems', to_jsonb(coalesce(p_store_stems, '{}'::text[])),
               'pharmacyOverrideCodes', to_jsonb(coalesce(p_pharmacy_override_codes, '{}'::text[])),
               'storeOverrideKeys', to_jsonb(coalesce(p_store_override_keys, '{}'::text[]))
             )
             else p_rule
           end as payload
  ),
  period_price as (
    select d.product_code, d.invoice_period,
           public.phx_factory_price(d.product_code, d.invoice_period) as period_price
    from (
      select distinct r.product_code, r.invoice_period
      from public.source_of_sales_import_rows r
      where (p_period is null or r.invoice_period = p_period)
    ) d
  ),
  rows_in_scope as (
    -- The closing's value: a distributor row is its paid units x factory price, and a direct order
    -- keeps its own order value. The sheet's typed value is never read for a distributor row.
    select r.client_code,
           r.distributor_code,
           r.area_code,
           r.official_line,
           r.invoice_period,
           r.client_name,
           case
             when coalesce(r.is_direct, false) then coalesce(r.value, 0)
             else coalesce(r.qty, 0) * coalesce(pp.period_price, 0)
           end as value
    from public.source_of_sales_import_rows r
    join public.source_of_sales_import_batches b
      on b.id = r.batch_id and b.status = 'validated'
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(r.product_code))
    left join period_price pp
      on pp.product_code is not distinct from r.product_code
     and pp.invoice_period is not distinct from r.invoice_period
    where (p_period is null or r.invoice_period = p_period)
      and upper(btrim(coalesce(r.product_code, ''))) <> all (
            select upper(btrim(code))
            from unnest(coalesce(p_excluded_product_codes, '{}')) code)
  ),
  tagged as (
    select t.client_code,
           t.distributor_code,
           t.area_code,
           t.official_line,
           t.value,
           public.phx_customer_channel(
             t.client_name, t.client_code, t.distributor_code,
             t.invoice_period, t.official_line, rule.payload
           ) as channel
    from rows_in_scope t
    cross join rule
  ),
  seated as (
    select t.channel,
           t.value,
           t.client_code,
           t.distributor_code,
           s.seat_id,
           s.line_code,
           s.area_code as seat_area_code
    from tagged t
    left join au.sos_area_crosswalk x
      on x.sos_area_code = t.area_code and x.effective_to is null
    left join au.sos_official_line_map lm
      on lower(btrim(lm.official_line)) = lower(btrim(t.official_line))
    left join au.seats s
      on s.area_code = x.canonical_area_code
     and s.line_code = lm.line_code
     and s.seat_tier = 'REP'
     and s.is_active
  ),
  repped as (
    select sd.*, oh.occupant_hr_id
    from seated sd
    left join au.occupancy_history oh
      on oh.seat_id = sd.seat_id and oh.effective_to is null
  )
  select
    rp.seat_id::text                                                             as seat_id,
    rp.occupant_hr_id::text                                                      as rep_hr_id,
    e.full_name::text                                                            as rep_name,
    rp.line_code::text                                                           as line_code,
    rp.seat_area_code::text                                                      as area_code,
    ca.area_name::text                                                           as area_name,
    coalesce(sum(rp.value) filter (where rp.channel = 'hospital'), 0)            as hospital_value,
    coalesce(sum(rp.value) filter (where rp.channel = 'store'), 0)               as store_value,
    coalesce(sum(rp.value) filter (where rp.channel = 'pharmacy'), 0)            as pharmacy_value,
    coalesce(sum(rp.value), 0)                                                   as total_value,
    count(distinct concat_ws('|', rp.distributor_code, rp.client_code))
      filter (where rp.channel = 'hospital')                                     as hospital_customers,
    count(distinct concat_ws('|', rp.distributor_code, rp.client_code))
      filter (where rp.channel = 'store')                                        as store_customers,
    count(distinct concat_ws('|', rp.distributor_code, rp.client_code))
      filter (where rp.channel = 'pharmacy')                                     as pharmacy_customers
  from repped rp
  left join public.employees e on e.hr_id = rp.occupant_hr_id
  left join au.canonical_areas ca on ca.area_code = rp.seat_area_code
  group by 1, 2, 3, 4, 5, 6
  order by 10 desc;
$function$;

revoke execute on function public.phx_sales_channels_by_rep(text[], text[], text[], text, text[], text[], jsonb) from public, anon, authenticated;
grant execute on function public.phx_sales_channels_by_rep(text[], text[], text[], text, text[], text[], jsonb) to service_role;

commit;

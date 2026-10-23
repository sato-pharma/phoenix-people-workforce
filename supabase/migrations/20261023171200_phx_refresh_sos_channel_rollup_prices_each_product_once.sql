-- phx_refresh_sos_channel_rollup asks for each product's period price ONCE per (product, period),
-- not THREE times per fact row.
-- SPEED ONLY — the answer is unchanged, and that was proven before this was written.
--
-- WHY. `public.phx_factory_price(code, period)` is SECURITY DEFINER and carries a `SET search_path`;
-- Postgres inlines a SQL function with NEITHER of those, so every mention in a row-level expression
-- is a real invocation with two correlated subqueries of its own. The `retail` CTE mentions it
-- TWICE — once for `value_all` and once inside the `filter` that builds `value_restricted` — so a
-- batch's rebuild paid two resolutions per row to look up a handful of products. This runs on
-- every monthly import, every mapping save and every rollup rebuild, so it is on the write path
-- the owner waits on, not a report.
--
-- 🔴 DROPPING SECURITY DEFINER WOULD NOT HAVE DONE THIS. Measured on the sibling closing matrix on
-- 2026-10-23: the resolver's body written out inline — exactly what the planner substitutes when it
-- may inline a scalar SQL function — still showed `SubPlan 1` and `SubPlan 2` at one loop per row,
-- 1,193 ms against 2,278 ms, where hoisting gave 202 ms. Inlining leaves the correlated subqueries
-- where they are. Recorded independently on 2026-09-28 in tests/factory-price-resolved-once.test.ts.
--
-- 🔴 THE BATCH LOCK IS UNCHANGED AND STILL THE FIRST STATEMENT. `perform pg_advisory_xact_lock(
-- hashtext('phx_refresh_sos_channel_rollup'), hashtext(p_batch_id::text))` stays exactly where
-- 20261023070100 put it, before the delete — two rebuilds of one batch would otherwise each delete
-- the committed rows and each insert a full set, and the batch would count twice in every Closing
-- figure read from it. Pinned by tests/sos-rollup-refresh-batch-lock.test.ts, which resolves the
-- NEWEST migration defining this function — which is now this file.
--
-- WHY THE TWO BODIES ARE EQUIVALENT:
--
--   1. THE KEY IS (product_code, period) — exactly the two arguments both mentions pass, and the
--      function is STABLE, so one pair cannot resolve to two different numbers inside one call.
--      That is why one lookup can serve both.
--   2. `period_price` IS SCOPED TO THE BATCH, like everything else here: the distinct pairs of
--      `source_of_sales_fact_rollup` for `p_batch_id`. It is a superset of what `retail` asks for
--      (it does not apply the `not is_direct` filter), and a row nothing joins to is never read.
--   3. THE LEFT JOIN CANNOT CHANGE MULTIPLICITY. `select distinct` makes it at most one row per
--      pair, so the join adds exactly one row per fact row — which is why `units_all`, `rows_all`,
--      `rows_restricted` and the `group by` keys are untouched.
--   4. THE NULL BRANCHES AGREE. `period` is NOT NULL on the fact rollup by column constraint. A
--      NULL product_code fails the equality join and falls to `coalesce(…, 0)` — which is what the
--      resolver itself returns for an unknown product.
--   5. `names` AND `direct` ARE BYTE-FOR-BYTE THE OLD BODY. The direct half reads
--      `source_of_sales_import_rows.value` straight and never touched the resolver; the insert's
--      column list, the `union all` and the `distinct on` name pick move across verbatim.
--
-- PROVEN IDENTICAL ON PRODUCTION, 2026-10-23, BEFORE this file was written and WITHOUT running the
-- function (it deletes and re-inserts, so it is never called to test it): the `retail` CTE's own
-- output — every column it contributes — was computed both ways and compared as TEXT, `(row)::text`
-- through `EXCEPT ALL` in both directions. 0 differences. 🔴 THE SAMPLE IS THE TEN LARGEST VALIDATED
-- BATCHES, 144,163 fact rows, NOT every batch: over all validated batches the double computation
-- times out, so the window was cut to the ten carrying the most rows. Every statement downstream of
-- `retail` is identical text, so a `retail` that matches row for row makes the inserted rows
-- identical. The hoisting rule itself was also proven over the WHOLE relation: all 295,418 rows of
-- `source_of_sales_fact_rollup`, 225 distinct (product_code, period) keys, 0 mismatches — which
-- covers the Saginko override (SA001, 111.15 through 2026-09, 170.52 from 2026-10) on every row
-- carrying it, on both sides of the boundary.
--
-- A published month is never changed (owner, 2026-10-09): this rollup is what the closing's channel
-- tab reads, so the proof above is a text comparison run before this file was written.
--
-- ROLLBACK: re-apply
-- supabase/migrations/20261023070100_phx_refresh_sos_channel_rollup_takes_a_batch_lock.sql, which
-- holds the previous body, lock included. Nothing is dropped or renamed here and no schema changes;
-- the function still rebuilds exactly the rows of the batch it is handed.

begin;

create or replace function public.phx_refresh_sos_channel_rollup(p_batch_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
 set statement_timeout to '120s'
as $function$
begin
  perform pg_advisory_xact_lock(hashtext('phx_refresh_sos_channel_rollup'), hashtext(p_batch_id::text));
  delete from public.source_of_sales_channel_customer_rollup where batch_id = p_batch_id;

  insert into public.source_of_sales_channel_customer_rollup
    (batch_id, line_key, official_line, period, distributor_code, client_code, client_key,
     client_name, folded_name, no_client_code, is_direct,
     units_all, value_all, rows_all, units_restricted, value_restricted, rows_restricted)
  with
  period_price as (
    select d.product_code, d.period,
           public.phx_factory_price(d.product_code, d.period) as period_price
    from (
      select distinct f.product_code, f.period
      from public.source_of_sales_fact_rollup f
      where f.batch_id = p_batch_id
    ) d
  ),
  names as (
    select distinct on (lower(btrim(d.official_line)), d.period, d.distributor_code, d.client_code)
      lower(btrim(d.official_line)) as line_key,
      d.period, d.distributor_code, d.client_code, d.client_name
    from public.source_of_sales_customer_directory_rollup d
    where d.batch_id = p_batch_id
    order by lower(btrim(d.official_line)), d.period, d.distributor_code, d.client_code,
             d.latest_row_created_at desc
  ),
  retail as (
    select
      f.batch_id,
      lower(btrim(f.official_line))                          as line_key,
      max(f.official_line)                                   as official_line,
      f.period,
      f.distributor_code,
      f.client_code,
      f.client_code                                          as client_key,
      coalesce(n.client_name, '')                            as client_name,
      public.phx_fold_customer_name(coalesce(n.client_name, '')) as folded_name,
      (f.client_code is null)                                as no_client_code,
      false                                                  as is_direct,
      sum(f.total_qty)                                       as units_all,
      sum(f.effective_units * coalesce(pp.period_price, 0))  as value_all,
      count(*)                                               as rows_all,
      coalesce(sum(f.total_qty)
        filter (where upper(btrim(coalesce(f.product_code, ''))) = any (array['LA003','LA004','SS001'])), 0) as units_restricted,
      coalesce(sum(f.effective_units * coalesce(pp.period_price, 0))
        filter (where upper(btrim(coalesce(f.product_code, ''))) = any (array['LA003','LA004','SS001'])), 0) as value_restricted,
      count(*)
        filter (where upper(btrim(coalesce(f.product_code, ''))) = any (array['LA003','LA004','SS001']))     as rows_restricted
    from public.source_of_sales_fact_rollup f
    join public.source_of_sales_import_batches b
      on b.id = f.batch_id and b.status = 'validated'
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
    left join period_price pp
      on pp.product_code = f.product_code and pp.period = f.period
    left join names n
      on n.line_key = lower(btrim(f.official_line))
     and n.period = f.period
     and n.distributor_code = f.distributor_code
     and n.client_code = f.client_code
    where f.batch_id = p_batch_id
      and not coalesce(f.is_direct, false)
    group by f.batch_id, lower(btrim(f.official_line)), f.period, f.distributor_code,
             f.client_code, coalesce(n.client_name, '')
  ),
  direct as (
    select
      r.batch_id,
      lower(btrim(r.official_line))                          as line_key,
      max(r.official_line)                                   as official_line,
      r.invoice_period                                       as period,
      null::text                                             as distributor_code,
      null::text                                             as client_code,
      case when btrim(coalesce(r.client_name, '')) = '' then null
           else 'name:' || public.phx_fold_customer_name(r.client_name) end as client_key,
      btrim(coalesce(r.client_name, ''))                     as client_name,
      public.phx_fold_customer_name(btrim(coalesce(r.client_name, ''))) as folded_name,
      false                                                  as no_client_code,
      true                                                   as is_direct,
      sum(r.qty)                                             as units_all,
      sum(r.value)                                           as value_all,
      count(*)                                               as rows_all,
      coalesce(sum(r.qty)
        filter (where upper(btrim(coalesce(r.product_code, ''))) = any (array['LA003','LA004','SS001'])), 0) as units_restricted,
      coalesce(sum(r.value)
        filter (where upper(btrim(coalesce(r.product_code, ''))) = any (array['LA003','LA004','SS001'])), 0) as value_restricted,
      count(*)
        filter (where upper(btrim(coalesce(r.product_code, ''))) = any (array['LA003','LA004','SS001']))     as rows_restricted
    from public.source_of_sales_import_rows r
    join public.source_of_sales_import_batches b
      on b.id = r.batch_id and b.status = 'validated'
    where r.batch_id = p_batch_id
      and coalesce(r.is_direct, false)
      and r.validation_state = 'valid'
    group by r.batch_id, lower(btrim(r.official_line)), r.invoice_period,
      case when btrim(coalesce(r.client_name, '')) = '' then null
           else 'name:' || public.phx_fold_customer_name(r.client_name) end,
      btrim(coalesce(r.client_name, ''))
  )
  select batch_id, line_key, official_line, period, distributor_code, client_code, client_key,
         client_name, folded_name, no_client_code, is_direct,
         units_all, value_all, rows_all, units_restricted, value_restricted, rows_restricted
  from retail
  union all
  select batch_id, line_key, official_line, period, distributor_code, client_code, client_key,
         client_name, folded_name, no_client_code, is_direct,
         units_all, value_all, rows_all, units_restricted, value_restricted, rows_restricted
  from direct;
end;
$function$;

revoke execute on function public.phx_refresh_sos_channel_rollup(uuid) from public, anon, authenticated;
grant execute on function public.phx_refresh_sos_channel_rollup(uuid) to service_role;

commit;

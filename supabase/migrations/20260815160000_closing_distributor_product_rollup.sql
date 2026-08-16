-- Precompute the Monthly-Closing distributor×product totals into a refreshable rollup.
--
-- WHY. public.phx_closing_distributor_product is the Monthly-Closing "Calc" engine: it feeds the
-- Closing Comparison report AND (since the matrix fold) the whole Monthly-Closing matrix derives
-- from it. A fresh EXPLAIN(ANALYZE,BUFFERS) of the heaviest realistic call (CNS, 2026-07) measured
-- ~166 ms: an Index-Only Scan of source_of_sales_fact_rollup that reads ~32k rows and throws away
-- ~15k to the line/product filter, then a HashAggregate over ~17k survivors — every call, entirely
-- from cache. Worse, the read is paginated by rpcAll(), which RE-RUNS the whole aggregate once per
-- 1000-row page (2-3x for a real line), so a report load costs 330-590 ms. None of that scan +
-- aggregate depends on anything but the validated fact rows, so it can be precomputed once per batch.
-- factory_price stays joined LIVE, so the owner's rule — editing a product's factory price reprices
-- all history instantly — is preserved to the piastre. The price is NEVER baked.
--
-- WHAT. A new table source_of_sales_distributor_product_rollup holds one row per
-- (batch, official_line, period, distributor, region, area, product), carrying the summed units
-- (Σ total_qty) and the summed effective units (Σ effective_units) plus the representative product
-- name (max). The read function multiplies eff_units by the live factory price and re-groups across
-- a slice's batches — output byte-for-byte identical to the live aggregate, because within a
-- (distributor, region, area, product) group every row shares one product_code, so
-- Σ(effective_units × price) = price × Σ(effective_units). Direct orders and the three restricted
-- codes (LA003/LA004/SS001) are excluded at build time exactly as the live function excludes them.
--
-- KEYED PER BATCH, exactly like source_of_sales_fact_rollup and the channel rollup: each batch owns
-- its own rows (batch_id … on delete cascade), refresh is delete-by-batch + reinsert, superseded
-- batches self-clean via the cascade, and there is no cross-batch write race. Because finalize
-- supersedes sibling batches for the same (distributor, period), a slice's (distributor, region,
-- area, product) money lives in exactly one validated batch; the read's GROUP BY reunites the
-- slice's batches, identical to the live GROUP BY across all validated batches.
--
-- Proven output-identical to the live function on staging (Phoenix-HR-Staging, cifwmndunmlxjhyjugxa)
-- across every (line, period) slice: 20 slices, 10,300 rows each side, both EXCEPT directions = zero
-- rows different. The rollup collapses 134,261 source rows to 15,373 rows on production (~8.7x), a
-- ~3 MB table that removes far more repeated work than its footprint.

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- 1. The rollup table
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
create table if not exists public.source_of_sales_distributor_product_rollup (
  id                bigint generated always as identity primary key,
  batch_id          uuid    not null references public.source_of_sales_import_batches(id) on delete cascade,
  -- Slice keys. line_key is the folded official line the read filters on; official_line is a
  -- representative display value the lock guard folds. Both stay nullable so a fact row with no
  -- line still rolls up harmlessly (it can never match a real p_line query).
  line_key          text,
  official_line     text,
  period            text,
  distributor_code  text,
  region_code       text,
  area_code         text,
  product_code      text,
  product_name      text,
  units_qty         numeric not null default 0,   -- Σ total_qty      (the report's "units")
  eff_units         numeric not null default 0    -- Σ effective_units (× live factory_price = "value")
);

-- The read path: filter (line_key, period) then aggregate.
create index if not exists source_of_sales_distributor_product_rollup_line_period_idx
  on public.source_of_sales_distributor_product_rollup (line_key, period);
-- The per-batch delete in the refresh function.
create index if not exists source_of_sales_distributor_product_rollup_batch_idx
  on public.source_of_sales_distributor_product_rollup (batch_id);

-- Same posture as the sibling rollups: RLS on, one service_role ALL policy, no anon/authenticated.
-- Every read of this table goes through the SECURITY DEFINER function below, never the browser.
alter table public.source_of_sales_distributor_product_rollup enable row level security;

drop policy if exists source_of_sales_distributor_product_rollup_service_role_all
  on public.source_of_sales_distributor_product_rollup;
create policy source_of_sales_distributor_product_rollup_service_role_all
  on public.source_of_sales_distributor_product_rollup
  for all to service_role using (true) with check (true);

grant select, insert, update, delete, references, trigger, truncate
  on table public.source_of_sales_distributor_product_rollup to service_role;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- 2. The per-batch refresh — the SAME query the initial backfill uses, so history cannot diverge
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.phx_refresh_sos_distributor_product_rollup(p_batch_id uuid)
  returns void
  language plpgsql
  security definer
  set search_path to 'public'
  set statement_timeout to '120s'
as $function$
begin
  -- This batch owns exactly its own rows, like source_of_sales_fact_rollup.
  delete from public.source_of_sales_distributor_product_rollup where batch_id = p_batch_id;

  insert into public.source_of_sales_distributor_product_rollup
    (batch_id, line_key, official_line, period, distributor_code, region_code, area_code,
     product_code, product_name, units_qty, eff_units)
  select
    f.batch_id,
    lower(btrim(f.official_line))   as line_key,
    max(f.official_line)            as official_line,
    f.period,
    f.distributor_code,
    f.region_code,
    f.area_code,
    f.product_code,
    max(f.product_name)             as product_name,
    sum(f.total_qty)                as units_qty,
    sum(f.effective_units)          as eff_units
  from public.source_of_sales_fact_rollup f
  join public.source_of_sales_import_batches b
    on b.id = f.batch_id and b.status = 'validated'
  where f.batch_id = p_batch_id
    and not coalesce(f.is_direct, false)
    and upper(btrim(coalesce(f.product_code, ''))) not in ('LA003', 'LA004', 'SS001')
  group by f.batch_id, lower(btrim(f.official_line)), f.period,
           f.distributor_code, f.region_code, f.area_code, f.product_code;
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- 3. Backfill every validated batch, using the exact per-batch refresh above (no divergence path).
--    Runs BEFORE the lock-guard triggers are attached, so a locked slice does not block the initial
--    load; the frozen slice's rollup is built once here from the same frozen sources the live
--    function reads, and the triggers then protect it from any later mutation.
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
do $backfill$
declare
  rec record;
begin
  for rec in
    select id
    from public.source_of_sales_import_batches
    where status = 'validated' and period is not null
  loop
    perform public.phx_refresh_sos_distributor_product_rollup(rec.id);
  end loop;
end;
$backfill$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- 4. The monthly-closing lock guard, same as the sibling closing tables. A refresh of a locked
--    (period, official_line) is rejected — and its import_rows are frozen too, so no legitimate
--    refresh ever targets one.
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
create trigger trg_lock_guard_ins
  after insert on public.source_of_sales_distributor_product_rollup
  referencing new table as new_rows for each statement
  execute function public.phx_reject_write_to_locked_closing('period', 'official_line');

create trigger trg_lock_guard_upd
  after update on public.source_of_sales_distributor_product_rollup
  referencing old table as old_rows new table as new_rows for each statement
  execute function public.phx_reject_write_to_locked_closing('period', 'official_line');

create trigger trg_lock_guard_del
  after delete on public.source_of_sales_distributor_product_rollup
  referencing old table as old_rows for each statement
  execute function public.phx_reject_write_to_locked_closing('period', 'official_line');

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- 5. Wire the DP refresh into every server-side refresh path, AFTER the fact rollup it reads.
--    CREATE OR REPLACE reproduces each current body verbatim (channel + attribution refreshes
--    already present) with a single added call — no other behaviour changes.
-- ─────────────────────────────────────────────────────────────────────────────────────────────────

-- 5a. Normal distributor imports, normalizer-buffer imports and approved direct-order injection.
create or replace function public.phx_finalize_sos_batch(p_batch_id uuid, p_distributor_code text, p_period text)
  returns jsonb
  language plpgsql
  security definer
  set search_path to 'public'
  set statement_timeout to '120s'
as $function$
declare
  v_superseded jsonb;
  v_raw_count bigint;
  v_rollup_count bigint;
begin
  if not pg_try_advisory_xact_lock(hashtextextended(p_distributor_code || ':' || p_period, 0)) then
    raise exception 'Another upload for % / % is finalizing right now -- retry in a few seconds.', p_distributor_code, p_period
      using errcode = '55P03';
  end if;

  if to_regclass('public.monthly_sales_period_lock') is not null
     and exists (
       select 1 from public.monthly_sales_period_lock
       where period = p_period and locked = true
     ) then
    raise exception 'Period % is locked -- uploads and finalization are frozen until it is reopened.', p_period
      using errcode = '55P03';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', id,
    'fileName', file_name,
    'distributorCode', distributor_code,
    'period', period,
    'status', status
  )), '[]'::jsonb)
  into v_superseded
  from public.source_of_sales_import_batches
  where distributor_code = p_distributor_code
    and period = p_period
    and id <> p_batch_id;

  delete from public.source_of_sales_import_batches
  where distributor_code = p_distributor_code
    and period = p_period
    and id <> p_batch_id;

  update public.source_of_sales_import_batches
  set status = 'validated', blocking_reasons = '{}'
  where id = p_batch_id;

  if not found then
    raise exception 'Batch % not found while finalizing.', p_batch_id;
  end if;

  perform public.phx_refresh_sos_fact_rollup(p_batch_id);
  perform public.phx_refresh_sos_customer_directory_rollup(p_batch_id);
  perform public.phx_refresh_marketing_roi_facts(p_batch_id);
  perform public.phx_refresh_sos_channel_rollup(p_batch_id);
  -- Distributor×product rollup — reads the fact rollup just refreshed, in lock-step.
  perform public.phx_refresh_sos_distributor_product_rollup(p_batch_id);
  -- Monthly attribution rollup (sales-vs-target engine) — after the fact rollup it reads, in lock-step.
  perform public.phx_refresh_monthly_attribution(p_batch_id);

  select count(*) into v_raw_count
  from public.source_of_sales_import_rows
  where batch_id = p_batch_id;

  select coalesce(sum(row_count), 0) into v_rollup_count
  from public.source_of_sales_fact_rollup
  where batch_id = p_batch_id;

  if v_raw_count <> v_rollup_count then
    raise exception 'Reconciliation failed for batch %: % raw rows but % rolled up -- aborting.', p_batch_id, v_raw_count, v_rollup_count;
  end if;

  return jsonb_build_object('supersededBatches', v_superseded, 'rowCount', v_raw_count);
end;
$function$;

-- 5b. Territory brick/area re-stamp.
create or replace function public.phx_sync_sos_run(p_periods text[] DEFAULT NULL::text[])
  returns TABLE(restamped_rows integer, refreshed_batches integer)
  language plpgsql
  security definer
  set search_path to 'public'
  set statement_timeout to '300s'
as $function$
declare
  v_rows integer := 0;
  v_batches uuid[] := '{}'::uuid[];
  v_batch uuid;
  v_refreshed integer := 0;
begin
  with target as (
    select
      m.distributor_code,
      m.customer_code,
      m.brick_id,
      b.area_code,
      b.region_code,
      a.area_name,
      g.region_name
    from public.source_of_sales_customer_map m
    join public.source_of_sales_bricks b on b.brick_id = m.brick_id
    left join public.source_of_sales_areas a on a.area_code = b.area_code
    left join public.source_of_sales_regions g on g.region_code = b.region_code
    where m.active
      and m.brick_id is not null
  ),
  updated as (
    update public.source_of_sales_import_rows r
    set brick_id = t.brick_id,
        area_code = t.area_code,
        area_name = coalesce(t.area_name, r.area_name),
        region_code = t.region_code,
        region_name = coalesce(t.region_name, r.region_name)
    from target t
    where r.distributor_code = t.distributor_code
      and r.client_code = t.customer_code
      and r.brick_id is distinct from t.brick_id
      and (p_periods is null or r.invoice_period = any (p_periods))
    returning r.batch_id
  )
  select count(*), coalesce(array_agg(distinct batch_id), '{}'::uuid[])
    into v_rows, v_batches
  from updated;

  if array_length(v_batches, 1) is not null then
    foreach v_batch in array v_batches loop
      perform public.phx_refresh_sos_fact_rollup(v_batch);
      perform public.phx_refresh_sos_customer_directory_rollup(v_batch);
      perform public.phx_refresh_marketing_roi_facts(v_batch);
      perform public.phx_refresh_sos_channel_rollup(v_batch);
      -- Distributor×product rollup — same per-batch trio site as the channel rollup.
      perform public.phx_refresh_sos_distributor_product_rollup(v_batch);
      -- Monthly attribution rollup — same per-batch trio site as the channel rollup.
      perform public.phx_refresh_monthly_attribution(v_batch);
      v_refreshed := v_refreshed + 1;
    end loop;
  end if;

  return query select v_rows, v_refreshed;
end;
$function$;

-- 5c. Fact-only bulk maintenance loop — extend it to keep the DP rollup in lock-step, closing the
--     fact-only-refresh staleness vector.
create or replace function public.phx_backfill_sos_fact_rollup()
  returns void
  language plpgsql
  security definer
  set search_path to 'public'
as $function$
declare
  rec record;
begin
  for rec in
    select id
    from public.source_of_sales_import_batches
    where status = 'validated' and period is not null
  loop
    perform public.phx_refresh_sos_fact_rollup(rec.id);
    perform public.phx_refresh_sos_channel_rollup(rec.id);
    -- Distributor×product rollup — closes the fact-only-refresh staleness vector.
    perform public.phx_refresh_sos_distributor_product_rollup(rec.id);
    -- Monthly attribution rollup — closes the fact-only-refresh staleness vector.
    perform public.phx_refresh_monthly_attribution(rec.id);
  end loop;
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- 6. Rewrite phx_closing_distributor_product to read the rollup. Same signature, same measures,
--    factory_price joined LIVE. Within a (distributor, region, area, product) group every row shares
--    one product_code, so Σ(eff_units × price) = price × Σ(eff_units) — byte-identical to the live
--    Σ(effective_units × price). product_name = max, exactly as before.
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.phx_closing_distributor_product(p_line text, p_period text)
  returns table(distributor_code text, region_code text, area_code text, product_code text,
                product_name text, units numeric, value numeric)
  language sql
  stable parallel safe security definer
  set search_path to 'public'
  set statement_timeout to '45s'
as $function$
  select
    r.distributor_code,
    r.region_code,
    r.area_code,
    r.product_code,
    max(r.product_name)                                     as product_name,
    sum(r.units_qty)                                        as units,
    sum(r.eff_units * coalesce(p.factory_price, 0))         as value
  from public.source_of_sales_distributor_product_rollup r
  left join public.source_of_sales_products p
    on upper(btrim(p.product_code)) = upper(btrim(r.product_code))
  where r.period = p_period
    and r.line_key = lower(btrim(p_line))
  group by r.distributor_code, r.region_code, r.area_code, r.product_code;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- 7. Grants. A new public SECURITY DEFINER function inherits EXECUTE for PUBLIC (anon/authenticated
--    are members), so revoke it and re-grant to service_role only — for the new refresh function and
--    the rewritten read function alike. (finalize/sync/backfill keep their existing ACLs; CREATE OR
--    REPLACE does not reset grants.)
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
revoke execute on function public.phx_refresh_sos_distributor_product_rollup(uuid) from public, anon, authenticated;
grant execute on function public.phx_refresh_sos_distributor_product_rollup(uuid) to service_role;

revoke execute on function public.phx_closing_distributor_product(text, text) from public, anon, authenticated;
grant execute on function public.phx_closing_distributor_product(text, text) to service_role;

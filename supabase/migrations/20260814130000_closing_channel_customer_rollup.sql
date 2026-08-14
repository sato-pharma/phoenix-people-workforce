-- Precompute the Monthly-Closing channel totals into a refreshable per-customer rollup.
--
-- WHY. public.phx_closing_channel_totals is one of production's heaviest queries (152 calls,
-- 665 s total, up to 16.5 s each). A fresh EXPLAIN(ANALYZE,BUFFERS) of the heaviest realistic call
-- (CNS, 8 months, real stems) measured 3,715 ms, ~2.3 s of which is the "folded" build: the retail
-- scan of source_of_sales_fact_rollup, its "today's name" join to the customer directory rollup,
-- the factory-price join, and the per-customer aggregate. That work does NOT depend on the owner's
-- keyword / override lists, so it can be precomputed once per batch. The classifier and the
-- distinct-customer count STAY live, so the owner's invariant — editing customer-channel.ts
-- reclassifies all history instantly — is preserved. The channel VERDICT is never baked.
--
-- WHAT. A new table source_of_sales_channel_customer_rollup holds one row per
-- (batch, official_line, period, distributor, client_code) for retail and one row per
-- (batch, period, folded direct customer) for direct orders, carrying the resolved "today's" name,
-- its fold, and money + row COUNTS split into two product buckets: everything (*_all) and just the
-- three restricted codes LA003/LA004/SS001 (*_restricted). The two report variants are then served
-- by arithmetic — non-restricted = *_all − *_restricted, includeRestricted = *_all — with NO second
-- scan. Presence is decided on the row COUNT, never on money (value is coalesce(factory_price,0), so
-- a present customer can legitimately sum to 0), which reproduces the current function's behaviour
-- exactly: a customer whose entire purchase is restricted product disappears from the non-restricted
-- view.
--
-- KEYED PER BATCH, exactly like source_of_sales_fact_rollup: each batch owns its rows
-- (batch_id … on delete cascade), refresh is delete-by-batch + reinsert, superseded batches
-- self-clean via the cascade, and there is no cross-batch write race. The read function aggregates
-- across a slice's batches. Because finalize supersedes sibling batches for the same
-- (distributor, period), a retail customer's (distributor, client_code) money lives in exactly one
-- batch, so per-batch storage never splits it. Direct customers may span batches; the read's
-- count(distinct client_key) + sum() reunites them, identical to the live GROUP BY.
--
-- Proven output-identical to the live function on staging (Phoenix-HR-Staging, cifwmndunmlxjhyjugxa)
-- across every (line, period) × both variants, both EXCEPT directions = zero rows different,
-- including the Head Office restricted-only presence edge (46,897 → 158 customers, matched exactly).

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- 1. The rollup table
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
create table if not exists public.source_of_sales_channel_customer_rollup (
  id                bigint generated always as identity primary key,
  batch_id          uuid    not null references public.source_of_sales_import_batches(id) on delete cascade,
  -- Slice keys. line_key is the folded official line the read filters on; official_line is a
  -- representative display value the lock guard folds. Both stay nullable so a fact row with no
  -- line still rolls up harmlessly (it can never match a real p_line query).
  line_key          text,
  official_line     text,
  period            text,
  distributor_code  text,               -- null for direct orders
  client_code       text,               -- null for direct orders and for retail rows with no code
  client_key        text,               -- retail: client_code · direct: 'name:'||fold(name) or null
  client_name       text    not null default '',   -- resolved "today's" name, '' when none
  folded_name       text    not null default '',   -- phx_fold_customer_name(client_name), the classifier input
  no_client_code    boolean not null default false, -- retail rows that carry no client code
  is_direct         boolean not null default false,
  -- Two product buckets. The non-restricted variant is the difference, the include variant is *_all.
  units_all         numeric not null default 0,
  value_all         numeric not null default 0,
  rows_all          integer not null default 0,
  units_restricted  numeric not null default 0,
  value_restricted  numeric not null default 0,
  rows_restricted   integer not null default 0
);

-- The read path: filter (line_key, period) then aggregate.
create index if not exists source_of_sales_channel_customer_rollup_line_period_idx
  on public.source_of_sales_channel_customer_rollup (line_key, period);
-- The per-batch delete in the refresh function.
create index if not exists source_of_sales_channel_customer_rollup_batch_idx
  on public.source_of_sales_channel_customer_rollup (batch_id);

-- Same posture as the sibling rollups: RLS on, one service_role ALL policy, no anon/authenticated.
-- Every read of this table goes through the SECURITY DEFINER function below, never the browser.
alter table public.source_of_sales_channel_customer_rollup enable row level security;

create policy source_of_sales_channel_customer_rollup_service_role_all
  on public.source_of_sales_channel_customer_rollup
  for all to service_role using (true) with check (true);

grant select, insert, update, delete, references, trigger, truncate
  on table public.source_of_sales_channel_customer_rollup to service_role;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- 2. The per-batch refresh — the SAME query the initial backfill uses, so history cannot diverge
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.phx_refresh_sos_channel_rollup(p_batch_id uuid)
  returns void
  language plpgsql
  security definer
  set search_path to 'public'
  set statement_timeout to '120s'
as $function$
begin
  -- This batch owns exactly its own rows, like source_of_sales_fact_rollup.
  delete from public.source_of_sales_channel_customer_rollup where batch_id = p_batch_id;

  insert into public.source_of_sales_channel_customer_rollup
    (batch_id, line_key, official_line, period, distributor_code, client_code, client_key,
     client_name, folded_name, no_client_code, is_direct,
     units_all, value_all, rows_all, units_restricted, value_restricted, rows_restricted)
  with
  -- "Today's" name, newest wins within the slice, exactly as the live function resolves it —
  -- scoped to THIS batch's directory rows (one validated batch per distributor+period, so this is
  -- the same set the global newest-wins would pick), and NEVER narrowed by product.
  names as (
    select distinct on (lower(btrim(d.official_line)), d.period, d.distributor_code, d.client_code)
      lower(btrim(d.official_line)) as line_key,
      d.period, d.distributor_code, d.client_code, d.client_name
    from public.source_of_sales_customer_directory_rollup d
    where d.batch_id = p_batch_id
    order by lower(btrim(d.official_line)), d.period, d.distributor_code, d.client_code,
             d.latest_row_created_at desc
  ),
  -- Retail = distributor sell-out. Same source, guards and value formula as phx_closing_customers.
  -- No `client_code is not null` filter: a code-less row is money the closing published, carried and
  -- bucketed as unidentified downstream.
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
      sum(f.effective_units * coalesce(p.factory_price, 0))  as value_all,
      count(*)                                               as rows_all,
      coalesce(sum(f.total_qty)
        filter (where upper(btrim(coalesce(f.product_code, ''))) = any (array['LA003','LA004','SS001'])), 0) as units_restricted,
      coalesce(sum(f.effective_units * coalesce(p.factory_price, 0))
        filter (where upper(btrim(coalesce(f.product_code, ''))) = any (array['LA003','LA004','SS001'])), 0) as value_restricted,
      count(*)
        filter (where upper(btrim(coalesce(f.product_code, ''))) = any (array['LA003','LA004','SS001']))     as rows_restricted
    from public.source_of_sales_fact_rollup f
    join public.source_of_sales_import_batches b
      on b.id = f.batch_id and b.status = 'validated'
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
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
  -- Direct orders carry no client_code; the import rows are the only place the customer survives.
  -- value IS the published direct_value, not a re-derivation. Grain matches the live function's
  -- `group by invoice_period, client_key, client_name`.
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
    perform public.phx_refresh_sos_channel_rollup(rec.id);
  end loop;
end;
$backfill$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- 4. The monthly-closing lock guard, same as the three sibling closing tables. A refresh of a locked
--    (period, official_line) is rejected — and its import_rows are frozen too, so no legitimate
--    refresh ever targets one.
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
create trigger trg_lock_guard_ins
  after insert on public.source_of_sales_channel_customer_rollup
  referencing new table as new_rows for each statement
  execute function public.phx_reject_write_to_locked_closing('period', 'official_line');

create trigger trg_lock_guard_upd
  after update on public.source_of_sales_channel_customer_rollup
  referencing old table as old_rows new table as new_rows for each statement
  execute function public.phx_reject_write_to_locked_closing('period', 'official_line');

create trigger trg_lock_guard_del
  after delete on public.source_of_sales_channel_customer_rollup
  referencing old table as old_rows for each statement
  execute function public.phx_reject_write_to_locked_closing('period', 'official_line');

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- 5. Wire the channel refresh into every server-side refresh path, AFTER fact+directory so the baked
--    name is always the one the live function would resolve. CREATE OR REPLACE reproduces each body
--    verbatim with a single added call — no other behaviour changes.
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

  -- Period-lock TOCTOU close: re-check the lock under the advisory lock, atomically with the mutation
  -- below. A period locked after the caller's early application-layer check must still block finalize.
  if to_regclass('public.monthly_sales_period_lock') is not null
     and exists (
       select 1 from public.monthly_sales_period_lock
       where period = p_period and locked = true
     ) then
    raise exception 'Period % is locked -- uploads and finalization are frozen until it is reopened.', p_period
      using errcode = '55P03';
  end if;

  -- Capture what we're about to supersede so the caller can audit-log it (same shape
  -- the old supersedeExistingSalesBatches() TS helper captured before deleting).
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
  -- Channel totals rollup — reads the two rollups just refreshed above, so it must run after them.
  perform public.phx_refresh_sos_channel_rollup(p_batch_id);

  -- Self-check: zero silent row loss between raw rows and the fact-rollup grain.
  -- A checked invariant on every single upload, not an assumption.
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
  -- 1) Re-stamp import rows to today's geography (identical column logic to
  --    phx_sync_sos_restamp_import_rows / sos_reconcile_import_rows_from_customer_map).
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

  -- 2) Rebuild the canonical refresh trio for exactly the touched batches, in the SAME
  --    transaction as the re-stamp above.
  if array_length(v_batches, 1) is not null then
    foreach v_batch in array v_batches loop
      perform public.phx_refresh_sos_fact_rollup(v_batch);
      perform public.phx_refresh_sos_customer_directory_rollup(v_batch);
      perform public.phx_refresh_marketing_roi_facts(v_batch);
      -- Channel totals rollup — after fact+directory, same as every other refresh path.
      perform public.phx_refresh_sos_channel_rollup(v_batch);
      v_refreshed := v_refreshed + 1;
    end loop;
  end if;

  return query select v_rows, v_refreshed;
end;
$function$;

-- 5c. Fact-only bulk maintenance loop — extend it to keep the channel rollup in lock-step. The baked
--     name comes from whatever the directory rollup currently holds, which is exactly what the live
--     function would read, so this never diverges from live even if the directory is not re-run here.
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
  end loop;
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- 6. Rewrite phx_closing_channel_totals to read the rollup. Everything from the classifier onward is
--    byte-for-byte the live logic (CASE branch ordering, distinct-customer count, __population__
--    self-check). Only the source of the folded rows changes: precomputed money + name instead of a
--    live scan. The exclude set is guarded because the rollup only carries the two known buckets.
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.phx_closing_channel_totals(
  p_line text,
  p_periods text[],
  p_store_stems text[],
  p_hospital_stems text[],
  p_exclude_codes text[] DEFAULT ARRAY['LA003'::text, 'LA004'::text, 'SS001'::text],
  p_pharmacy_override_codes text[] DEFAULT '{}'::text[],
  p_store_override_codes text[] DEFAULT '{}'::text[]
)
  returns TABLE(period text, channel text, customers bigint, units numeric, value numeric)
  language plpgsql
  stable parallel safe security definer
  set search_path to 'public'
  set statement_timeout to '60s'
as $function$
declare
  v_include_all boolean;
begin
  -- The rollup carries only two product buckets: everything (*_all) and the three restricted codes
  -- (*_restricted). The one caller (loadMonthlyClosingChannelComparison) ever passes exactly [] or
  -- {LA003,LA004,SS001}. Any other exclude set cannot be served from two buckets, so refuse it
  -- loudly rather than return wrong money.
  if coalesce(cardinality(p_exclude_codes), 0) = 0 then
    v_include_all := true;
  elsif (
    select coalesce(array_agg(distinct upper(btrim(x)) order by upper(btrim(x))), '{}'::text[])
    from unnest(p_exclude_codes) as x
  ) = array['LA003', 'LA004', 'SS001']::text[] then
    v_include_all := false;
  else
    raise exception
      'phx_closing_channel_totals: p_exclude_codes must be empty or exactly {LA003,LA004,SS001}; got %', p_exclude_codes
      using errcode = '22023';
  end if;

  return query
  with
  base as (
    select
      r.period,
      r.client_key,
      r.distributor_code,
      r.client_name,
      r.folded_name,
      r.no_client_code,
      r.is_direct,
      case when v_include_all then r.units_all else r.units_all - r.units_restricted end as units,
      case when v_include_all then r.value_all else r.value_all - r.value_restricted end as value,
      case when v_include_all then r.rows_all  else r.rows_all  - r.rows_restricted  end as rows_kept
    from public.source_of_sales_channel_customer_rollup r
    where r.line_key = lower(btrim(p_line))
      and r.period = any (p_periods)
  ),
  -- Presence on ROW COUNT, not money: a customer whose whole purchase is restricted leaves no
  -- non-restricted row and must not be counted, even though a present customer's value can be 0.
  folded as (
    select b.* from base b where b.rows_kept > 0
  ),
  tagged as (
    select
      u.period,
      u.client_key,
      u.units,
      u.value,
      case
        -- The three "this is not a channel" answers come FIRST, before the classifier whose own
        -- fallback is "pharmacy" — a fallback must never catch money whose customer is unknown.
        when u.is_direct and btrim(u.client_name) = '' then 'direct_unnamed'
        when u.no_client_code then 'unidentified_no_code'
        when btrim(u.client_name) = '' then 'unidentified_no_name'
        -- Hospital wins the overlap, matching classifyCustomerChannel().
        when exists (
          select 1 from unnest(coalesce(p_hospital_stems, '{}'::text[])) s
          where s <> '' and u.folded_name like '%' || s || '%'
        ) then 'hospital'
        -- The owner's rulings beat the keyword, both directions. A store override is keyed by
        -- distributor + client code because a client code can recur under another distributor.
        when exists (
          select 1 from unnest(coalesce(p_pharmacy_override_codes, '{}'::text[])) c
          where c <> ''
            and ltrim(btrim(u.client_key), '0') = ltrim(btrim(c), '0')
        ) then 'pharmacy'
        when exists (
          select 1 from unnest(coalesce(p_store_override_codes, '{}'::text[])) c
          where c <> ''
            and upper(btrim(u.distributor_code)) = upper(btrim(split_part(c, '|', 1)))
            and ltrim(btrim(u.client_key), '0') = ltrim(btrim(split_part(c, '|', 2)), '0')
        ) then 'store'
        when exists (
          select 1 from unnest(coalesce(p_store_stems, '{}'::text[])) s
          where s <> '' and u.folded_name like '%' || s || '%'
        ) then 'store'
        else 'pharmacy'
      end as channel
    from folded u
  ),
  channels as (
    select
      t.period,
      t.channel,
      -- DISTINCT customer, never a row count: a pharmacy buying from three distributors is one.
      count(distinct t.client_key) as customers,
      sum(t.units)                 as units,
      sum(t.value)                 as value
    from tagged t
    group by t.period, t.channel
  ),
  -- Independent self-check: the month's own population, summed straight from the same rollup rows.
  -- A present-customer filter drift would show here as a difference the sheet prints in red.
  population as (
    select b.period, sum(b.units) as units, sum(b.value) as value
    from base b
    group by b.period
  )
  select c.period, c.channel, c.customers, c.units, c.value from channels c
  union all
  select p.period, '__population__'::text, 0::bigint, p.units, p.value from population p;
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- 7. Grants. A new public SECURITY DEFINER function inherits EXECUTE for PUBLIC (anon/authenticated
--    are members), so revoke it and re-grant to service_role only — for the new refresh function and
--    the rewritten read function alike. (finalize/sync/backfill keep their existing ACLs; CREATE OR
--    REPLACE does not reset grants.)
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
revoke execute on function public.phx_refresh_sos_channel_rollup(uuid) from public, anon, authenticated;
grant execute on function public.phx_refresh_sos_channel_rollup(uuid) to service_role;

revoke execute on function public.phx_closing_channel_totals(text, text[], text[], text[], text[], text[], text[]) from public, anon, authenticated;
grant execute on function public.phx_closing_channel_totals(text, text[], text[], text[], text[], text[], text[]) to service_role;

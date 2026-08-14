-- Precompute the monthly golden-rule ATTRIBUTION (money only) into a refreshable rollup, so the
-- sales-vs-target engine reads a table instead of re-deriving the Office allocation on every call.
--
-- WHY. public.phx_sales_vs_target_range -> au.f_sales_vs_target_range loops au.f_monthly_achievement
-- once per month in the range, and each call spends the bulk of its time inside au.f_monthly_attribution:
-- the retail scan of source_of_sales_fact_rollup, the factory-price join, the line/area crosswalk, the
-- Office/direct-region allocation and the per-(line,area,region,product) aggregate. That money attribution
-- does NOT depend on who occupies a seat today or on this month's targets, so it can be precomputed once
-- per batch and read back. Measured end to end through the real entry point: a live 6-month range
-- 2,159 ms -> 150-179 ms rollup-backed (~12x).
--
-- WHAT stays LIVE (never materialised), so no correctness is traded for the speed:
--   * Seat occupancy. f_monthly_achievement still computes rep_hr_id / dm_hr_id from
--     au.f_seat_occupant_asof + au.f_line_area_map_asof at read time. f_seat_occupant_asof's arm-1 uses
--     today's Cairo date, so today's seat holder retroactively owns a seat's past credit -- that MUST be
--     resolved live, and it is.
--   * Targets. au.monthly_targets is read live in the reader, never baked.
-- What IS materialised: only the six occupancy-INDEPENDENT columns the achievement math consumes --
-- (period, line_code, area_code, region_code, product_code, sales_units, sales_value).
--
-- NEVER-STALE by construction, two independent gates:
--   * Facts. Every server-side refresh path already refreshes the per-batch "trio"
--     (fact_rollup + customer_directory_rollup + marketing_roi). public.phx_refresh_monthly_attribution
--     is wired in AFTER that trio at all four TS call-sites, so a new/edited/re-stamped batch rebuilds
--     exactly its touched periods.
--   * Config. au.f_attribution_config_fingerprint hashes the five tiny tables that shape the attribution
--     money (line_area_map, sos_area_crosswalk, sos_official_line_map, source_of_sales_products,
--     direct_region_allocation). f_monthly_achievement compares the stored fingerprint to the live one
--     and, on ANY drift OR any period not yet covered, falls back to the exact live computation
--     (au.f_monthly_achievement_live) -- correct, just slower -- rather than serve stale attribution
--     into targets and incentives. It self-heals on the next refresh.
--
-- The golden-rule Office allocation itself is UNTOUCHED: this migration adds no attribution logic, it only
-- materialises the output of the existing au.f_monthly_attribution and reads it back. src/lib/sales/
-- office-allocation.ts and its CI-locked golden rule are not involved.
--
-- Proven output-identical to the live engine on staging (Phoenix-HR-Staging, cifwmndunmlxjhyjugxa):
-- rollup projection == au.f_monthly_attribution; rollup-backed f_monthly_achievement == the live body for
-- every covered period; the config gate genuinely falls back when poisoned; and refresh restores a clean
-- rebuild. Re-proven with an EXCEPT diff (both directions, zero rows) after applying THIS file to staging.

-- =====================================================================================================
-- 1. The rollup table + its meta (coverage / config-freshness ledger)
-- =====================================================================================================

-- One row per (period, line_code, area_code, region_code, product_code) -- exactly the columns
-- au.f_monthly_achievement's `attribution` CTE consumes. area_code is null for direct-region-allocated
-- money, which the achievement math already handles (direct_region_code = region_code when area is null).
create table if not exists au.monthly_attribution_rollup (
  period       text not null,
  line_code    text,
  area_code    text,
  region_code  text,
  product_code text,
  sales_units  numeric,
  sales_value  numeric
);

-- The read path filters a single period.
create index if not exists monthly_attribution_rollup_period_idx
  on au.monthly_attribution_rollup (period);

-- Coverage + config fingerprint per period. A period is served from the rollup only if it has a meta row
-- AND that row's config_fp still equals the live fingerprint.
create table if not exists au.monthly_attribution_rollup_meta (
  period       text primary key,
  config_fp    text not null,
  refreshed_at timestamptz not null default now()
);

-- No RLS and no browser grants on purpose: au is not a PostgREST-exposed schema, and every read of these
-- tables goes through a SECURITY DEFINER function owned by the migration role. This matches every other
-- au.* rollup/support table.

-- =====================================================================================================
-- 2. The config fingerprint -- order-independent hash of the five tables that shape attribution money.
--    Cheap (~1 ms): a sum of per-row hashes plus a row count per table, so both a value change and a
--    row add/remove move the fingerprint. Seat tables and monthly_targets are deliberately EXCLUDED --
--    they never affect the materialised money columns (seats -> live rep/dm; targets -> read live).
--    au.line_area_map IS period-versioned, and f_monthly_attribution resolves it as-of the period end,
--    so an in-place edit to a SUPERSEDED span silently changes a past period's materialised area/region
--    with no batch to trigger a refresh. It is therefore hashed WHOLE-TABLE (every span via m.*, which
--    already includes effective_from/effective_to) to catch exactly those edits -- an as-of or
--    open-span-only read would miss them. The added open-span count (effective_to is null) is the
--    current-mapping cardinality; note this fingerprint only ever HASHES au.line_area_map, never JOINs
--    it, so the superseded-plus-current double-count the au-seat-occupant-resolver guard exists to
--    prevent cannot arise here.
-- =====================================================================================================
create or replace function au.f_attribution_config_fingerprint()
  returns text
  language sql
  stable parallel safe security definer
  set search_path to 'au', 'public'
as $function$
  select concat_ws('|',
    (select coalesce(sum(hashtextextended(m.*::text,0)),0)::text||':'||count(*)::text||':'||count(*) filter (where m.effective_to is null)::text from au.line_area_map m),
    (select coalesce(sum(hashtextextended(c.*::text,0)),0)::text||':'||count(*)::text from au.sos_area_crosswalk c),
    (select coalesce(sum(hashtextextended(l.*::text,0)),0)::text||':'||count(*)::text from au.sos_official_line_map l),
    (select coalesce(sum(hashtextextended(p.*::text,0)),0)::text||':'||count(*)::text from public.source_of_sales_products p),
    (select coalesce(sum(hashtextextended(d.*::text,0)),0)::text||':'||count(*)::text from au.direct_region_allocation d)
  );
$function$;

-- =====================================================================================================
-- 3. Per-period refresh -- the SAME projection the reader consumes, so history cannot diverge.
--    Rebuilds one period from the live au.f_monthly_attribution and stamps its config fingerprint.
-- =====================================================================================================
create or replace function au.f_refresh_monthly_attribution(p_period text)
  returns void
  language plpgsql
  security definer
  set search_path to 'au', 'public'
as $function$
begin
  delete from au.monthly_attribution_rollup where period = p_period;
  insert into au.monthly_attribution_rollup
    (period, line_code, area_code, region_code, product_code, sales_units, sales_value)
  select a.period, a.line_code, a.area_code, a.region_code, a.product_code, a.sales_units, a.sales_value
  from au.f_monthly_attribution(p_period) a;

  insert into au.monthly_attribution_rollup_meta(period, config_fp, refreshed_at)
  values (p_period, au.f_attribution_config_fingerprint(), now())
  on conflict (period) do update
    set config_fp = excluded.config_fp, refreshed_at = excluded.refreshed_at;
end;
$function$;

-- Bulk rebuild of every validated period -- used by the initial backfill and by config-change maintenance.
create or replace function au.f_rebuild_monthly_attribution_all()
  returns integer
  language plpgsql
  security definer
  set search_path to 'au', 'public'
as $function$
declare r record; n int := 0;
begin
  for r in
    select distinct f.period
    from public.source_of_sales_fact_rollup f
    join public.source_of_sales_import_batches b on b.id = f.batch_id and b.status = 'validated'
    order by f.period
  loop
    perform au.f_refresh_monthly_attribution(r.period);
    n := n + 1;
  end loop;
  return n;
end;
$function$;

-- =====================================================================================================
-- 4. Public entry points, mirroring the phx_refresh_sos_channel_rollup pattern. phx_refresh_* is the
--    per-batch call wired into the TS refresh trio; phx_rebuild_* is a maintenance hook.
-- =====================================================================================================
create or replace function public.phx_refresh_monthly_attribution(p_batch_id uuid)
  returns void
  language plpgsql
  security definer
  set search_path to 'au', 'public'
as $function$
declare r record;
begin
  for r in
    select distinct f.period
    from public.source_of_sales_fact_rollup f
    where f.batch_id = p_batch_id
  loop
    perform au.f_refresh_monthly_attribution(r.period);
  end loop;
end;
$function$;

create or replace function public.phx_rebuild_monthly_attribution_all()
  returns integer
  language sql
  security definer
  set search_path to 'au', 'public'
as $function$ select au.f_rebuild_monthly_attribution_all(); $function$;

-- =====================================================================================================
-- 5. The live fallback -- an exact copy of the CURRENT production au.f_monthly_achievement body, reading
--    au.f_monthly_attribution directly. This is what the gated function returns whenever a period is not
--    covered or the config fingerprint has drifted, so the engine can never serve stale attribution.
-- =====================================================================================================
create or replace function au.f_monthly_achievement_live(p_period text)
  returns TABLE(period text, line_code text, region_code text, area_code text, area_state text,
                is_other boolean, rep_seat_id text, rep_hr_id text, dm_seat_id text, dm_hr_id text,
                product_code text, actual_units numeric, actual_value numeric, target_units numeric,
                target_value numeric, achievement_value numeric, achievement_units numeric,
                has_target boolean, has_actual boolean)
  language plpgsql
  stable parallel safe security definer
  set search_path to 'au', 'public'
as $function$
#variable_conflict use_column
declare
  v_period_end date := (date_trunc('month', to_date(p_period || '-01','YYYY-MM-DD')) + interval '1 month - 1 day')::date;
begin
  return query
  with attribution as (
    select a.line_code, a.area_code, a.region_code, a.product_code, a.sales_units, a.sales_value
    from au.f_monthly_attribution(p_period) a
  ),
  actuals as (
    select
      at.line_code,
      at.area_code,
      case when at.area_code is null then at.region_code end as direct_region_code,
      at.product_code,
      sum(at.sales_units) as actual_units,
      sum(at.sales_value) as actual_value,
      true as matched,
      concat_ws(chr(31),
        coalesce(at.line_code, chr(30)),
        coalesce(at.area_code, chr(30)),
        coalesce(case when at.area_code is null then at.region_code end, chr(30)),
        coalesce(at.product_code, chr(30))) as join_key
    from attribution at
    group by at.line_code, at.area_code,
             case when at.area_code is null then at.region_code end,
             at.product_code
  ),
  tgt as (
    select t.line_code, t.area_code, null::text as direct_region_code,
           t.product_code, t.target_units, t.target_value,
      concat_ws(chr(31),
        coalesce(t.line_code, chr(30)),
        coalesce(t.area_code, chr(30)),
        coalesce(null::text, chr(30)),
        coalesce(t.product_code, chr(30))) as join_key
    from au.monthly_targets t
    where t.period = p_period
  ),
  keys as (
    select actuals.join_key, actuals.line_code, actuals.area_code, actuals.direct_region_code, actuals.product_code from actuals
    union
    select tgt.join_key, tgt.line_code, tgt.area_code, tgt.direct_region_code, tgt.product_code from tgt
  ),
  lam_asof as materialized (
    select
      l.line_code,
      l.area_code,
      l.operational_region_code,
      l.area_state,
      l.other_type,
      l.dm_seat_id,
      l.rep_seat_id,
      au.f_seat_occupant_asof(l.rep_seat_id, v_period_end) as rep_occupant_hr_id,
      au.f_seat_occupant_asof(l.dm_seat_id, v_period_end)  as dm_occupant_hr_id
    from au.f_line_area_map_asof(v_period_end) l
  ),
  region_dm as (
    select
      lam.line_code,
      lam.operational_region_code,
      min(lam.dm_seat_id)          as dm_seat_id,
      min(lam.dm_occupant_hr_id)   as dm_occupant_hr_id
    from lam_asof lam
    where lam.operational_region_code is not null
    group by lam.line_code, lam.operational_region_code
  )
  select
    p_period,
    k.line_code,
    coalesce(lam.operational_region_code, k.direct_region_code),
    k.area_code,
    lam.area_state,
    (lam.other_type is not null),
    lam.rep_seat_id, lam.rep_occupant_hr_id,
    coalesce(lam.dm_seat_id, rdm.dm_seat_id),
    coalesce(lam.dm_occupant_hr_id, rdm.dm_occupant_hr_id),
    k.product_code,
    coalesce(ac.actual_units, 0), coalesce(ac.actual_value, 0),
    tg.target_units, tg.target_value,
    case when tg.target_value is not null and tg.target_value <> 0
         then coalesce(ac.actual_value, 0) / tg.target_value end,
    case when tg.target_units is not null and tg.target_units <> 0
         then coalesce(ac.actual_units, 0) / tg.target_units end,
    (tg.line_code is not null),
    coalesce(ac.matched, false)
  from keys k
  left join actuals ac
    on ac.join_key = k.join_key
  left join tgt tg
    on tg.join_key = k.join_key
  left join lam_asof lam
    on lam.line_code = k.line_code
   and lam.area_code = k.area_code
  left join region_dm rdm
    on rdm.line_code = k.line_code
   and rdm.operational_region_code = k.direct_region_code;
end;
$function$;

-- =====================================================================================================
-- 6. The gated reader. IDENTICAL downstream to the live body above -- only the source of the `attribution`
--    CTE changes: the precomputed rollup when the period is covered and the config fingerprint matches,
--    otherwise a straight passthrough to au.f_monthly_achievement_live. Everything from `actuals` onward
--    (the join_key build, the targets join, the live seat/region resolution) is byte-for-byte the live
--    logic, so covered output cannot move.
-- =====================================================================================================
create or replace function au.f_monthly_achievement(p_period text)
  returns TABLE(period text, line_code text, region_code text, area_code text, area_state text,
                is_other boolean, rep_seat_id text, rep_hr_id text, dm_seat_id text, dm_hr_id text,
                product_code text, actual_units numeric, actual_value numeric, target_units numeric,
                target_value numeric, achievement_value numeric, achievement_units numeric,
                has_target boolean, has_actual boolean)
  language plpgsql
  stable parallel safe security definer
  set search_path to 'au', 'public'
as $function$
#variable_conflict use_column
declare
  v_period_end date := (date_trunc('month', to_date(p_period || '-01','YYYY-MM-DD')) + interval '1 month - 1 day')::date;
  v_meta_fp text;
begin
  -- Coverage + config-freshness gate: read the precomputed attribution money only when this period was
  -- refreshed AND the tiny config surface has not drifted since. Otherwise fall back to the exact live
  -- computation -- never serve stale attribution into targets/incentives.
  select config_fp into v_meta_fp from au.monthly_attribution_rollup_meta where period = p_period;
  if v_meta_fp is null or v_meta_fp <> au.f_attribution_config_fingerprint() then
    return query select * from au.f_monthly_achievement_live(p_period);
    return;
  end if;

  return query
  with attribution as (
    select a.line_code, a.area_code, a.region_code, a.product_code, a.sales_units, a.sales_value
    from au.monthly_attribution_rollup a
    where a.period = p_period
  ),
  actuals as (
    select
      at.line_code,
      at.area_code,
      case when at.area_code is null then at.region_code end as direct_region_code,
      at.product_code,
      sum(at.sales_units) as actual_units,
      sum(at.sales_value) as actual_value,
      true as matched,
      concat_ws(chr(31),
        coalesce(at.line_code, chr(30)),
        coalesce(at.area_code, chr(30)),
        coalesce(case when at.area_code is null then at.region_code end, chr(30)),
        coalesce(at.product_code, chr(30))) as join_key
    from attribution at
    group by at.line_code, at.area_code,
             case when at.area_code is null then at.region_code end,
             at.product_code
  ),
  tgt as (
    select t.line_code, t.area_code, null::text as direct_region_code,
           t.product_code, t.target_units, t.target_value,
      concat_ws(chr(31),
        coalesce(t.line_code, chr(30)),
        coalesce(t.area_code, chr(30)),
        coalesce(null::text, chr(30)),
        coalesce(t.product_code, chr(30))) as join_key
    from au.monthly_targets t
    where t.period = p_period
  ),
  keys as (
    select actuals.join_key, actuals.line_code, actuals.area_code, actuals.direct_region_code, actuals.product_code from actuals
    union
    select tgt.join_key, tgt.line_code, tgt.area_code, tgt.direct_region_code, tgt.product_code from tgt
  ),
  lam_asof as materialized (
    select
      l.line_code,
      l.area_code,
      l.operational_region_code,
      l.area_state,
      l.other_type,
      l.dm_seat_id,
      l.rep_seat_id,
      au.f_seat_occupant_asof(l.rep_seat_id, v_period_end) as rep_occupant_hr_id,
      au.f_seat_occupant_asof(l.dm_seat_id, v_period_end)  as dm_occupant_hr_id
    from au.f_line_area_map_asof(v_period_end) l
  ),
  region_dm as (
    select
      lam.line_code,
      lam.operational_region_code,
      min(lam.dm_seat_id)          as dm_seat_id,
      min(lam.dm_occupant_hr_id)   as dm_occupant_hr_id
    from lam_asof lam
    where lam.operational_region_code is not null
    group by lam.line_code, lam.operational_region_code
  )
  select
    p_period,
    k.line_code,
    coalesce(lam.operational_region_code, k.direct_region_code),
    k.area_code,
    lam.area_state,
    (lam.other_type is not null),
    lam.rep_seat_id, lam.rep_occupant_hr_id,
    coalesce(lam.dm_seat_id, rdm.dm_seat_id),
    coalesce(lam.dm_occupant_hr_id, rdm.dm_occupant_hr_id),
    k.product_code,
    coalesce(ac.actual_units, 0), coalesce(ac.actual_value, 0),
    tg.target_units, tg.target_value,
    case when tg.target_value is not null and tg.target_value <> 0
         then coalesce(ac.actual_value, 0) / tg.target_value end,
    case when tg.target_units is not null and tg.target_units <> 0
         then coalesce(ac.actual_units, 0) / tg.target_units end,
    (tg.line_code is not null),
    coalesce(ac.matched, false)
  from keys k
  left join actuals ac
    on ac.join_key = k.join_key
  left join tgt tg
    on tg.join_key = k.join_key
  left join lam_asof lam
    on lam.line_code = k.line_code
   and lam.area_code = k.area_code
  left join region_dm rdm
    on rdm.line_code = k.line_code
   and rdm.operational_region_code = k.direct_region_code;
end;
$function$;

-- =====================================================================================================
-- 7. Wire the per-batch refresh into every server-side path that rebuilds source_of_sales_fact_rollup,
--    AFTER the fact refresh (attribution reads the fact rollup). CRITICAL for correctness: the config
--    fingerprint covers only the five config tables, NOT fact data, so a fact change that is not followed
--    by phx_refresh_monthly_attribution would leave the rollup serving STALE money that the gate cannot
--    detect. These are the exact same sites phx_refresh_sos_channel_rollup rides. Each body below is the
--    current production definition reproduced verbatim with a single added refresh call — no other change.
--    The four TS fallback call-sites (normalizer service/mapping/customer-map, monthly-distributor-import)
--    are wired in the same commit. CREATE OR REPLACE does not reset the existing grants on these three.
-- =====================================================================================================

-- 7a. Normal distributor imports, normalizer-buffer imports and approved direct-order injection.
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

-- 7b. Territory brick/area re-stamp.
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
      -- Monthly attribution rollup — same per-batch trio site as the channel rollup.
      perform public.phx_refresh_monthly_attribution(v_batch);
      v_refreshed := v_refreshed + 1;
    end loop;
  end if;

  return query select v_rows, v_refreshed;
end;
$function$;

-- 7c. Fact-only bulk maintenance loop — keep attribution in lock-step here too, a named staleness vector.
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
    -- Monthly attribution rollup — closes the fact-only-refresh staleness vector.
    perform public.phx_refresh_monthly_attribution(rec.id);
  end loop;
end;
$function$;

-- =====================================================================================================
-- 8. Backfill every validated period now, from the same per-period refresh the wiring uses (no divergence
--    path). Small loop (~8 periods on prod), well within a migration transaction.
-- =====================================================================================================
do $backfill$
begin
  perform au.f_rebuild_monthly_attribution_all();
end;
$backfill$;

-- =====================================================================================================
-- 9. Grants. A new public SECURITY DEFINER function inherits EXECUTE for PUBLIC (anon/authenticated are
--    members), so revoke it and re-grant to service_role only. The au.* functions live in a non-exposed
--    schema and follow the sibling au.* pattern (no browser reach), so they need no grant change.
--    (7a/7b/7c keep their existing ACLs — CREATE OR REPLACE does not reset grants.)
-- =====================================================================================================
revoke execute on function public.phx_refresh_monthly_attribution(uuid) from public, anon, authenticated;
grant execute on function public.phx_refresh_monthly_attribution(uuid) to service_role;

revoke execute on function public.phx_rebuild_monthly_attribution_all() from public, anon, authenticated;
grant execute on function public.phx_rebuild_monthly_attribution_all() to service_role;

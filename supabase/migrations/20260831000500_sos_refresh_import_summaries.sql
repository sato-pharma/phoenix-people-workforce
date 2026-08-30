-- Source of Sales: make the import SUMMARIES refreshable instead of frozen at insert.
--
-- THE DEFECT
-- `source_of_sales_import_summaries` had two writers (persistDistributorSalesUpload and the
-- normalizer's persist step) and ZERO update paths. It is written once, from the parsed rows, at
-- insert time. Every other aggregate over those same rows — fact rollup, customer directory,
-- marketing ROI, channel totals, distributor x product, monthly attribution — has a
-- `phx_refresh_*` function that is re-run whenever the underlying rows are corrected (the
-- reconcile path in normalizer/customer-map.ts, the mapping backfill in normalizer/mapping.ts,
-- and phx_finalize_sos_batch at import).
--
-- The summaries were the one aggregate left behind. So a post-import row correction rebuilt
-- everything the Monthly Closing reads and nothing the Source of Sales DASHBOARD reads, and the
-- dashboard went permanently stale with no marker anywhere.
--
-- Measured on production 2026-08-30, period 2026-07, validated batches only:
--
--     DIRECT / Pedia            rows 1,127,259.65   summaries   534,713.65   +592,546.00
--     DIRECT / Anti Infective     149,288.50                     93,554.00    +55,734.50
--     EG-HOS / CNS                161,506.80                    155,738.70     +5,768.10
--     SF     / CNS                165,635.55                    166,411.80       -776.25
--     SF-T   / CNS                    749.70                        722.93        +26.78
--     Office / CNS              3,930,227.33                  3,930,227.33         0.00  (row count 3,591 vs 3,627)
--                                                                          ------------
--                                                                            653,299.13 EGP understated
--
-- Row COUNTS drift too, in both directions (SF's summaries claim 239 rows where 233 exist), so a
-- value-only repair would still leave the tables lying about how many rows they cover.
--
-- WHAT THIS FUNCTION REBUILDS, AND WHY EXACTLY THESE COLUMNS
-- The rule applied throughout: re-derive precisely what was ROW-derived at insert, and leave
-- alone anything that was PARSE-derived. Re-deriving a parse-time number from the stored rows
-- would not be a correction — it would be a different measurement, silently restating file
-- provenance that was never stale.
--
--   * All five summary group types (line / region / area / product / brick), including row_count.
--     At insert these came from summarizeRows() over the SAME array that insertSourceOfSalesRows()
--     persisted, so the stored rows reproduce them exactly.
--
--   * The batch header's total_qty / total_bonus_qty / total_value. Same provenance
--     (result.totals, from that same array), and this is what the CEO / Super Admin dashboard
--     headline reads while the tables under it read the summaries — which is why that page could
--     contradict itself. Refreshing both here, atomically, is what stops them drifting apart again.
--
--   * NOT total_rows / importable_rows / failed_rows / warning_rows / rows_ignored / rows_blank.
--     These describe the PARSE. rows_ignored and rows_blank exist specifically to record what the
--     sheet contained but the import dropped, and across historical batches total_rows diverges
--     from the persisted row count by amounts that do not reconcile against rows_ignored
--     (2026-01 PS: total_rows 32,882, persisted 34,243, rows_ignored 691). That divergence is not
--     attributable from the data alone, and a reporting fix must not restate a number it cannot
--     explain. Left untouched deliberately -- do not "complete" this later without establishing
--     where the historical gap came from.
--
-- FAILED ROWS ARE EXCLUDED, matching phx_refresh_sos_fact_rollup's existing rule
-- (coalesce(validation_state, 'valid') <> 'failed', pinned by tests/sos-rollup-sql-truth.test.ts).
-- The insert-time writer summed every parsed row instead, but that difference cannot move a single
-- stored number: phx_finalize_sos_batch aborts unless the batch's raw row count equals the fact
-- rollup's, so a batch carrying a failed row can never reach 'validated' -- and the dashboard reads
-- validated batches only. All 317,801 rows across all 120 validated batches are 'valid'
-- (production, 2026-08-30). Matching the fact rollup is what keeps the two aggregates from
-- diverging again, which is the entire point of this migration.
--
-- IDEMPOTENT AND SAFE TO RE-RUN: delete-then-insert for the batch, and the header update is a
-- pure re-aggregation. Running it on a freshly imported batch is a no-op by construction.
--
-- One incidental hardening: the insert-time writer built its brick groups on
-- (brickId, blockCode, areaCode, regionCode) but wrote a group_key of
-- brickId|brickName|areaCode|regionCode -- so one brick spanning two block codes produced two
-- groups colliding on a single key, against the (batch_id, group_type, group_key) unique
-- constraint. Rebuilding groups BY the key components cannot collide.

create or replace function public.phx_refresh_sos_import_summaries(p_batch_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
set statement_timeout to '120s'
as $function$
begin
  delete from public.source_of_sales_import_summaries
  where batch_id = p_batch_id;

  insert into public.source_of_sales_import_summaries (
    batch_id, group_type, group_key, group_label, group_code, official_line,
    row_count, total_qty, total_bonus_qty, total_value
  )
  -- ── Line ─────────────────────────────────────────────────────────────────
  -- The first UNION branch fixes the column types for every branch after it, so these casts are
  -- load-bearing: an untyped null/literal here resolves badly against the later branches.
  select
    p_batch_id,
    'line'::text,
    coalesce(r.official_line, '')::text,
    coalesce(r.official_line, '')::text,
    null::text,
    coalesce(r.official_line, '')::text,
    count(*),
    round(sum(r.qty), 6),
    round(sum(r.bonus_qty), 6),
    round(sum(r.value), 6)
  from public.source_of_sales_import_rows r
  where r.batch_id = p_batch_id
    and coalesce(r.validation_state, 'valid') <> 'failed'
  group by coalesce(r.official_line, '')

  union all

  -- ── Region ───────────────────────────────────────────────────────────────
  select
    p_batch_id,
    'region'::text,
    coalesce(r.region_code, '') || '|' || coalesce(r.region_name, ''),
    coalesce(r.region_name, ''),
    coalesce(r.region_code, ''),
    null::text,
    count(*),
    round(sum(r.qty), 6),
    round(sum(r.bonus_qty), 6),
    round(sum(r.value), 6)
  from public.source_of_sales_import_rows r
  where r.batch_id = p_batch_id
    and coalesce(r.validation_state, 'valid') <> 'failed'
  group by coalesce(r.region_code, ''), coalesce(r.region_name, '')

  union all

  -- ── Area ─────────────────────────────────────────────────────────────────
  -- Grouped on (area_code, area_name, region_code) to match the insert-time map key exactly --
  -- region_name is NOT part of that key, so the region NAME is taken from the group's first row
  -- (lowest row_number), which is the value the JS Map would have kept.
  select
    p_batch_id,
    'area',
    coalesce(r.area_code, '') || '|' || coalesce(r.area_name, '') || '|' || coalesce(r.region_code, ''),
    coalesce(r.area_name, ''),
    coalesce(r.area_code, ''),
    coalesce(
      nullif((array_agg(coalesce(r.region_name, '') order by r.row_number, r.id))[1], ''),
      coalesce(r.region_code, '')
    ),
    count(*),
    round(sum(r.qty), 6),
    round(sum(r.bonus_qty), 6),
    round(sum(r.value), 6)
  from public.source_of_sales_import_rows r
  where r.batch_id = p_batch_id
    and coalesce(r.validation_state, 'valid') <> 'failed'
  group by coalesce(r.area_code, ''), coalesce(r.area_name, ''), coalesce(r.region_code, '')

  union all

  -- ── Product ──────────────────────────────────────────────────────────────
  select
    p_batch_id,
    'product',
    coalesce(r.product_code, '') || '|' || coalesce(r.product_name, '') || '|' || coalesce(r.official_line, ''),
    coalesce(r.product_name, ''),
    coalesce(r.product_code, ''),
    coalesce(r.official_line, ''),
    count(*),
    round(sum(r.qty), 6),
    round(sum(r.bonus_qty), 6),
    round(sum(r.value), 6)
  from public.source_of_sales_import_rows r
  where r.batch_id = p_batch_id
    and coalesce(r.validation_state, 'valid') <> 'failed'
  group by coalesce(r.product_code, ''), coalesce(r.product_name, ''), coalesce(r.official_line, '')

  union all

  -- ── Brick ────────────────────────────────────────────────────────────────
  -- brick_name is not stored on the import row; it came from the brick master at parse time, so
  -- it is resolved from that same master here (source_of_sales_bricks.brick_id is unique --
  -- 700 rows, 700 distinct ids, verified 2026-08-30 -- so this join cannot fan out).
  select
    p_batch_id,
    'brick',
    coalesce(r.brick_id, '') || '|' || coalesce(bk.brick_name, '') || '|'
      || coalesce(r.area_code, '') || '|' || coalesce(r.region_code, ''),
    coalesce(bk.brick_name, ''),
    coalesce(r.brick_id, ''),
    coalesce(
      nullif((array_agg(coalesce(r.area_name, '') order by r.row_number, r.id))[1], ''),
      coalesce(r.area_code, '')
    ),
    count(*),
    round(sum(r.qty), 6),
    round(sum(r.bonus_qty), 6),
    round(sum(r.value), 6)
  from public.source_of_sales_import_rows r
  left join public.source_of_sales_bricks bk on bk.brick_id = r.brick_id
  where r.batch_id = p_batch_id
    and coalesce(r.validation_state, 'valid') <> 'failed'
  group by coalesce(r.brick_id, ''), coalesce(bk.brick_name, ''),
           coalesce(r.area_code, ''), coalesce(r.region_code, '');

  -- Batch header money + quantity, from the same rows, in the same pass. See the header comment
  -- for why the row-count columns are deliberately excluded.
  update public.source_of_sales_import_batches b
  set total_qty       = coalesce(t.total_qty, 0),
      total_bonus_qty = coalesce(t.total_bonus_qty, 0),
      total_value     = coalesce(t.total_value, 0),
      updated_at      = now()
  from (
    select
      round(sum(r.qty), 6)       as total_qty,
      round(sum(r.bonus_qty), 6) as total_bonus_qty,
      round(sum(r.value), 6)     as total_value
    from public.source_of_sales_import_rows r
    where r.batch_id = p_batch_id
      and coalesce(r.validation_state, 'valid') <> 'failed'
  ) t
  where b.id = p_batch_id;
end;
$function$;

-- anon and authenticated inherit EXECUTE through PUBLIC membership, so revoking only those two is
-- a no-op -- PUBLIC has to be named. Revoking PUBLIC on a default ACL also strips service_role,
-- hence the explicit re-grant after it.
revoke execute on function public.phx_refresh_sos_import_summaries(uuid) from public, anon, authenticated;
grant execute on function public.phx_refresh_sos_import_summaries(uuid) to service_role;

comment on function public.phx_refresh_sos_import_summaries(uuid) is
  'Rebuilds source_of_sales_import_summaries for one batch from source_of_sales_import_rows, and '
  're-derives that batch header''s total_qty/total_bonus_qty/total_value from the same rows. Run it '
  'wherever phx_refresh_sos_fact_rollup runs -- the summaries are what the Source of Sales dashboard '
  'reads, and before this existed they were frozen at insert while every other rollup refreshed.';

-- ── Wire it into the atomic import/finalize path ───────────────────────────
-- Recreated verbatim from the live definition (production, 2026-08-30) with ONE line added: the
-- summaries refresh, alongside the six rollups already refreshed here. Placed last so a summaries
-- failure cannot leave the rollups the Monthly Closing depends on half-built.
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
  perform public.phx_refresh_sos_distributor_product_rollup(p_batch_id);
  perform public.phx_refresh_monthly_attribution(p_batch_id);
  perform public.phx_refresh_sos_import_summaries(p_batch_id);

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

-- CREATE OR REPLACE preserves the existing ACL, so this is a no-op today (postgres + service_role
-- only). Re-declared anyway, the same way phx_closing_customers does it: if this function is ever
-- dropped and recreated rather than replaced, it would otherwise come back with PUBLIC EXECUTE.
revoke execute on function public.phx_finalize_sos_batch(uuid, text, text) from public, anon, authenticated;
grant execute on function public.phx_finalize_sos_batch(uuid, text, text) to service_role;

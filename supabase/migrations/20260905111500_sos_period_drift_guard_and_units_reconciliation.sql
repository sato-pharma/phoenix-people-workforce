-- Period drift: make the loss VISIBLE at every entry point, and reconcile on the right quantity.
--
-- SoS audit finding `db:public.phx_refresh_sos_fact_rollup:28` — "fact_rollup silently drops
-- period-drifted rows; only 1 of its 6 callers checks for the loss". Re-verified 2026-09-05: the
-- mechanism is intact, but the finding's remedy would have made things WORSE, and the measurement
-- is why.
--
-- ── 1. The drop is still real ────────────────────────────────────────────────────────────────
-- The finding quotes a join that has since moved: it now lives inside `phx_sos_rows_attributed`,
-- which the fact-rollup insert reads —
--     on b.id = r.batch_id and b.status = 'validated' and r.invoice_period = b.period
--     where r.invoice_period = p_period
-- — so a row whose invoice_period drifts from its batch period is still dropped from the fact
-- rollup with no error and no log, while the customer directory rollup (which groups by the ROW's
-- own period) keeps it. Two rollups, two definitions of "period", refreshed in the same breath.
--
-- ── 2. But the guard the finding wants copied is MISCALIBRATED ───────────────────────────────
-- `phx_finalize_sos_batch` reconciles `count(*) from import_rows` against
-- `sum(row_count) from fact_rollup` and raises "Reconciliation failed ... aborting" on any
-- difference. Attribution SPLITS a row across areas, so the rollup legitimately holds MORE rows
-- than the source. Measured across all 123 validated batches on production, 2026-09-05:
--
--     instrument   batches failing
--     row count    6      <- all six are Ramco (RM), one per period 2026-02..2026-07
--     units        0      <- worst gap 0.000000
--
--     fanned out: 6      lost rows: 0
--     e.g. RM 2026-06: 344 raw rows -> 498 rolled, units 6,068.00 -> 6,068.00 exactly
--
-- So the existing check already fails on six live batches, and wiring it into the other five
-- callers — the finding's literal remedy — would have spread a false "aborting" into every re-map
-- of an allocated distributor. Row count is simply the wrong instrument once allocation exists;
-- UNITS are exact everywhere and still catch the loss this is about, because a dropped row takes
-- its units with it.
--
-- ── What this migration does ────────────────────────────────────────────────────────────────
--   A. `phx_finalize_sos_batch` reconciles on UNITS instead of row counts, and compares like with
--      like by excluding `failed` rows on the raw side exactly as the rollup does. The returned
--      `rowCount` field is unchanged, so no caller contract moves.
--   B. `phx_refresh_sos_fact_rollup` detects drift ITSELF and RAISEs a WARNING naming the batch,
--      the row count and the value. Putting it in the shared function is what reaches all six
--      entry points at once, instead of asking five call sites to remember.
--
-- Why a WARNING and not an exception: this function runs inside `phx_sync_sos_run`'s per-batch
-- loop and on every re-map. Aborting there would turn a reporting defect into an outage across
-- unrelated batches. The hard stop stays at finalize, where failing is safe — and now that it
-- reconciles on units, drift-induced loss actually trips it.
--
-- Live drift today: 0 rows across all validated batches (`phx_sos_period_drift_count()` agrees),
-- so neither half changes a number now. Both close a silent path.

-- ── A. reconcile on units ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.phx_finalize_sos_batch(p_batch_id uuid, p_distributor_code text, p_period text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
declare
  v_superseded jsonb;
  v_raw_count bigint;
  v_raw_units numeric;
  v_rollup_units numeric;
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

  -- Still returned as `rowCount`; the caller contract does not move.
  select count(*) into v_raw_count
  from public.source_of_sales_import_rows
  where batch_id = p_batch_id;

  -- UNITS, not rows. Attribution splits one source row across areas, so the rollup holds more ROWS
  -- by design (6 of 123 validated batches on 2026-09-05, all Ramco, all fan-out, zero loss) while
  -- units are preserved exactly. A dropped row still takes its units with it, so this catches the
  -- loss the row count was there to catch, without the false alarm.
  -- `failed` rows are excluded on BOTH sides, because the rollup excludes them.
  select coalesce(sum(qty), 0) into v_raw_units
  from public.source_of_sales_import_rows
  where batch_id = p_batch_id
    and coalesce(validation_state, 'valid') <> 'failed';

  select coalesce(sum(total_qty), 0) into v_rollup_units
  from public.source_of_sales_fact_rollup
  where batch_id = p_batch_id;

  if round(v_raw_units, 4) <> round(v_rollup_units, 4) then
    raise exception 'Reconciliation failed for batch %: % raw units but % rolled up -- aborting.', p_batch_id, v_raw_units, v_rollup_units;
  end if;

  return jsonb_build_object('supersededBatches', v_superseded, 'rowCount', v_raw_count);
end;
$function$;

-- ── B. the refresh reports its own drift, so all six callers inherit it ──────────────────────
CREATE OR REPLACE FUNCTION public.phx_refresh_sos_fact_rollup(p_batch_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_period text;
  v_drift_rows bigint;
  v_drift_value numeric;
begin
  select b.period into v_period
  from public.source_of_sales_import_batches b
  where b.id = p_batch_id;

  delete from public.source_of_sales_fact_rollup where batch_id = p_batch_id;
  delete from public.source_of_sales_customer_presence_rollup where batch_id = p_batch_id;

  insert into public.source_of_sales_fact_rollup
    (batch_id, period, distributor_code, official_line, region_code, area_code, brick_id,
     client_code, product_code, product_name, is_direct,
     effective_units, total_qty, total_bonus_qty, direct_value, row_count)
  select
    a.batch_id,
    v_period,
    a.distributor_code,
    a.official_line,
    a.region_code,
    a.area_code,
    a.brick_id,
    a.client_code,
    a.product_code,
    max(a.product_name),
    a.is_direct,
    sum(a.qty * (1 - coalesce(a.discount, 0))),
    sum(a.qty),
    sum(coalesce(a.bonus_qty, 0)),
    sum(case when a.is_direct then a.value else 0 end),
    count(*)
  from public.phx_sos_rows_attributed(v_period) a
  where a.batch_id = p_batch_id
    and coalesce(a.validation_state, 'valid') <> 'failed'
  group by
    a.batch_id, a.distributor_code, a.official_line, a.region_code,
    a.area_code, a.brick_id, a.client_code, a.product_code, a.is_direct;

  insert into public.source_of_sales_customer_presence_rollup
    (batch_id, period, client_code, official_line, region_code, present_any, present_nonexcluded)
  select
    r.batch_id,
    b.period,
    r.client_code,
    coalesce(r.official_line, ''),
    coalesce(r.region_code, ''),
    true,
    bool_or(coalesce(upper(btrim(r.product_code)) <> all (array['LA003','LA004','SS001']), false))
  from public.source_of_sales_import_rows r
  join public.source_of_sales_import_batches b
    on b.id = r.batch_id and b.status = 'validated' and r.invoice_period = b.period
  where r.batch_id = p_batch_id
    and r.client_code is not null
    and coalesce(r.validation_state, 'valid') <> 'failed'
  group by
    r.batch_id, b.period, r.client_code, coalesce(r.official_line, ''), coalesce(r.region_code, '');

  -- The rows this refresh just dropped on the floor. `phx_sos_rows_attributed` selects on
  -- `r.invoice_period = b.period`, so a drifted row is deleted by the `delete` above and never
  -- re-inserted — money that vanishes from Executive, Closing and the au achievement chain while
  -- the customer directory (which groups by the ROW's period) still shows it.
  --
  -- Reported here rather than at the call sites: five of the six callers had no check at all, and
  -- a guard that has to be remembered six times is a guard that will be forgotten once.
  select count(*), coalesce(sum(coalesce(r.value, 0)), 0)
    into v_drift_rows, v_drift_value
  from public.source_of_sales_import_rows r
  where r.batch_id = p_batch_id
    and coalesce(r.validation_state, 'valid') <> 'failed'
    and coalesce(nullif(btrim(r.invoice_period), ''), '') <> coalesce(v_period, '');

  if v_drift_rows > 0 then
    raise warning 'SoS period drift: batch % (period %) has % row(s) worth % on a different invoice_period; they are NOT in source_of_sales_fact_rollup. Run phx_sos_period_drift_count() for the breakdown.',
      p_batch_id, v_period, v_drift_rows, round(v_drift_value, 2);
  end if;
end;
$function$;

-- ── Re-assert the SECURITY DEFINER grants (replay safety) ────────────────────────────────────
-- No-op here (CREATE OR REPLACE keeps the live ACL; both already read
-- `postgres=X/postgres | service_role=X/postgres`), and on a fresh database it stops the default
-- ACL granting EXECUTE to PUBLIC. anon/authenticated inherit through PUBLIC, and revoking PUBLIC
-- on a default ACL also strips service_role — hence the explicit re-grant.
revoke execute on function public.phx_finalize_sos_batch(uuid, text, text) from public, anon, authenticated;
grant  execute on function public.phx_finalize_sos_batch(uuid, text, text) to service_role;

revoke execute on function public.phx_refresh_sos_fact_rollup(uuid) from public, anon, authenticated;
grant  execute on function public.phx_refresh_sos_fact_rollup(uuid) to service_role;

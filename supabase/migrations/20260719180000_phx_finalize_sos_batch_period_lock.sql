-- Close the period-lock TOCTOU in the Source-of-Sales upload path.
--
-- Today assertPeriodNotLocked (src/lib/sales/monthly-distributor-import.ts) reads
-- monthly_sales_period_lock once, EARLY, in the application layer, then the upload proceeds through
-- several separate, non-transactional writes (batch insert → batched row inserts → phx_finalize_sos_
-- batch). If an admin locks the period during that window, the in-flight upload still finalizes and
-- validates — the lock is silently bypassed. There is no DB-level backstop: the only advisory lock in
-- phx_finalize_sos_batch is keyed on distributor+period to serialize concurrent finalizes, and nothing
-- else references monthly_sales_period_lock from any write path.
--
-- Fix: re-check the period lock INSIDE phx_finalize_sos_batch, immediately after taking the advisory
-- lock and before the supersede/delete/validate mutation — so the check and the state change are
-- atomic. A period locked at any point before finalize now aborts the finalize with a clean 55P03
-- (mapped to a 409 by the caller, like the existing "another upload is finalizing" path), instead of
-- slipping a validated batch into a frozen period. The check is defensive against a missing lock table
-- (to_regclass guard) to match assertPeriodNotLocked's pre-migration tolerance.
--
-- This is a pure CREATE OR REPLACE of an existing SECURITY DEFINER function; the body is copied
-- verbatim from the live definition with ONLY the lock re-check inserted. No signature change, no
-- data change. anon/authenticated already cannot execute it; the REVOKE below is idempotent and
-- keeps it that way (and satisfies the migrations-secdef-revoke-guard convention).

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

-- Idempotent hardening (defense-in-depth + migrations-secdef-revoke-guard convention): this
-- SECURITY DEFINER function is server-only (called via the service role); revoke the built-in PUBLIC
-- EXECUTE grant (the vector behind the analytics_* leak — see 20260719160500) plus the two API roles.
revoke execute on function public.phx_finalize_sos_batch(uuid, text, text) from public, anon, authenticated;

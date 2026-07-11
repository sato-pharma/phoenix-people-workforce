-- Atomic, race-safe, self-verifying finalize step for Source of Sales batches.
--
-- Today, promoting an upload to "the truth for this distributor + period" is 5+
-- separate round trips from the app: delete the old batch, insert the new one,
-- then three separate rollup-refresh RPCs. If anything after the delete throws,
-- the old good batch is already gone and the new one is incomplete -- no batch is
-- left in a known-good state. phx_finalize_sos_batch collapses all of it into ONE
-- transaction: lock the (distributor, period) pair, supersede any other batch for
-- that exact key, promote this batch to validated, refresh every dependent rollup,
-- then verify row counts reconcile. Any failure anywhere rolls back the whole
-- thing, so a bad upload can never destroy a previously-good batch and two
-- simultaneous uploads of the same period can't race each other.

alter table public.source_of_sales_import_batches
  drop constraint source_of_sales_import_batches_status_check;

alter table public.source_of_sales_import_batches
  add constraint source_of_sales_import_batches_status_check
  check (status in ('pending', 'blocked', 'validated'));

comment on constraint source_of_sales_import_batches_status_check
  on public.source_of_sales_import_batches is
  'pending = rows inserted, not yet promoted by phx_finalize_sos_batch. Invisible to every rollup/refresh function (all join on status = ''validated'') and to the one-validated-batch-per-period unique index.';

create or replace function public.phx_finalize_sos_batch(
  p_batch_id uuid,
  p_distributor_code text,
  p_period text
)
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

revoke all on function public.phx_finalize_sos_batch(uuid, text, text) from public, anon, authenticated;
grant execute on function public.phx_finalize_sos_batch(uuid, text, text) to service_role;

-- Maintenance: clear out batches that died mid-pipeline (the request crashed between
-- the row insert and the finalize call, so they never reached 'validated'). Cascading
-- FKs clean up their rows; nothing ever reads a non-validated batch, so these are pure
-- dead weight once stale. Wired into the existing daily notifications cron -- no new
-- Vercel cron (see src/lib/notifications/scheduled-processing.ts).
create or replace function public.phx_cleanup_stale_pending_sos_batches()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_deleted integer;
begin
  with deleted as (
    delete from public.source_of_sales_import_batches
    where status = 'pending'
      and created_at < now() - interval '6 hours'
    returning id
  )
  select count(*) into v_deleted from deleted;
  return v_deleted;
end;
$function$;

revoke all on function public.phx_cleanup_stale_pending_sos_batches() from public, anon, authenticated;
grant execute on function public.phx_cleanup_stale_pending_sos_batches() to service_role;

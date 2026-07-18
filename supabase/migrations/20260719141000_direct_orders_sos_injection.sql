-- Phase C — inject approved Direct Order Requests into Source-of-Sales.
--
-- Model: REBUILD-FROM-TRUTH. On every final approval / reversal the caller invokes
-- phx_rebuild_direct_order_sos_batch(period) which rebuilds the single 'DirectReq'
-- batch for that sales month from ALL currently-live approved orders, then reuses
-- phx_finalize_sos_batch (advisory lock + supersede prior + rollup refresh +
-- raw==rollup reconciliation). This makes injection:
--   * idempotent  — re-running yields the identical batch/rollup,
--   * reversible  — a reversed order drops out of the truth set on the next rebuild
--                   (and 0 live orders removes the batch entirely), and
--   * firewalled  — the code 'DirectReq' is its own supersede domain; it can never
--                   clobber the manual 'DIRECT' upload or any real distributor.
--
-- is_direct = true is preserved. The fact rollup stores direct_value = sum(value),
-- and au.f_monthly_attribution Branch B1 attributes direct-with-area to the rep by
-- sum(direct_value) — so the injected request.sales_value reaches the rep EXACTLY
-- (bonus and discount deals alike; value already carries the final money amount).

begin;

-- The batch table FKs distributor_code -> source_of_sales_distributors. Seed the
-- module's reserved code once. active=false keeps 'DirectReq' out of the manual
-- SoS upload dropdown, so no human upload can ever land on the code the module
-- rebuilds — the firewall (one validated batch per distributor+period) stays ours.
insert into public.source_of_sales_distributors
  (distributor_code, distributor_name, normalized_distributor_name, source_file, source_sheet, active)
values
  ('DirectReq', 'Direct Order Requests', 'direct order requests', 'direct-orders-module', 'DirectOrders', false)
on conflict (distributor_code) do nothing;

create or replace function public.phx_rebuild_direct_order_sos_batch(
  p_period text,
  p_actor  text default 'system'
)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_batch_id     uuid;
  v_count        integer;
  v_total_qty    numeric;
  v_total_bonus  numeric;
  v_total_value  numeric;
  v_finalize     jsonb;
begin
  if p_period is null or p_period !~ '^\d{4}-\d{2}$' then
    raise exception 'phx_rebuild_direct_order_sos_batch: invalid period % (want YYYY-MM)', p_period;
  end if;

  -- Serialize concurrent rebuilds of this period. Re-entrant with the try-lock that
  -- phx_finalize_sos_batch takes on the same key within this same transaction.
  perform pg_advisory_xact_lock(hashtextextended('DirectReq:' || p_period, 0));

  -- The authoritative live set for this sales month: approved, not a reversal entry,
  -- not itself reversed (a reversed original is flipped to status='reversed').
  select count(*),
         coalesce(sum(r.qty), 0),
         coalesce(sum(coalesce(r.bonus, 0)), 0),
         coalesce(sum(r.sales_value), 0)
    into v_count, v_total_qty, v_total_bonus, v_total_value
  from public.direct_order_requests r
  join public.direct_order_pharmacies ph on ph.id = r.pharmacy_id
  where r.status = 'approved'
    and r.reversal_of_request_id is null
    and r.sales_month = p_period;

  if v_count = 0 then
    -- Nothing live this month -> remove any prior DirectReq batch so the injected
    -- direct sales disappear (a reversal of the only order nets cleanly to zero).
    delete from public.source_of_sales_import_batches
     where distributor_code = 'DirectReq' and period = p_period;
    return jsonb_build_object('period', p_period, 'rowCount', 0, 'batchId', null, 'totalValue', 0);
  end if;

  insert into public.source_of_sales_import_batches
    (distributor_code, distributor_name, template_key, file_name, sheet_name, period,
     status, total_rows, importable_rows, failed_rows, warning_rows,
     total_qty, total_bonus_qty, total_value, uploaded_by)
  values
    ('DirectReq', 'Direct Order Requests', 'direct_orders',
     'direct-orders-' || p_period, 'DirectOrders', p_period,
     'pending', v_count, v_count, 0, 0,
     v_total_qty, v_total_bonus, v_total_value, coalesce(p_actor, 'system'))
  returning id into v_batch_id;

  insert into public.source_of_sales_import_rows
    (batch_id, row_number, distributor_code, invoice_period,
     region_code, region_name, area_code, area_name, brick_id,
     client_code, client_name, client_address,
     product_code, product_name, official_line,
     qty, bonus_qty, discount, value, is_direct, validation_state, raw_row)
  select
    v_batch_id,
    row_number() over (order by r.created_at, r.id),
    'DirectReq',
    p_period,
    coalesce(ph.region_code, ''),
    coalesce(ph.region_code, ''),
    ph.area_code,
    ph.area_code,
    ph.brick_id,
    ph.phoenix_pharmacy_code,
    ph.pharmacy_name,
    ph.pharmacy_address,
    upper(btrim(r.product_code)),
    r.product_name,
    r.line,
    r.qty,
    coalesce(r.bonus, 0),
    0,
    r.sales_value,
    true,
    'valid',
    jsonb_build_object('source', 'direct_order_request', 'requestId', r.id, 'dealType', r.deal_type)
  from public.direct_order_requests r
  join public.direct_order_pharmacies ph on ph.id = r.pharmacy_id
  where r.status = 'approved'
    and r.reversal_of_request_id is null
    and r.sales_month = p_period;

  -- Supersede any prior DirectReq/period batch, validate this one, refresh the
  -- rollup, and reconcile raw rows == rollup grain (raises on any silent loss).
  v_finalize := public.phx_finalize_sos_batch(v_batch_id, 'DirectReq', p_period);

  update public.direct_order_requests r
     set sos_batch_id = v_batch_id, updated_at = now()
  from public.direct_order_pharmacies ph
  where ph.id = r.pharmacy_id
    and r.status = 'approved'
    and r.reversal_of_request_id is null
    and r.sales_month = p_period;

  return jsonb_build_object(
    'period', p_period,
    'rowCount', v_count,
    'batchId', v_batch_id,
    'totalValue', v_total_value,
    'finalize', v_finalize
  );
end;
$function$;

revoke all on function public.phx_rebuild_direct_order_sos_batch(text, text) from public, anon, authenticated;

-- ── Fold injection into the decision RPC so it is ATOMIC with the approval ──────
-- On FINAL approval the same transaction that flips the request to 'approved' also
-- rebuilds the SoS batch. If injection raises (e.g. finalize reconciliation), the
-- whole decision rolls back and the approver simply retries — there is no
-- "approved but not injected" state to reconcile by hand.
create or replace function public.phx_apply_direct_order_decision(
  p_request_id uuid,
  p_step_order int,
  p_expected_status text,
  p_next_status text,
  p_step_next_status text,      -- 'approved' | 'rejected' | null (null = return: request-only, step untouched)
  p_decided_by_hr_id text,
  p_decision_comment text,
  p_now timestamptz,
  p_sales_month text            -- set only when the request finalizes as approved
) returns public.direct_order_requests
  language plpgsql security definer
  set search_path to 'public'
as $$
declare
  v_row public.direct_order_requests;
  v_is_final boolean;
  v_original_month text;
begin
  select * into v_row from public.direct_order_requests where id = p_request_id for update;
  if not found then
    raise exception 'Direct order request was not found.' using errcode = 'P0002';
  end if;
  if v_row.status is distinct from p_expected_status then
    raise exception 'Direct order request was updated by another user. Refresh and try again.'
      using errcode = '40001';
  end if;

  -- Advance the acting step (only for approve/reject; a return leaves the step
  -- pending so the chain resumes at the same rung after the requester resubmits).
  if p_step_next_status in ('approved', 'rejected') then
    update public.direct_order_approval_steps
       set status = p_step_next_status,
           decided_by_hr_id = p_decided_by_hr_id,
           decision_comment = p_decision_comment,
           decided_at = p_now,
           updated_at = p_now
     where request_id = p_request_id and step_order = p_step_order;
    if not found then
      raise exception 'Approval step % was not found for this request.', p_step_order using errcode = 'P0002';
    end if;
  end if;

  v_is_final := p_next_status in ('approved', 'rejected');

  update public.direct_order_requests
     set status = p_next_status,
         decided_at = case when v_is_final then p_now else decided_at end,
         sales_month = case when p_next_status = 'approved' then p_sales_month else sales_month end,
         updated_at = p_now
   where id = p_request_id
   returning * into v_row;

  -- Phase C — inject into Source-of-Sales atomically with a FINAL approval.
  if p_next_status = 'approved' then
    if v_row.reversal_of_request_id is not null then
      -- A reversal just cleared: retire its original and rebuild the original's
      -- month so the reversed sales drop out of the truth set.
      update public.direct_order_requests
         set status = 'reversed', updated_at = p_now
       where id = v_row.reversal_of_request_id
       returning sales_month into v_original_month;
      if v_original_month is not null then
        perform public.phx_rebuild_direct_order_sos_batch(v_original_month, p_decided_by_hr_id);
      end if;
      -- The reversal entry itself carries reversal_of_request_id, so it is excluded
      -- from every rebuild and never injects positive sales.
    elsif v_row.sales_month is not null then
      perform public.phx_rebuild_direct_order_sos_batch(v_row.sales_month, p_decided_by_hr_id);
    end if;
  end if;

  return v_row;
end;
$$;

revoke all on function public.phx_apply_direct_order_decision(uuid, int, text, text, text, text, text, timestamptz, text) from public;
grant execute on function public.phx_apply_direct_order_decision(uuid, int, text, text, text, text, text, timestamptz, text) to service_role;

notify pgrst, 'reload schema';

commit;

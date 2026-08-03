-- Direct Orders — Finance owns the sales month, not the approval date.
--
-- Owner decision (2026-08-03): the month a direct order is BOOKED INTO is chosen explicitly by
-- Finance (Ahmed El Maraghy, B-185) or a Super Admin, per order, at any time. It is no longer
-- derived from whenever the CEO happened to sign it off — the month an order is approved in is
-- frequently not the month its sales belong to.
--
-- Two behaviours follow, and only the first needs a change here:
--
--   1. Approving must NEVER wipe a month Finance already chose. This function wrote
--      `sales_month = p_sales_month` unconditionally on approval; now that the service passes
--      null (it no longer derives a month from the clock), a final approval would blank a month
--      that had been set earlier. coalesce keeps the stored value when the caller supplies none.
--
--   2. An order with no month counts in NO month's sales. That already holds: the injection
--      branch is guarded by `v_row.sales_month is not null`, so a null month never reaches
--      phx_rebuild_direct_order_sos_batch.
--
-- This body is the LIVE definition read back from pg_get_functiondef, with exactly one line
-- changed (the coalesce). Everything else — the compare-and-swap, the error codes, the step
-- guard, the reversal branch — is reproduced verbatim so this migration cannot quietly alter
-- behaviour it was not meant to touch.

begin;

create or replace function public.phx_apply_direct_order_decision(
  p_request_id uuid,
  p_step_order integer,
  p_expected_status text,
  p_next_status text,
  p_step_next_status text,
  p_decided_by_hr_id text,
  p_decision_comment text,
  p_now timestamp with time zone,
  p_sales_month text            -- null = leave the stored month alone (Finance owns it)
) returns public.direct_order_requests
  language plpgsql
  security definer
  set search_path to 'public'
as $function$
declare
  v_row public.direct_order_requests;
  v_is_final boolean;
  v_original_month text;
begin
  select * into v_row from public.direct_order_requests where id = p_request_id for update;
  if not found then raise exception 'Direct order request was not found.' using errcode = 'P0002'; end if;
  if v_row.status is distinct from p_expected_status then
    raise exception 'Direct order request was updated by another user. Refresh and try again.' using errcode = '40001';
  end if;

  if p_step_next_status in ('approved', 'rejected') then
    update public.direct_order_approval_steps
       set status = p_step_next_status, decided_by_hr_id = p_decided_by_hr_id,
           decision_comment = p_decision_comment, decided_at = p_now, updated_at = p_now
     where request_id = p_request_id and step_order = p_step_order;
    if not found then raise exception 'Approval step % was not found for this request.', p_step_order using errcode = 'P0002'; end if;
  end if;

  v_is_final := p_next_status in ('approved', 'rejected');

  update public.direct_order_requests
     set status = p_next_status,
         decided_at = case when v_is_final then p_now else decided_at end,
         -- CHANGED: coalesce, not a bare assignment. A null from the caller means
         -- "Finance owns this month, leave it" — never "clear it".
         sales_month = case when p_next_status = 'approved' then coalesce(p_sales_month, sales_month) else sales_month end,
         updated_at = p_now
   where id = p_request_id
   returning * into v_row;

  if p_next_status = 'approved' then
    if v_row.reversal_of_request_id is not null then
      update public.direct_order_requests set status = 'reversed', updated_at = p_now
       where id = v_row.reversal_of_request_id returning sales_month into v_original_month;
      if v_original_month is not null then
        perform public.phx_rebuild_direct_order_sos_batch(v_original_month, p_decided_by_hr_id);
      end if;
    elsif v_row.sales_month is not null then
      -- No month yet = no sales anywhere. Finance books it later and the rebuild runs then.
      perform public.phx_rebuild_direct_order_sos_batch(v_row.sales_month, p_decided_by_hr_id);
    end if;
  end if;

  return v_row;
end;
$function$;

-- `create or replace` re-applies the function's DEFAULT ACL, which grants EXECUTE to PUBLIC —
-- and anon/authenticated inherit through PUBLIC, so revoking only those two is a no-op. Revoke
-- from PUBLIC explicitly, then re-grant service_role, because the revoke strips it too.
revoke execute on function public.phx_apply_direct_order_decision(uuid, integer, text, text, text, text, text, timestamptz, text) from public;
grant execute on function public.phx_apply_direct_order_decision(uuid, integer, text, text, text, text, text, timestamptz, text) to service_role;

notify pgrst, 'reload schema';

commit;

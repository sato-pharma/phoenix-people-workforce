-- Atomic, per-employee-serialized paid-balance enforcement for vacation approvals.
--
-- Context / why
-- -------------
-- decideVacationRequest computed the remaining paid balance from already-"approved"
-- rows only (approvedPaidDaysInPeriod), then wrote the decision in a separate step.
-- Two pending requests for the same employee in the same balance period could each
-- read the same remaining balance and both be approved as paid, paying the employee
-- for more leave than entitled. The row-level CAS only blocked double-deciding the
-- SAME request; the unique index does not cover the aggregate balance.
--
-- Under Supabase's transaction-mode pooling, session advisory locks are unreliable, so
-- the read-recompute-write must happen inside ONE transaction. This SECURITY DEFINER
-- function takes a per-employee transaction advisory lock, re-reads the request under a
-- row lock with a status compare-and-swap, recomputes the authoritative used-paid-days
-- (mirroring approvedPaidDaysInPeriod), applies the paid/unpaid split (mirroring
-- splitVacationPayment in src/lib/vacation/calculations.ts), and writes the decision —
-- all atomically. The complex, request-local accrual/period/6-month logic stays in JS
-- (it does not depend on other requests); only the contended pieces live here.
--
-- The caller (applyVacationDecisionSequential) invokes this ONLY for the contended
-- final approval (annual/emergency, eligible for a paid split). Compensatory, forced-
-- unpaid (first_six_months / missing_hire_date), and non-final transitions keep the
-- existing JS write — they are not balance-contended.

create or replace function public.phx_apply_vacation_paid_approval(
  p_request_id uuid,
  p_expected_status text,
  p_next_status text,
  p_step text,                 -- 'hr' for the HR step, anything else = manager step
  p_decision_by_hr_id text,
  p_decision_comment text,
  p_now timestamptz,
  p_entitlement_days numeric,
  p_period_start date,
  p_period_end date,
  p_duration_days numeric,
  p_vacation_type text
)
returns public.v2_vacation_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_employee_hr_id text;
  v_used numeric;
  v_balance_before numeric;
  v_paid numeric;
  v_unpaid numeric;
  v_balance_after numeric;
  v_payment_status text;
  v_unpaid_reason text;
  v_row public.v2_vacation_requests;
begin
  -- Lock the target request row and enforce the status compare-and-swap. Different
  -- requests never contend on this row lock; it only guards this request's transition.
  select * into v_row from public.v2_vacation_requests where id = p_request_id for update;
  if not found then
    raise exception 'Vacation request was not found.' using errcode = 'P0002';
  end if;
  if v_row.status is distinct from p_expected_status then
    raise exception 'Vacation request was updated by another user. Refresh and try again.'
      using errcode = '40001';
  end if;
  v_employee_hr_id := v_row.employee_hr_id;

  -- Serialize ALL paid-balance decisions for this employee for the rest of the
  -- transaction, so two concurrent approvals in the same period cannot both consume
  -- the same remaining entitlement. Released automatically at commit/rollback.
  perform pg_advisory_xact_lock(hashtext(lower(v_employee_hr_id)));

  -- Authoritative used-paid-days in the balance period. Mirrors approvedPaidDaysInPeriod:
  -- annual and emergency share one period bucket; other types match exactly. paid_duration_days
  -- is NOT NULL, so summing it is equivalent to the JS branch.
  select coalesce(sum(paid_duration_days), 0) into v_used
  from public.v2_vacation_requests
  where lower(employee_hr_id) = lower(v_employee_hr_id)
    and status = 'approved'
    and id <> p_request_id
    and start_date >= p_period_start
    and start_date <  p_period_end
    and (
      (p_vacation_type in ('annual', 'emergency') and vacation_type in ('annual', 'emergency'))
      or (p_vacation_type not in ('annual', 'emergency') and vacation_type = p_vacation_type)
    );

  -- Paid/unpaid split (mirrors splitVacationPayment; roundDays = round to 2 decimals).
  v_used := round(v_used, 2);
  v_balance_before := round(greatest(0, p_entitlement_days - v_used), 2);
  v_paid := round(least(p_duration_days, greatest(0, v_balance_before)), 2);
  v_unpaid := round(greatest(0, p_duration_days - v_paid), 2);
  v_balance_after := round(greatest(0, v_balance_before - v_paid), 2);
  if v_unpaid > 0 and v_paid > 0 then
    v_payment_status := 'partial';
  elsif v_unpaid > 0 then
    v_payment_status := 'unpaid';
  else
    v_payment_status := 'paid';
  end if;
  v_unpaid_reason := case when v_unpaid > 0 then 'insufficient_balance' else null end;

  update public.v2_vacation_requests set
    status = p_next_status,
    updated_at = p_now,
    payment_status = v_payment_status,
    paid_duration_days = v_paid,
    unpaid_duration_days = v_unpaid,
    unpaid_reason = v_unpaid_reason,
    entitlement_days = round(p_entitlement_days, 2),
    used_paid_days = v_used,
    balance_before_days = v_balance_before,
    balance_after_days = v_balance_after,
    period_start = p_period_start,
    period_end = p_period_end,
    hr_decision = case when p_step = 'hr' then 'approved' else hr_decision end,
    hr_decision_by_hr_id = case when p_step = 'hr' then p_decision_by_hr_id else hr_decision_by_hr_id end,
    hr_decision_at = case when p_step = 'hr' then p_now else hr_decision_at end,
    hr_decision_comment = case when p_step = 'hr' then p_decision_comment else hr_decision_comment end,
    manager_decision = case when p_step <> 'hr' then 'approved' else manager_decision end,
    manager_decision_by_hr_id = case when p_step <> 'hr' then p_decision_by_hr_id else manager_decision_by_hr_id end,
    manager_decision_at = case when p_step <> 'hr' then p_now else manager_decision_at end,
    manager_decision_comment = case when p_step <> 'hr' then p_decision_comment else manager_decision_comment end
  where id = p_request_id
  returning * into v_row;

  return v_row;
end;
$$;

-- Server-only: the app calls this via the service-role client. Never expose to anon/authenticated.
revoke all on function public.phx_apply_vacation_paid_approval(
  uuid, text, text, text, text, text, timestamptz, numeric, date, date, numeric, text
) from public;
revoke all on function public.phx_apply_vacation_paid_approval(
  uuid, text, text, text, text, text, timestamptz, numeric, date, date, numeric, text
) from anon;
revoke all on function public.phx_apply_vacation_paid_approval(
  uuid, text, text, text, text, text, timestamptz, numeric, date, date, numeric, text
) from authenticated;
grant execute on function public.phx_apply_vacation_paid_approval(
  uuid, text, text, text, text, text, timestamptz, numeric, date, date, numeric, text
) to service_role;

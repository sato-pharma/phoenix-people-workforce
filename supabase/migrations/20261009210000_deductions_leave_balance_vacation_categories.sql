-- Deductions → "Deduct from leave balance" also on Unpaid Vacation and Insufficient Balance Vacation.
--
-- Owner, 2026-10-09, hours after the button shipped for CRM and CRM half day:
--   "also show the deduct from balance in unpaid and insufficient"
--
-- The only change is the category gate. Everything else in this function is reproduced byte for byte
-- from 20261009200000_deductions_leave_balance_charges.sql on purpose: the per-employee advisory lock
-- that a leave approval also takes, the already-charged check, and the three balance figures re-read
-- and compared against what the caller saw, which refuse with 40001 when the balance moved. A
-- migration that rewrote any of that while widening one list is how a guard gets lost.
--
-- Why this is safe for a vacation day. An unpaid vacation day is a day the annual balance could NOT
-- pay for, so `v2_vacation_requests.paid_duration_days` for it is zero, and `requestDays` — which
-- every balance reader sums — does not count it. Charging it therefore consumes the balance exactly
-- once, through `attendance_annual_balance_charges`. On most such rows the balance is empty and the
-- service refuses before reaching this function; that refusal is the correct answer, not a fault.
--
-- No table, index or grant changes. Re-runnable.

create or replace function public.phx_deductions_charge_leave_balance(
  p_candidate_id uuid,
  p_employee_hr_id text,
  p_work_date date,
  p_days numeric,
  p_comment text,
  p_actor_hr_id text,
  p_period_start date,
  p_period_end date,
  p_seen_request_days numeric,
  p_seen_charge_days numeric,
  p_seen_copilot_days numeric
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_candidate public.deductions_candidates;
  v_request_days numeric;
  v_charge_days numeric;
  v_copilot_days numeric;
  v_already numeric;
  v_id bigint;
begin
  if coalesce(btrim(p_comment), '') = '' then
    raise exception 'Write the comment the employee will read.' using errcode = '22023';
  end if;
  if p_days is null or p_days <= 0 then
    raise exception 'There are no days to charge to the leave balance.' using errcode = '22023';
  end if;
  if p_period_start is null or p_period_end is null or p_work_date is null then
    raise exception 'A leave balance charge needs its balance period.' using errcode = '22023';
  end if;

  -- Same lock key as phx_apply_vacation_paid_approval, so a leave approval and this charge for one
  -- employee can never interleave.
  perform pg_advisory_xact_lock(hashtext(lower(p_employee_hr_id)));

  select * into v_candidate from public.deductions_candidates where id = p_candidate_id for update;
  if not found then
    raise exception 'That deduction was not found.' using errcode = 'P0002';
  end if;
  if v_candidate.superseded_at is not null then
    raise exception 'That deduction was replaced by a newer one — reload and look again.' using errcode = '40001';
  end if;
  if v_candidate.locked_at is not null then
    raise exception 'That deduction is locked by a publication and can no longer be changed.' using errcode = '55000';
  end if;
  -- WIDENED 2026-10-09 (owner). Must stay equal to LEAVE_BALANCE_CATEGORIES in
  -- src/lib/deductions/types.ts, which the workspace, the decide guard and the charge service read.
  if v_candidate.category not in ('crm', 'crm_half_day', 'unpaid_vacation', 'insufficient_balance_vacation') then
    raise exception 'Only a CRM, CRM half-day, unpaid vacation or insufficient balance vacation deduction can be charged to the leave balance.'
      using errcode = '22023';
  end if;
  if lower(coalesce(v_candidate.employee_hr_id, '')) <> lower(p_employee_hr_id) then
    raise exception 'That deduction belongs to a different employee.' using errcode = '22023';
  end if;

  select coalesce(sum(days), 0) into v_already
  from public.attendance_annual_balance_charges
  where deduction_candidate_id = p_candidate_id;
  if v_already > 0.0005 then
    raise exception 'That deduction is already charged to the leave balance — reload and look again.' using errcode = '40001';
  end if;

  select coalesce(sum(paid_duration_days), 0) into v_request_days
  from public.v2_vacation_requests
  where lower(employee_hr_id) = lower(p_employee_hr_id)
    and status = 'approved'
    and vacation_type in ('annual', 'emergency')
    and start_date >= p_period_start
    and start_date <  p_period_end;

  select coalesce(sum(days), 0) into v_charge_days
  from public.attendance_annual_balance_charges
  where lower(employee_hr_id) = lower(p_employee_hr_id)
    and work_date >= p_period_start
    and work_date <  p_period_end;

  select coalesce(sum(balance_days_consumed), 0) into v_copilot_days
  from public.payroll_copilot_vacation_settlements
  where employee_hr_id_compact = regexp_replace(lower(p_employee_hr_id), '[^a-z0-9]+', '', 'g')
    and settlement_method in ('balance', 'partial_balance', 'defer_to_balance')
    and superseded_at is null
    and start_date >= p_period_start
    and start_date <  p_period_end;

  if round(v_request_days, 3) <> round(coalesce(p_seen_request_days, -1), 3)
     or round(v_charge_days, 3) <> round(coalesce(p_seen_charge_days, -1), 3)
     or round(v_copilot_days, 3) <> round(coalesce(p_seen_copilot_days, -1), 3) then
    raise exception 'The annual balance changed while this was being saved. Reload and try again.'
      using errcode = '40001';
  end if;

  insert into public.attendance_annual_balance_charges (
    source, deduction_candidate_id, employee_hr_id, work_date, days, period_start, period_end, created_by, comment
  ) values (
    'deductions', p_candidate_id, p_employee_hr_id, p_work_date, round(p_days, 3),
    p_period_start, p_period_end, p_actor_hr_id, btrim(p_comment)
  )
  returning id into v_id;

  return jsonb_build_object('chargeId', v_id, 'days', round(p_days, 3));
end;
$function$;

-- Restated, not newly needed: `create or replace` keeps the existing ACL, and the applied function on
-- production reads `postgres=X/postgres | service_role=X/postgres` with no PUBLIC entry. It is here
-- because `scripts/check-migrations.mjs` requires every migration that creates a public SECURITY
-- DEFINER function to carry its own revoke — anon and authenticated inherit EXECUTE through PUBLIC
-- membership, so a file that defines one and says nothing about grants is indistinguishable from one
-- that opened it up. Idempotent.
revoke execute on function public.phx_deductions_charge_leave_balance(uuid, text, date, numeric, text, text, date, date, numeric, numeric, numeric) from public, anon, authenticated;
grant execute on function public.phx_deductions_charge_leave_balance(uuid, text, date, numeric, text, text, date, date, numeric, numeric, numeric) to service_role;

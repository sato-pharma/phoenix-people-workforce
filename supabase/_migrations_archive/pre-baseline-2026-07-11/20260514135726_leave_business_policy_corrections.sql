-- Phoenix Workforce Leave Management business policy corrections.
-- Adds payment status metadata, AM/PM duration support, employee-facing type control,
-- and transactional cancellation.

begin;
alter table public.leave_types
  add column if not exists employee_selectable boolean not null default true;
alter table public.leave_requests
  add column if not exists balance_leave_type_id uuid null references public.leave_types(id) on update cascade on delete restrict,
  add column if not exists payment_status text not null default 'in_review',
  add column if not exists payment_reason text null,
  add column if not exists duration_unit text not null default 'full_day',
  add column if not exists hr_balance_decision text null;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'leave_requests_payment_status_check') then
    alter table public.leave_requests
      add constraint leave_requests_payment_status_check
      check (payment_status in ('paid', 'unpaid', 'in_review', 'non_deducted'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'leave_requests_duration_unit_check') then
    alter table public.leave_requests
      add constraint leave_requests_duration_unit_check
      check (duration_unit in ('full_day', 'am', 'pm'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'leave_requests_hr_balance_decision_check') then
    alter table public.leave_requests
      add constraint leave_requests_hr_balance_decision_check
      check (hr_balance_decision is null or hr_balance_decision in ('deduct', 'no_deduct'));
  end if;
end $$;
update public.leave_types
set employee_selectable = code in ('annual_leave', 'emergency_leave', 'sick_leave', 'other'),
    requires_attachment = case when code = 'sick_leave' then true else requires_attachment end,
    updated_at = now()
where code in ('annual_leave', 'emergency_leave', 'sick_leave', 'other', 'casual_leave', 'unpaid_leave');
update public.leave_requests lr
set balance_leave_type_id = case
      when lt.code in ('annual_leave', 'emergency_leave', 'other') then annual.id
      else lr.balance_leave_type_id
    end,
    payment_status = case
      when lr.payment_status <> 'in_review' then lr.payment_status
      when lt.code in ('annual_leave', 'emergency_leave') then 'paid'
      when lt.code = 'unpaid_leave' then 'unpaid'
      else 'in_review'
    end
from public.leave_types lt
cross join lateral (
  select id from public.leave_types where code = 'annual_leave' limit 1
) annual
where lr.leave_type_id = lt.id;
drop function if exists public.phx_leave_submit_request_atomic(
  text, uuid, uuid, date, date, numeric, numeric, text, text, text, text, text, text, boolean, boolean, jsonb, text, text, uuid
);
create or replace function public.phx_leave_submit_request_atomic(
  p_employee_hr_id text,
  p_leave_type_id uuid,
  p_policy_id uuid,
  p_start_date date,
  p_end_date date,
  p_total_calendar_days numeric,
  p_total_working_days numeric,
  p_reason text,
  p_attachment_url text,
  p_status text,
  p_manager_status text,
  p_hr_status text,
  p_payroll_status text,
  p_should_consume boolean,
  p_allow_negative_balance boolean,
  p_accruals jsonb,
  p_actor_hr_id text,
  p_actor_role text,
  p_balance_leave_type_id uuid default null,
  p_payment_status text default 'in_review',
  p_payment_reason text default null,
  p_duration_unit text default 'full_day',
  p_correlation_id uuid default gen_random_uuid()
)
returns public.leave_requests
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_request public.leave_requests;
  v_balance public.employee_leave_balances;
  v_entry record;
  v_notes text;
  v_exists uuid;
  v_balance_leave_type_id uuid;
begin
  if p_end_date < p_start_date then
    raise exception 'Invalid leave date range.';
  end if;
  if p_total_working_days <= 0 then
    raise exception 'The selected range contains no working leave days.';
  end if;
  if p_duration_unit not in ('full_day', 'am', 'pm') then
    raise exception 'Invalid duration selection.';
  end if;
  if p_duration_unit in ('am', 'pm') and p_start_date <> p_end_date then
    raise exception 'AM/PM leave is only allowed for single-day requests.';
  end if;
  if p_payment_status not in ('paid', 'unpaid', 'in_review', 'non_deducted') then
    raise exception 'Invalid leave payment status.';
  end if;

  v_balance_leave_type_id := p_balance_leave_type_id;

  if p_should_consume then
    if v_balance_leave_type_id is null then
      raise exception 'Balance leave type is required for deductible leave.';
    end if;

    v_balance := public.phx_leave_ensure_balance_atomic(
      p_employee_hr_id,
      v_balance_leave_type_id,
      p_policy_id,
      extract(year from p_start_date)::integer
    );

    for v_entry in
      select *
      from jsonb_to_recordset(coalesce(p_accruals, '[]'::jsonb))
        as accrual(period text, amount numeric, accrual_date date)
    loop
      v_notes := 'monthly-accrual:' || v_entry.period;
      select id into v_exists
      from public.leave_transactions
      where employee_hr_id = upper(trim(p_employee_hr_id))
        and leave_type_id = v_balance_leave_type_id
        and policy_id = p_policy_id
        and transaction_type = 'accrual'
        and notes = v_notes
      limit 1;

      if v_exists is null and coalesce(v_entry.amount, 0) > 0 then
        v_balance := public.phx_leave_record_delta_atomic(
          p_employee_hr_id,
          v_balance_leave_type_id,
          p_policy_id,
          extract(year from p_start_date)::integer,
          'accrual',
          v_entry.amount,
          null,
          v_notes,
          p_actor_hr_id
        );

        update public.employee_leave_balances
        set last_accrual_date = greatest(coalesce(last_accrual_date, v_entry.accrual_date), v_entry.accrual_date),
            updated_at = now()
        where id = v_balance.id
        returning * into v_balance;
      end if;
    end loop;

    if not p_allow_negative_balance and v_balance.available_balance < p_total_working_days then
      raise exception 'Insufficient leave balance. Available: % days.', v_balance.available_balance;
    end if;
  end if;

  insert into public.leave_requests (
    attachment_url,
    balance_leave_type_id,
    duration_unit,
    employee_hr_id,
    end_date,
    hr_status,
    leave_type_id,
    manager_status,
    payment_reason,
    payment_status,
    payroll_status,
    policy_id,
    reason,
    start_date,
    status,
    total_calendar_days,
    total_working_days
  )
  values (
    p_attachment_url,
    v_balance_leave_type_id,
    p_duration_unit,
    upper(trim(p_employee_hr_id)),
    p_end_date,
    p_hr_status,
    p_leave_type_id,
    p_manager_status,
    nullif(trim(coalesce(p_payment_reason, '')), ''),
    p_payment_status,
    p_payroll_status,
    p_policy_id,
    nullif(trim(coalesce(p_reason, '')), ''),
    p_start_date,
    p_status,
    p_total_calendar_days,
    p_total_working_days
  )
  returning * into v_request;

  if p_should_consume then
    perform public.phx_leave_record_delta_atomic(
      p_employee_hr_id,
      v_balance_leave_type_id,
      p_policy_id,
      extract(year from p_start_date)::integer,
      'pending',
      p_total_working_days,
      v_request.id,
      'Request submitted',
      p_actor_hr_id
    );
  end if;

  insert into public.leave_audit_logs (
    correlation_id,
    event_type,
    request_id,
    employee_hr_id,
    actor_hr_id,
    actor_role,
    metadata
  )
  values (
    coalesce(p_correlation_id, gen_random_uuid()),
    'leave.request.submitted',
    v_request.id,
    v_request.employee_hr_id,
    p_actor_hr_id,
    p_actor_role,
    jsonb_build_object(
      'status', v_request.status,
      'workingDays', p_total_working_days,
      'durationUnit', p_duration_unit,
      'paymentStatus', p_payment_status,
      'paymentReason', p_payment_reason,
      'balanceLeaveTypeId', v_balance_leave_type_id
    )
  );

  return v_request;
end;
$$;
create or replace function public.phx_leave_release_pending_atomic(
  p_request public.leave_requests,
  p_actor_hr_id text
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_balance_leave_type_id uuid;
  v_balance public.employee_leave_balances;
  v_exists uuid;
  v_amount numeric;
begin
  v_balance_leave_type_id := p_request.balance_leave_type_id;
  if v_balance_leave_type_id is null then
    return;
  end if;

  select id into v_exists
  from public.leave_transactions
  where request_id = p_request.id and transaction_type = 'pending_reversal'
  limit 1;
  if v_exists is not null then
    return;
  end if;

  v_balance := public.phx_leave_ensure_balance_atomic(
    p_request.employee_hr_id,
    v_balance_leave_type_id,
    p_request.policy_id,
    extract(year from p_request.start_date)::integer
  );

  if v_balance.pending <= 0 then
    return;
  end if;

  v_amount := least(v_balance.pending, p_request.total_working_days);
  perform public.phx_leave_record_delta_atomic(
    p_request.employee_hr_id,
    v_balance_leave_type_id,
    p_request.policy_id,
    extract(year from p_request.start_date)::integer,
    'pending_reversal',
    v_amount,
    p_request.id,
    'Pending request released',
    p_actor_hr_id
  );
end;
$$;
create or replace function public.phx_leave_consume_pending_atomic(
  p_request public.leave_requests,
  p_actor_hr_id text
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_balance_leave_type_id uuid;
  v_balance public.employee_leave_balances;
  v_exists uuid;
  v_amount numeric;
begin
  v_balance_leave_type_id := p_request.balance_leave_type_id;
  if v_balance_leave_type_id is null then
    return;
  end if;

  select id into v_exists
  from public.leave_transactions
  where request_id = p_request.id and transaction_type = 'consumed'
  limit 1;
  if v_exists is not null then
    return;
  end if;

  v_balance := public.phx_leave_ensure_balance_atomic(
    p_request.employee_hr_id,
    v_balance_leave_type_id,
    p_request.policy_id,
    extract(year from p_request.start_date)::integer
  );

  if v_balance.pending > 0 then
    v_amount := least(v_balance.pending, p_request.total_working_days);
    perform public.phx_leave_record_delta_atomic(
      p_request.employee_hr_id,
      v_balance_leave_type_id,
      p_request.policy_id,
      extract(year from p_request.start_date)::integer,
      'pending_reversal',
      v_amount,
      p_request.id,
      'Pending request approved',
      p_actor_hr_id
    );
  end if;

  perform public.phx_leave_record_delta_atomic(
    p_request.employee_hr_id,
    v_balance_leave_type_id,
    p_request.policy_id,
    extract(year from p_request.start_date)::integer,
    'consumed',
    p_request.total_working_days,
    p_request.id,
    'HR approved leave',
    p_actor_hr_id
  );
end;
$$;
drop function if exists public.phx_leave_hr_decision_atomic(uuid, text, text, text, text, uuid);
create or replace function public.phx_leave_hr_decision_atomic(
  p_request_id uuid,
  p_decision text,
  p_comment text,
  p_actor_hr_id text,
  p_actor_role text,
  p_balance_decision text default null,
  p_correlation_id uuid default gen_random_uuid()
)
returns public.leave_requests
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_request public.leave_requests;
  v_leave_type public.leave_types;
  v_next_payment_status text;
begin
  if p_decision not in ('approved', 'rejected') then
    raise exception 'Invalid HR decision.';
  end if;
  if p_balance_decision is not null and p_balance_decision not in ('deduct', 'no_deduct') then
    raise exception 'Invalid HR balance decision.';
  end if;
  if p_decision = 'rejected' and nullif(trim(coalesce(p_comment, '')), '') is null then
    raise exception 'A rejection comment is required.';
  end if;

  select * into v_request from public.leave_requests where id = p_request_id for update;
  if v_request.id is null then
    raise exception 'Leave request was not found.';
  end if;
  if v_request.status not in ('pending_hr', 'manager_approved') then
    raise exception 'This request is not pending HR approval.';
  end if;

  select * into v_leave_type from public.leave_types where id = v_request.leave_type_id;
  if p_decision = 'approved' and v_leave_type.code = 'other' and p_balance_decision is null then
    raise exception 'HR must choose whether Other leave deducts from balance.';
  end if;

  v_next_payment_status := case
    when p_decision = 'rejected' then v_request.payment_status
    when p_balance_decision = 'deduct' then 'paid'
    when p_balance_decision = 'no_deduct' then 'non_deducted'
    when v_request.payment_status = 'unpaid' then 'unpaid'
    when v_leave_type.code in ('sick_leave') then 'paid'
    else v_request.payment_status
  end;

  if p_decision = 'approved' and (p_balance_decision = 'deduct' or (v_request.payment_status = 'paid' and v_request.balance_leave_type_id is not null)) then
    perform public.phx_leave_consume_pending_atomic(v_request, p_actor_hr_id);
  elsif p_decision = 'rejected' then
    perform public.phx_leave_release_pending_atomic(v_request, p_actor_hr_id);
  end if;

  update public.leave_requests
  set hr_balance_decision = case when p_decision = 'approved' then p_balance_decision else hr_balance_decision end,
      hr_comment = nullif(trim(coalesce(p_comment, '')), ''),
      hr_decision_at = now(),
      hr_status = p_decision,
      payment_status = v_next_payment_status,
      payment_reason = case
        when p_decision = 'approved' and p_balance_decision = 'deduct' then 'HR approved deduction from annual leave balance'
        when p_decision = 'approved' and p_balance_decision = 'no_deduct' then 'HR approved without annual balance deduction'
        when p_decision = 'approved' and v_leave_type.code = 'sick_leave' then 'HR approved sick leave after document review'
        else payment_reason
      end,
      payroll_status = case
        when p_decision = 'approved' and coalesce(v_leave_type.affects_payroll, false) then 'pending'
        else payroll_status
      end,
      status = case when p_decision = 'approved' then 'hr_approved' else 'hr_rejected' end,
      updated_at = now()
  where id = p_request_id
  returning * into v_request;

  insert into public.leave_approvals (
    request_id,
    approver_hr_id,
    approver_role,
    approval_step,
    status,
    comment
  )
  values (
    p_request_id,
    upper(trim(coalesce(p_actor_hr_id, ''))),
    coalesce(p_actor_role, 'HR Specialist'),
    'hr',
    p_decision,
    nullif(trim(concat_ws(
      ' | ',
      nullif(trim(coalesce(p_comment, '')), ''),
      case when p_balance_decision is null then null else 'Balance decision: ' || p_balance_decision end
    )), '')
  );

  insert into public.leave_audit_logs (
    correlation_id,
    event_type,
    request_id,
    employee_hr_id,
    actor_hr_id,
    actor_role,
    metadata
  )
  values (
    coalesce(p_correlation_id, gen_random_uuid()),
    'leave.hr.' || p_decision,
    v_request.id,
    v_request.employee_hr_id,
    p_actor_hr_id,
    p_actor_role,
    jsonb_build_object(
      'status', v_request.status,
      'payrollStatus', v_request.payroll_status,
      'paymentStatus', v_request.payment_status,
      'balanceDecision', p_balance_decision
    )
  );

  return v_request;
end;
$$;
create or replace function public.phx_leave_cancel_request_atomic(
  p_request_id uuid,
  p_comment text,
  p_actor_hr_id text,
  p_actor_role text,
  p_correlation_id uuid default gen_random_uuid()
)
returns public.leave_requests
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_request public.leave_requests;
  v_existing_approval uuid;
begin
  select * into v_request from public.leave_requests where id = p_request_id for update;
  if v_request.id is null then
    raise exception 'Leave request was not found.';
  end if;

  if v_request.status = 'cancelled' then
    return v_request;
  end if;

  perform public.phx_leave_release_pending_atomic(v_request, p_actor_hr_id);

  update public.leave_requests
  set hr_comment = coalesce(nullif(trim(coalesce(p_comment, '')), ''), hr_comment),
      status = 'cancelled',
      updated_at = now()
  where id = p_request_id
  returning * into v_request;

  select id into v_existing_approval
  from public.leave_approvals
  where request_id = p_request_id and approval_step = 'system' and status = 'cancelled'
  limit 1;

  if v_existing_approval is null then
    insert into public.leave_approvals (
      request_id,
      approver_hr_id,
      approver_role,
      approval_step,
      status,
      comment
    )
    values (
      p_request_id,
      upper(trim(coalesce(p_actor_hr_id, 'SYSTEM'))),
      coalesce(p_actor_role, 'system'),
      'system',
      'cancelled',
      coalesce(nullif(trim(coalesce(p_comment, '')), ''), 'Request cancelled')
    );
  end if;

  insert into public.leave_audit_logs (
    correlation_id,
    event_type,
    request_id,
    employee_hr_id,
    actor_hr_id,
    actor_role,
    metadata
  )
  values (
    coalesce(p_correlation_id, gen_random_uuid()),
    'leave.request.cancelled',
    v_request.id,
    v_request.employee_hr_id,
    p_actor_hr_id,
    p_actor_role,
    jsonb_build_object('status', v_request.status, 'comment', p_comment, 'paymentStatus', v_request.payment_status)
  );

  return v_request;
end;
$$;
revoke all on function public.phx_leave_submit_request_atomic(text, uuid, uuid, date, date, numeric, numeric, text, text, text, text, text, text, boolean, boolean, jsonb, text, text, uuid, text, text, text, uuid) from public, anon, authenticated;
revoke all on function public.phx_leave_hr_decision_atomic(uuid, text, text, text, text, text, uuid) from public, anon, authenticated;
revoke all on function public.phx_leave_cancel_request_atomic(uuid, text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.phx_leave_submit_request_atomic(text, uuid, uuid, date, date, numeric, numeric, text, text, text, text, text, text, boolean, boolean, jsonb, text, text, uuid, text, text, text, uuid) to service_role;
grant execute on function public.phx_leave_hr_decision_atomic(uuid, text, text, text, text, text, uuid) to service_role;
grant execute on function public.phx_leave_cancel_request_atomic(uuid, text, text, text, uuid) to service_role;
commit;

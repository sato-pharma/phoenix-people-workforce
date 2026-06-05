-- Phoenix Workforce Leave Management production readiness hardening.
-- Adds service-role-only transactional RPCs, audit logs, accrual logs, and private storage preparation.

begin;
create extension if not exists pgcrypto;
create table if not exists public.leave_audit_logs (
  id uuid primary key default gen_random_uuid(),
  correlation_id uuid not null default gen_random_uuid(),
  event_type text not null,
  request_id uuid null references public.leave_requests(id) on update cascade on delete set null,
  employee_hr_id text null references public.employees(hr_id) on update cascade on delete set null,
  actor_hr_id text null,
  actor_role text null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create table if not exists public.leave_accrual_runs (
  id uuid primary key default gen_random_uuid(),
  correlation_id uuid not null default gen_random_uuid(),
  period text not null,
  year integer not null,
  month integer not null,
  status text not null default 'completed',
  dry_run boolean not null default false,
  actor_hr_id text null,
  processed_count integer not null default 0,
  skipped_count integer not null default 0,
  total_amount numeric(10, 2) not null default 0,
  error_message text null,
  metadata jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  completed_at timestamptz null,
  created_at timestamptz not null default now(),
  constraint leave_accrual_runs_status_check check (status in ('completed', 'failed')),
  constraint leave_accrual_runs_month_check check (month between 1 and 12)
);
create table if not exists public.leave_attachment_objects (
  id uuid primary key default gen_random_uuid(),
  request_id uuid null references public.leave_requests(id) on update cascade on delete set null,
  employee_hr_id text not null references public.employees(hr_id) on update cascade on delete cascade,
  storage_mode text not null default 'local',
  bucket text null,
  object_path text null,
  public_url text null,
  original_name text null,
  content_type text null,
  size_bytes bigint null,
  checksum text null,
  uploaded_by_hr_id text null,
  deleted_at timestamptz null,
  created_at timestamptz not null default now(),
  constraint leave_attachment_objects_mode_check check (storage_mode in ('local', 'supabase'))
);
create index if not exists leave_audit_logs_created_idx on public.leave_audit_logs (created_at desc);
create index if not exists leave_audit_logs_correlation_idx on public.leave_audit_logs (correlation_id, created_at);
create index if not exists leave_audit_logs_request_idx on public.leave_audit_logs (request_id, created_at);
create index if not exists leave_accrual_runs_period_idx on public.leave_accrual_runs (period, created_at desc);
create index if not exists leave_attachment_objects_request_idx on public.leave_attachment_objects (request_id);
create index if not exists leave_attachment_objects_employee_idx on public.leave_attachment_objects (employee_hr_id, created_at desc);
create index if not exists leave_requests_status_dates_idx on public.leave_requests (status, start_date, end_date);
create index if not exists leave_requests_lineup_idx on public.leave_requests (leave_type_id, policy_id, employee_hr_id, status);
create index if not exists leave_transactions_type_notes_idx on public.leave_transactions (transaction_type, notes, created_at desc);
alter table public.leave_audit_logs enable row level security;
alter table public.leave_accrual_runs enable row level security;
alter table public.leave_attachment_objects enable row level security;
revoke all on public.leave_audit_logs from anon, authenticated;
revoke all on public.leave_accrual_runs from anon, authenticated;
revoke all on public.leave_attachment_objects from anon, authenticated;
grant select on public.leave_audit_logs, public.leave_accrual_runs, public.leave_attachment_objects to authenticated;
grant all on public.leave_audit_logs, public.leave_accrual_runs, public.leave_attachment_objects to service_role;
drop policy if exists leave_audit_logs_service_role on public.leave_audit_logs;
create policy leave_audit_logs_service_role
  on public.leave_audit_logs for all to service_role using (true) with check (true);
drop policy if exists leave_audit_logs_manage_select on public.leave_audit_logs;
create policy leave_audit_logs_manage_select
  on public.leave_audit_logs for select to authenticated using (private.phx_can_manage_leave());
drop policy if exists leave_accrual_runs_service_role on public.leave_accrual_runs;
create policy leave_accrual_runs_service_role
  on public.leave_accrual_runs for all to service_role using (true) with check (true);
drop policy if exists leave_accrual_runs_manage_select on public.leave_accrual_runs;
create policy leave_accrual_runs_manage_select
  on public.leave_accrual_runs for select to authenticated using (private.phx_can_manage_leave());
drop policy if exists leave_attachment_objects_service_role on public.leave_attachment_objects;
create policy leave_attachment_objects_service_role
  on public.leave_attachment_objects for all to service_role using (true) with check (true);
drop policy if exists leave_attachment_objects_select_access on public.leave_attachment_objects;
create policy leave_attachment_objects_select_access
  on public.leave_attachment_objects for select to authenticated
  using (private.phx_can_manage_leave() or private.phx_can_access_employee(employee_hr_id));
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values (
      'leave-attachments',
      'leave-attachments',
      false,
      10485760,
      array[
        'application/pdf',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'image/jpeg',
        'image/png',
        'image/webp'
      ]
    )
    on conflict (id) do update
    set public = false,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;
  end if;

  if to_regclass('storage.objects') is not null then
    execute 'drop policy if exists leave_attachments_service_role on storage.objects';
    execute $policy$
      create policy leave_attachments_service_role
      on storage.objects
      for all
      to service_role
      using (bucket_id = 'leave-attachments')
      with check (bucket_id = 'leave-attachments')
    $policy$;
  end if;
end $$;
create or replace function public.phx_leave_available(
  p_opening numeric,
  p_accrued numeric,
  p_adjusted numeric,
  p_carry_forward numeric,
  p_consumed numeric,
  p_pending numeric
)
returns numeric
language sql
immutable
as $$
  select round((
    coalesce(p_opening, 0)
    + coalesce(p_accrued, 0)
    + coalesce(p_adjusted, 0)
    + coalesce(p_carry_forward, 0)
    - coalesce(p_consumed, 0)
    - coalesce(p_pending, 0)
  )::numeric, 2);
$$;
create or replace function public.phx_leave_ensure_balance_atomic(
  p_employee_hr_id text,
  p_leave_type_id uuid,
  p_policy_id uuid,
  p_year integer
)
returns public.employee_leave_balances
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_balance public.employee_leave_balances;
begin
  insert into public.employee_leave_balances (
    employee_hr_id,
    leave_type_id,
    policy_id,
    year,
    available_balance
  )
  values (
    upper(trim(p_employee_hr_id)),
    p_leave_type_id,
    p_policy_id,
    p_year,
    0
  )
  on conflict (employee_hr_id, leave_type_id, policy_id, year) do nothing;

  select *
    into v_balance
  from public.employee_leave_balances
  where employee_hr_id = upper(trim(p_employee_hr_id))
    and leave_type_id = p_leave_type_id
    and policy_id = p_policy_id
    and year = p_year
  for update;

  if v_balance.id is null then
    raise exception 'Leave balance could not be created or locked.';
  end if;

  return v_balance;
end;
$$;
create or replace function public.phx_leave_record_delta_atomic(
  p_employee_hr_id text,
  p_leave_type_id uuid,
  p_policy_id uuid,
  p_year integer,
  p_transaction_type text,
  p_amount numeric,
  p_request_id uuid,
  p_notes text,
  p_created_by text
)
returns public.employee_leave_balances
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_balance public.employee_leave_balances;
  v_next_opening numeric;
  v_next_accrued numeric;
  v_next_consumed numeric;
  v_next_pending numeric;
  v_next_adjusted numeric;
  v_next_carry_forward numeric;
  v_next_available numeric;
begin
  v_balance := public.phx_leave_ensure_balance_atomic(p_employee_hr_id, p_leave_type_id, p_policy_id, p_year);

  v_next_opening := v_balance.opening_balance;
  v_next_accrued := v_balance.accrued;
  v_next_consumed := v_balance.consumed;
  v_next_pending := v_balance.pending;
  v_next_adjusted := v_balance.adjusted;
  v_next_carry_forward := v_balance.carry_forward;

  if p_transaction_type = 'opening_balance' then v_next_opening := v_next_opening + p_amount; end if;
  if p_transaction_type = 'accrual' then v_next_accrued := v_next_accrued + p_amount; end if;
  if p_transaction_type = 'carry_forward' then v_next_carry_forward := v_next_carry_forward + p_amount; end if;
  if p_transaction_type = 'adjustment' then v_next_adjusted := v_next_adjusted + p_amount; end if;
  if p_transaction_type = 'pending' then v_next_pending := v_next_pending + p_amount; end if;
  if p_transaction_type = 'pending_reversal' then v_next_pending := greatest(0, v_next_pending - p_amount); end if;
  if p_transaction_type = 'consumed' then v_next_consumed := v_next_consumed + p_amount; end if;
  if p_transaction_type = 'consumed_reversal' then v_next_consumed := greatest(0, v_next_consumed - p_amount); end if;

  v_next_available := public.phx_leave_available(
    v_next_opening,
    v_next_accrued,
    v_next_adjusted,
    v_next_carry_forward,
    v_next_consumed,
    v_next_pending
  );

  insert into public.leave_transactions (
    employee_hr_id,
    leave_type_id,
    policy_id,
    request_id,
    transaction_type,
    amount,
    balance_before,
    balance_after,
    notes,
    created_by
  )
  values (
    upper(trim(p_employee_hr_id)),
    p_leave_type_id,
    p_policy_id,
    p_request_id,
    p_transaction_type,
    p_amount,
    v_balance.available_balance,
    v_next_available,
    p_notes,
    p_created_by
  );

  update public.employee_leave_balances
  set opening_balance = v_next_opening,
      accrued = v_next_accrued,
      consumed = v_next_consumed,
      pending = v_next_pending,
      adjusted = v_next_adjusted,
      carry_forward = v_next_carry_forward,
      available_balance = v_next_available,
      updated_at = now()
  where id = v_balance.id
  returning * into v_balance;

  return v_balance;
end;
$$;
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
begin
  if p_end_date < p_start_date then
    raise exception 'Invalid leave date range.';
  end if;
  if p_total_working_days <= 0 then
    raise exception 'The selected range contains no working leave days.';
  end if;

  if p_should_consume then
    v_balance := public.phx_leave_ensure_balance_atomic(
      p_employee_hr_id,
      p_leave_type_id,
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
        and leave_type_id = p_leave_type_id
        and policy_id = p_policy_id
        and transaction_type = 'accrual'
        and notes = v_notes
      limit 1;

      if v_exists is null and coalesce(v_entry.amount, 0) > 0 then
        v_balance := public.phx_leave_record_delta_atomic(
          p_employee_hr_id,
          p_leave_type_id,
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
    employee_hr_id,
    end_date,
    hr_status,
    leave_type_id,
    manager_status,
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
    upper(trim(p_employee_hr_id)),
    p_end_date,
    p_hr_status,
    p_leave_type_id,
    p_manager_status,
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
      p_leave_type_id,
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
    jsonb_build_object('status', v_request.status, 'workingDays', p_total_working_days)
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
  v_type_code text;
  v_balance public.employee_leave_balances;
  v_exists uuid;
  v_amount numeric;
begin
  select code into v_type_code from public.leave_types where id = p_request.leave_type_id;
  if v_type_code is distinct from 'annual_leave' then
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
    p_request.leave_type_id,
    p_request.policy_id,
    extract(year from p_request.start_date)::integer
  );

  if v_balance.pending <= 0 then
    return;
  end if;

  v_amount := least(v_balance.pending, p_request.total_working_days);
  perform public.phx_leave_record_delta_atomic(
    p_request.employee_hr_id,
    p_request.leave_type_id,
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
  v_type_code text;
  v_balance public.employee_leave_balances;
  v_exists uuid;
  v_amount numeric;
begin
  select code into v_type_code from public.leave_types where id = p_request.leave_type_id;
  if v_type_code is distinct from 'annual_leave' then
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
    p_request.leave_type_id,
    p_request.policy_id,
    extract(year from p_request.start_date)::integer
  );

  if v_balance.pending > 0 then
    v_amount := least(v_balance.pending, p_request.total_working_days);
    perform public.phx_leave_record_delta_atomic(
      p_request.employee_hr_id,
      p_request.leave_type_id,
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
    p_request.leave_type_id,
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
create or replace function public.phx_leave_manager_decision_atomic(
  p_request_id uuid,
  p_decision text,
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
  v_status text;
begin
  if p_decision not in ('approved', 'rejected') then
    raise exception 'Invalid manager decision.';
  end if;
  if p_decision = 'rejected' and nullif(trim(coalesce(p_comment, '')), '') is null then
    raise exception 'A rejection comment is required.';
  end if;

  select * into v_request from public.leave_requests where id = p_request_id for update;
  if v_request.id is null then
    raise exception 'Leave request was not found.';
  end if;
  if v_request.status <> 'pending_manager' then
    raise exception 'This request is not pending manager approval.';
  end if;

  v_status := case when p_decision = 'approved' then 'pending_hr' else 'manager_rejected' end;

  update public.leave_requests
  set manager_comment = nullif(trim(coalesce(p_comment, '')), ''),
      manager_decision_at = now(),
      manager_status = p_decision,
      status = v_status,
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
    coalesce(p_actor_role, 'Manager'),
    'manager',
    p_decision,
    nullif(trim(coalesce(p_comment, '')), '')
  );

  if p_decision = 'rejected' then
    perform public.phx_leave_release_pending_atomic(v_request, p_actor_hr_id);
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
    'leave.manager.' || p_decision,
    v_request.id,
    v_request.employee_hr_id,
    p_actor_hr_id,
    p_actor_role,
    jsonb_build_object('status', v_request.status)
  );

  return v_request;
end;
$$;
create or replace function public.phx_leave_hr_decision_atomic(
  p_request_id uuid,
  p_decision text,
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
  v_leave_type public.leave_types;
begin
  if p_decision not in ('approved', 'rejected') then
    raise exception 'Invalid HR decision.';
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

  if p_decision = 'approved' then
    perform public.phx_leave_consume_pending_atomic(v_request, p_actor_hr_id);
  else
    perform public.phx_leave_release_pending_atomic(v_request, p_actor_hr_id);
  end if;

  select * into v_leave_type from public.leave_types where id = v_request.leave_type_id;

  update public.leave_requests
  set hr_comment = nullif(trim(coalesce(p_comment, '')), ''),
      hr_decision_at = now(),
      hr_status = p_decision,
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
    nullif(trim(coalesce(p_comment, '')), '')
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
    jsonb_build_object('status', v_request.status, 'payrollStatus', v_request.payroll_status)
  );

  return v_request;
end;
$$;
create or replace function public.phx_leave_adjust_balance_atomic(
  p_employee_hr_id text,
  p_leave_type_id uuid,
  p_policy_id uuid,
  p_year integer,
  p_amount numeric,
  p_reason text,
  p_actor_hr_id text,
  p_actor_role text,
  p_correlation_id uuid default gen_random_uuid()
)
returns public.employee_leave_balances
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_balance public.employee_leave_balances;
begin
  if coalesce(p_amount, 0) = 0 then
    raise exception 'Adjustment amount must be a non-zero number.';
  end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'Manual adjustment reason is required.';
  end if;

  v_balance := public.phx_leave_record_delta_atomic(
    p_employee_hr_id,
    p_leave_type_id,
    p_policy_id,
    p_year,
    'adjustment',
    p_amount,
    null,
    p_reason,
    p_actor_hr_id
  );

  insert into public.leave_audit_logs (
    correlation_id,
    event_type,
    employee_hr_id,
    actor_hr_id,
    actor_role,
    metadata
  )
  values (
    coalesce(p_correlation_id, gen_random_uuid()),
    'leave.balance.adjusted',
    upper(trim(p_employee_hr_id)),
    p_actor_hr_id,
    p_actor_role,
    jsonb_build_object('amount', p_amount, 'reason', p_reason, 'availableBalance', v_balance.available_balance)
  );

  return v_balance;
end;
$$;
create or replace function public.phx_leave_run_accrual_atomic(
  p_leave_type_id uuid,
  p_policy_id uuid,
  p_year integer,
  p_month integer,
  p_entries jsonb,
  p_actor_hr_id text,
  p_actor_role text,
  p_correlation_id uuid default gen_random_uuid()
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_entry record;
  v_period text := p_year::text || '-' || lpad(p_month::text, 2, '0');
  v_notes text := 'monthly-accrual:' || p_year::text || '-' || lpad(p_month::text, 2, '0');
  v_processed integer := 0;
  v_skipped integer := 0;
  v_total numeric := 0;
  v_exists uuid;
  v_balance public.employee_leave_balances;
begin
  if p_month < 1 or p_month > 12 then
    raise exception 'Invalid accrual month.';
  end if;

  for v_entry in
    select *
    from jsonb_to_recordset(coalesce(p_entries, '[]'::jsonb))
      as entry(employee_hr_id text, amount numeric, accrual_date date, period text)
  loop
    if coalesce(v_entry.amount, 0) <= 0 then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    v_notes := 'monthly-accrual:' || coalesce(v_entry.period, v_period);

    select id into v_exists
    from public.leave_transactions
    where employee_hr_id = upper(trim(v_entry.employee_hr_id))
      and leave_type_id = p_leave_type_id
      and policy_id = p_policy_id
      and transaction_type = 'accrual'
      and notes = v_notes
    limit 1;

    if v_exists is not null then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    v_balance := public.phx_leave_record_delta_atomic(
      v_entry.employee_hr_id,
      p_leave_type_id,
      p_policy_id,
      p_year,
      'accrual',
      v_entry.amount,
      null,
      v_notes,
      p_actor_hr_id
    );

    update public.employee_leave_balances
    set last_accrual_date = greatest(coalesce(last_accrual_date, v_entry.accrual_date), v_entry.accrual_date),
        updated_at = now()
    where id = v_balance.id;

    v_processed := v_processed + 1;
    v_total := v_total + v_entry.amount;
  end loop;

  insert into public.leave_accrual_runs (
    correlation_id,
    period,
    year,
    month,
    status,
    dry_run,
    actor_hr_id,
    processed_count,
    skipped_count,
    total_amount,
    completed_at,
    metadata
  )
  values (
    coalesce(p_correlation_id, gen_random_uuid()),
    v_period,
    p_year,
    p_month,
    'completed',
    false,
    p_actor_hr_id,
    v_processed,
    v_skipped,
    v_total,
    now(),
    jsonb_build_object('entryCount', coalesce(jsonb_array_length(p_entries), 0))
  );

  insert into public.leave_audit_logs (
    correlation_id,
    event_type,
    actor_hr_id,
    actor_role,
    metadata
  )
  values (
    coalesce(p_correlation_id, gen_random_uuid()),
    'leave.accrual.completed',
    p_actor_hr_id,
    p_actor_role,
    jsonb_build_object('period', v_period, 'processed', v_processed, 'skipped', v_skipped, 'totalAmount', v_total)
  );

  return jsonb_build_object(
    'period', v_period,
    'month', p_month,
    'year', p_year,
    'processed', v_processed,
    'skipped', v_skipped,
    'totalAmount', v_total
  );
end;
$$;
revoke all on function public.phx_leave_available(numeric, numeric, numeric, numeric, numeric, numeric) from public, anon, authenticated;
revoke all on function public.phx_leave_ensure_balance_atomic(text, uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.phx_leave_record_delta_atomic(text, uuid, uuid, integer, text, numeric, uuid, text, text) from public, anon, authenticated;
revoke all on function public.phx_leave_submit_request_atomic(text, uuid, uuid, date, date, numeric, numeric, text, text, text, text, text, text, boolean, boolean, jsonb, text, text, uuid) from public, anon, authenticated;
revoke all on function public.phx_leave_release_pending_atomic(public.leave_requests, text) from public, anon, authenticated;
revoke all on function public.phx_leave_consume_pending_atomic(public.leave_requests, text) from public, anon, authenticated;
revoke all on function public.phx_leave_manager_decision_atomic(uuid, text, text, text, text, uuid) from public, anon, authenticated;
revoke all on function public.phx_leave_hr_decision_atomic(uuid, text, text, text, text, uuid) from public, anon, authenticated;
revoke all on function public.phx_leave_adjust_balance_atomic(text, uuid, uuid, integer, numeric, text, text, text, uuid) from public, anon, authenticated;
revoke all on function public.phx_leave_run_accrual_atomic(uuid, uuid, integer, integer, jsonb, text, text, uuid) from public, anon, authenticated;
grant execute on function public.phx_leave_available(numeric, numeric, numeric, numeric, numeric, numeric) to service_role;
grant execute on function public.phx_leave_ensure_balance_atomic(text, uuid, uuid, integer) to service_role;
grant execute on function public.phx_leave_record_delta_atomic(text, uuid, uuid, integer, text, numeric, uuid, text, text) to service_role;
grant execute on function public.phx_leave_submit_request_atomic(text, uuid, uuid, date, date, numeric, numeric, text, text, text, text, text, text, boolean, boolean, jsonb, text, text, uuid) to service_role;
grant execute on function public.phx_leave_release_pending_atomic(public.leave_requests, text) to service_role;
grant execute on function public.phx_leave_consume_pending_atomic(public.leave_requests, text) to service_role;
grant execute on function public.phx_leave_manager_decision_atomic(uuid, text, text, text, text, uuid) to service_role;
grant execute on function public.phx_leave_hr_decision_atomic(uuid, text, text, text, text, uuid) to service_role;
grant execute on function public.phx_leave_adjust_balance_atomic(text, uuid, uuid, integer, numeric, text, text, text, uuid) to service_role;
grant execute on function public.phx_leave_run_accrual_atomic(uuid, uuid, integer, integer, jsonb, text, text, uuid) to service_role;
commit;

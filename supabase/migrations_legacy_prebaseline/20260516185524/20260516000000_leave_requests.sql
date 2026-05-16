-- Leave requests persistence table for Vacation Management.
-- Source of truth moved from client localStorage to Supabase.

create table if not exists public.leave_requests (
  id text primary key,
  employee_hr_id text,
  employee_name text not null,
  direct_manager_hr_id text,
  manager_of_manager_hr_id text,
  vacation_type text not null,
  day_type text not null,
  start_date date not null,
  end_date date not null,
  duration_days numeric(10, 2) not null default 0,
  paid_status text not null default 'Unpaid',
  available_balance_at_submission numeric(10, 2) not null default 0,
  first_year_entitlement_at_submission numeric(10, 2) not null default 0,
  current_annual_entitlement_at_submission numeric(10, 2) not null default 0,
  used_paid_leave_at_submission numeric(10, 2) not null default 0,
  remaining_paid_balance_at_submission numeric(10, 2) not null default 0,
  unpaid_leave_days_at_submission numeric(10, 2) not null default 0,
  pending_leave_impact_at_submission numeric(10, 2) not null default 0,
  status text not null default 'Pending',
  rejection_reason text not null default '',
  approved_or_rejected_by text,
  approved_or_rejected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  submitted_at timestamptz not null default now(),
  total_days numeric(10, 2) not null default 0,
  half_day_impact numeric(10, 2) not null default 0,
  total_entitled_balance_at_submission numeric(10, 2) not null default 0,
  employee_area text,
  employee_line text,
  employee_team text,
  employee_email text,
  employee_hire_date date,
  employee_id text,
  reason text not null default '',
  direct_manager text,
  direct_manager_email text,
  approval_status_date timestamptz,
  request_type text,
  team text,
  idempotency_key text
);

alter table public.leave_requests
  add column if not exists manager_of_manager_hr_id text;

alter table public.leave_requests
  add column if not exists approval_status_date timestamptz;

create index if not exists leave_requests_employee_hr_id_idx
  on public.leave_requests (employee_hr_id);

create index if not exists leave_requests_created_at_idx
  on public.leave_requests (created_at desc);

create index if not exists leave_requests_status_idx
  on public.leave_requests (status);
